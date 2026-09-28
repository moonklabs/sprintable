#!/usr/bin/env python3
"""story #4234 — Cloud Scheduler 작업을 레포 정의(`infra/cloud-scheduler/jobs.json`)와 맞춘다.

배경: dev 스케줄러 작업은 손으로 만든 것이라 레포에 정의가 없었고, 그래서 cron 라우트(`workflow-sla` ·
`workflow-handoff-watchdog`)가 생겨도 작업이 안 만들어진 것을 아무도 몰랐다. 이제 정의는 레포가 원천이고,
배포(cloudbuild.yaml `apply-cloud-scheduler`, dev만)가 이 스크립트로 실물을 정의에 맞춘다.

동작:
- 정의의 작업마다 실물(`gcloud scheduler jobs list`)과 비교 → 없으면 create, 다르면 update, 같으면 그대로.
- 정의에 없는데 같은 env 접미사(`-dev`)를 단 실물 작업은 **보고만 하고 지우지 않는다**.
- `Authorization: Bearer …` 값은 레포에 두지 않는다. 실물 백엔드 서비스(`sprintable-backend-<env>`)의
  `CRON_SECRET` secretKeyRef를 describe로 읽어 그 시크릿 버전으로 만든다 — 백엔드 `verify_cron`이 비교하는 바로
  그 값. secretKeyRef가 아니거나 없으면 실패로 끝낸다(평문 값·무인증 작업 경로 없음). 값은 어떤 출력에도 찍지 않는다.
- 기본은 dry-run(바꿀 목록만 출력). `--apply`일 때만 바꾸고, 바꾼 뒤 다시 읽어 차이 0인지 확인한다.
- 어떤 단계든 실패하면 0이 아닌 코드로 끝난다(빌드를 실패시킨다 — 삼키지 않는다).

표준 라이브러리만 쓴다(Cloud Build의 cloud-sdk 이미지에서 그대로 돈다).

    python3 infra/apply_cloud_scheduler.py --env dev            # dry-run
    python3 infra/apply_cloud_scheduler.py --env dev --apply    # 적용
"""
from __future__ import annotations

import argparse
import json
import re
import subprocess
import sys
from dataclasses import dataclass, field
from pathlib import Path
from typing import Callable

MANIFEST_PATH = Path(__file__).resolve().parent / "cloud-scheduler" / "jobs.json"
AUTH_HEADER = "Authorization"

Runner = Callable[[list[str]], str]


# 가려야 할 값(적용 중 읽은 시크릿). `resolve_bearer`가 등록한다.
_SECRETS: set[str] = set()


def _mask(text: str) -> str:
    """시크릿 값과 `Authorization=Bearer …` 헤더 인자의 값을 가린다(값을 모르는 경로도 헤더 모양으로 잡는다)."""
    for secret in _SECRETS:
        text = text.replace(secret, "***")
    return re.sub(r"(Authorization=Bearer )[^,\s]+", r"\1***", text)


class GcloudError(RuntimeError):
    """gcloud 실패 — 메시지는 가린 명령·stderr만 담는다."""


def _gcloud(args: list[str]) -> str:
    """gcloud 한 번 실행 · stdout 반환.

    실패하면 `CalledProcessError`를 그대로 올리지 않는다 — 그 메시지는 argv 전체(`--headers=Authorization=Bearer <값>`)를
    담아 빌드 로그에 시크릿을 찍는다(PO 4590 CHANGES①). 가린 명령과 가린 stderr로 `GcloudError`를 올리고, 원래 예외
    연쇄도 끊는다(`from None` — 트레이스백에 원래 argv가 다시 나오지 않게). stderr도 여기서 받아 가린 뒤에만 내보낸다."""
    try:
        result = subprocess.run(["gcloud", *args], check=True, capture_output=True, text=True)
    except subprocess.CalledProcessError as exc:
        command = _mask(" ".join(["gcloud", *args]))
        stderr = _mask(exc.stderr or "").strip()
        raise GcloudError(f"gcloud 실패(exit {exc.returncode}): {command}\n{stderr}") from None
    if result.stderr:
        print(_mask(result.stderr), end="", file=sys.stderr)
    return result.stdout


def load_manifest(path: Path = MANIFEST_PATH) -> dict:
    return json.loads(path.read_text(encoding="utf-8"))


@dataclass(frozen=True)
class DesiredJob:
    name: str
    schedule: str
    time_zone: str
    uri: str
    http_method: str
    headers: dict[str, str]
    attempt_deadline: str
    retry: dict[str, str | int]


def desired_jobs(manifest: dict, env: str, bearer: str, *, base_url: str) -> list[DesiredJob]:
    """정의 → 원하는 작업 목록. `bearer`는 필수 — Authorization 없는 작업을 만드는 경로는 없다. `base_url`은 실물 백엔드
    서비스의 `status.url`(정의 파일에 호스트를 박지 않는다 — 서비스 URL이 바뀌어도 어긋나지 않게)."""
    if not bearer:
        raise ValueError("bearer 필수 — 인증 없는 스케줄러 작업은 만들지 않는다")
    defaults = manifest["defaults"]
    out = []
    for job in manifest["jobs"]:
        headers = dict(defaults["headers"])
        headers.update(job.get("headers", {}))
        headers[AUTH_HEADER] = f"Bearer {bearer}"
        out.append(DesiredJob(
            name=f"{job['name']}-{env}",
            schedule=job["schedule"],
            time_zone=job["time_zone"],
            uri=f"{base_url.rstrip('/')}{manifest['route_prefix']}{job['route']}",
            http_method=job["method"],
            headers=headers,
            attempt_deadline=job.get("attempt_deadline", defaults["attempt_deadline"]),
            retry={**defaults["retry"], **job.get("retry", {})},
        ))
    return out


def _short_name(full: str) -> str:
    return full.rsplit("/", 1)[-1]


def _live_view(live: dict) -> dict:
    """실물 작업에서 비교할 필드만. API 표기(camelCase)를 정의 표기로."""
    target = live.get("httpTarget", {})
    retry = live.get("retryConfig", {})
    return {
        "schedule": live.get("schedule"),
        "time_zone": live.get("timeZone"),
        "uri": target.get("uri"),
        "http_method": target.get("httpMethod"),
        "headers": dict(target.get("headers", {})),
        "attempt_deadline": live.get("attemptDeadline"),
        "retry": {
            "max_retry_attempts": int(retry.get("retryCount", 0) or 0),
            "min_backoff": retry.get("minBackoffDuration"),
            "max_backoff": retry.get("maxBackoffDuration"),
            "max_doublings": int(retry.get("maxDoublings", 0) or 0),
            "max_retry_duration": retry.get("maxRetryDuration"),
        },
    }


def extra_headers(desired: DesiredJob, live: dict) -> list[str]:
    """실물에만 있는 헤더 이름(정의에 없음) — update 때 `--remove-headers`로 지운다."""
    return sorted(name for name in _live_view(live)["headers"] if name not in desired.headers)


def diff_job(desired: DesiredJob, live: dict) -> list[str]:
    """다른 필드 이름 목록. 헤더는 값까지 비교한다 — 목록 API는 헤더 값을 돌려준다(PO 실측 · 18개 모두 값 있음). 실물의
    Authorization이 비었거나 없으면 **차이**다(인증 없는 작업을 «같음»으로 두지 않는다 — 까디르 4590 P2)."""
    view = _live_view(live)
    changed = []
    for key in ("schedule", "time_zone", "uri", "http_method", "attempt_deadline"):
        if view[key] != getattr(desired, key):
            changed.append(key)
    live_headers = view["headers"]
    for name, value in desired.headers.items():
        if live_headers.get(name) != value:
            changed.append(f"headers.{name}")
    changed.extend(f"headers.{name}" for name in extra_headers(desired, live))
    for key, value in desired.retry.items():
        if view["retry"].get(key) != value:
            changed.append(f"retry.{key}")
    return changed


@dataclass
class Plan:
    create: list[DesiredJob] = field(default_factory=list)
    update: list[tuple[DesiredJob, list[str]]] = field(default_factory=list)
    # update 대상별로 실물에만 있는 헤더(지울 것) — 이름 → 목록
    remove_headers: dict[str, list[str]] = field(default_factory=dict)
    unchanged: list[str] = field(default_factory=list)
    unmanaged: list[str] = field(default_factory=list)


def make_plan(desired: list[DesiredJob], live_jobs: list[dict], env: str) -> Plan:
    by_name = {_short_name(j["name"]): j for j in live_jobs}
    plan = Plan()
    wanted = set()
    for job in desired:
        wanted.add(job.name)
        live = by_name.get(job.name)
        if live is None:
            plan.create.append(job)
            continue
        changed = diff_job(job, live)
        if changed:
            plan.update.append((job, changed))
            extras = extra_headers(job, live)
            if extras:
                plan.remove_headers[job.name] = extras
        else:
            plan.unchanged.append(job.name)
    suffix = f"-{env}"
    plan.unmanaged = sorted(n for n in by_name if n.endswith(suffix) and n not in wanted)
    return plan


def _job_flags(job: DesiredJob, *, header_flag: str, remove_headers: list[str] | None = None) -> list[str]:
    headers = ",".join(f"{k}={v}" for k, v in sorted(job.headers.items()))
    r = job.retry
    flags = [
        f"--schedule={job.schedule}", f"--time-zone={job.time_zone}", f"--uri={job.uri}",
        f"--http-method={job.http_method}", f"{header_flag}={headers}",
        f"--attempt-deadline={job.attempt_deadline}",
        f"--max-retry-attempts={r['max_retry_attempts']}", f"--min-backoff={r['min_backoff']}",
        f"--max-backoff={r['max_backoff']}", f"--max-doublings={r['max_doublings']}",
        f"--max-retry-duration={r['max_retry_duration']}",
    ]
    if remove_headers:
        # 까디르 4590 P2 — 실물에만 있는 헤더를 안 지우면 적용 뒤 재조회에서 또 차이 → 매 배포 exit 1.
        flags.append(f"--remove-headers={','.join(remove_headers)}")
    return flags


def describe_backend(run: Runner, *, service: str, region: str) -> dict:
    return json.loads(run(["run", "services", "describe", service, f"--region={region}", "--format=json"]))


def backend_url(spec: dict, *, service: str) -> str:
    url = (spec.get("status") or {}).get("url")
    if not url:
        raise SystemExit(f"FAIL: {service} describe에 status.url이 없음 — 작업 uri를 만들 수 없다")
    return url


def resolve_bearer(run: Runner, spec: dict, *, service: str) -> tuple[str, str]:
    """실물 백엔드 서비스의 CRON_SECRET 값과 원천 설명(값 없이)을 돌려준다.

    **secretKeyRef만 지원한다**(PO 2026-09-24). 평문 env거나 원천이 없으면 실패로 끝낸다 — 평문 값을 describe로
    꺼내 다루는 경로도, 인증 없는 작업을 만드는 경로도 두지 않는다."""
    for container in spec["spec"]["template"]["spec"]["containers"]:
        for env in container.get("env", []):
            if env.get("name") != "CRON_SECRET":
                continue
            ref = (env.get("valueFrom") or {}).get("secretKeyRef")
            if not ref:
                raise SystemExit(
                    f"FAIL: {service}의 CRON_SECRET이 secretKeyRef가 아님 — 평문 값은 다루지 않는다(Secret Manager로 옮길 것)"
                )
            version = ref.get("key") or "latest"
            value = run(["secrets", "versions", "access", version, f"--secret={ref['name']}"]).strip()
            if not value:
                raise SystemExit(f"FAIL: 시크릿 {ref['name']}:{version} 값이 비어 있음")
            _SECRETS.add(value)
            return value, f"secretKeyRef {ref['name']}:{version}"
    raise SystemExit(f"FAIL: {service}에 CRON_SECRET이 없음 — 스케줄러 인증 헤더를 만들 수 없다")


def _describe(job: DesiredJob) -> str:
    return f"{job.name} [{job.http_method} {job.uri} · {job.schedule} {job.time_zone}]"


def main(argv: list[str] | None = None, *, run: Runner = _gcloud) -> int:
    parser = argparse.ArgumentParser(description=__doc__.split("\n", 1)[0])
    parser.add_argument("--env", required=True)
    parser.add_argument("--apply", action="store_true", help="실제로 바꾼다(기본은 dry-run)")
    args = parser.parse_args(argv)

    manifest = load_manifest()
    target = manifest["environments"][args.env]
    location = target["location"]
    service = target["backend_service"]
    spec = describe_backend(run, service=service, region=location)
    base_url = backend_url(spec, service=service)
    bearer, source = resolve_bearer(run, spec, service=service)
    print(f"백엔드: {service} status.url = {base_url}")
    print(f"Authorization 원천: {service} CRON_SECRET ({source})")

    desired = desired_jobs(manifest, args.env, bearer, base_url=base_url)
    live = json.loads(run(["scheduler", "jobs", "list", f"--location={location}", "--format=json"]))
    plan = make_plan(desired, live, args.env)

    for job in plan.create:
        print(f"CREATE {_describe(job)}")
    for job, changed in plan.update:
        print(f"UPDATE {_describe(job)} — {', '.join(changed)}")
    print(f"UNCHANGED {len(plan.unchanged)}")
    for name in plan.unmanaged:
        print(f"UNMANAGED {name} (정의에 없음 — 지우지 않고 보고만)")

    if not args.apply:
        print("dry-run — 바꾼 것 없음(--apply로 적용)")
        return 0

    for job in plan.create:
        run(["scheduler", "jobs", "create", "http", job.name, f"--location={location}",
             *_job_flags(job, header_flag="--headers")])
    for job, _changed in plan.update:
        run(["scheduler", "jobs", "update", "http", job.name, f"--location={location}",
             *_job_flags(job, header_flag="--update-headers", remove_headers=plan.remove_headers.get(job.name))])

    after = json.loads(run(["scheduler", "jobs", "list", f"--location={location}", "--format=json"]))
    residual = make_plan(desired, after, args.env)
    if residual.create or residual.update:
        left = [j.name for j in residual.create] + [j.name for j, _ in residual.update]
        print(f"FAIL: 적용 뒤에도 정의와 다른 작업: {left}", file=sys.stderr)
        return 1
    print(f"OK: 정의 {len(desired)}개 = 실물 (생성 {len(plan.create)} · 수정 {len(plan.update)})")
    return 0


if __name__ == "__main__":
    sys.exit(main())
