#!/usr/bin/env python3
"""ⓒ 라이브 env 드리프트 가드 — ①키집합 대조 + ③평문 시크릿 형태 검출.

라이브 Cloud Run 서비스의 env var 키 이름 전체가 (IaC 선언 키 ∪ manual-env-allowlist.yml)
안에 있는지 확認한다(①). 서비스 목록은 `gcloud run services list`로 매 실행 동적 열거 —
하드코딩하지 않는다(mcp-dev 키 유출 사건이 "아무도 안 본 서비스"에서 났다는 교훈).

⛔ ③(평문 시크릿 형태 검출)은 excluded_services 여부와 무관하게 **전 서비스**에 적용한다 —
①②축은 "이 repo의 IaC로 대조 불가"라는 이유로 뺄 수 있지만, ③은 라이브 env value만 보면
판정되는 축이라 IaC 유무와 무관하다(오르테가군 지적, 2026-07-22: "제외"가 "감시 밖"이
되면 이 가드를 만든 이유 자체가 무효화된다 — mcp-dev 사고가 정확히 그 구멍에서 났다).

값 자체는 절대 출력/기록하지 않는다 — 매치 여부(bool)만 사용, stdout엔 키 이름·서비스만.

로컬 수동 실행:
    python3 infra/check_env_drift.py

exit code: 0=드리프트 없음, 1=드리프트 발견(FAIL 상세를 stdout에 출력).
"""
from __future__ import annotations

import re
import subprocess
import sys
from pathlib import Path

_REPO_ROOT = Path(__file__).resolve().parent.parent
_REGION = "asia-northeast3"
_ALLOWLIST_PATH = _REPO_ROOT / "infra" / "manual-env-allowlist.yml"

# 서비스 → 그 서비스의 env를 다루는 스크립트/IaC 소스. cloudbuild.yaml/cloud-build.yml은
# 전 서비스 공통으로 파싱해 합집합에 넣는다(어느 스텝이 어느 서비스를 겨냥하는지까지 세밀하게
# 가르지 않음 — v1은 "이 repo의 IaC 전체에 이 키가 한 번이라도 선언된 적 있는가"로 판정).
# 여기 없는 서비스가 gcloud 열거에 나타나면 FAIL로 잡는다(매핑 자체가 최신인지 강제).
_SERVICE_SCRIPT_MAP: dict[str, list[str]] = {
    "sprintable-backend-dev": ["backend/scripts/deploy_backend.sh"],
    "sprintable-backend-prod": ["backend/scripts/deploy_backend.sh"],
    "sprintable-realtime-dev": [],  # cloudbuild.yaml deploy-realtime 스텝만(공통 파싱에 포함)
    "sprintable-frontend-dev": ["backend/scripts/deploy_frontend.sh"],
    "sprintable-frontend-prod": ["backend/scripts/deploy_frontend.sh"],
    "sprintable-mcp-dev": ["backend/scripts/deploy_mcp_dev.sh"],
    "sprintable-mcp-prod": ["backend/scripts/deploy_mcp_prod.sh"],
}

_KEY_RE = re.compile(r"([A-Z][A-Z0-9_]*)=")

# ③ 평문 시크릿 형태 검출 — 알려진 시크릿 프리픽스 패턴. 새 프리픽스가 생기면 여기 추가.
# ⚠️ 오르테가군 지적(2026-07-22): 앵커(^...$)는 값이 정확히 그 형태일 때만 잡는다 —
# `Bearer sk_live_...`나 URL 쿼리 파라미터·JSON 안에 박혀 있으면 통과해버린다(mcp-dev
# 사고가 마침 단독 값이었을 뿐, 다음엔 다른 형태로 샐 수 있다). search()로 값 어디에
# 박혀 있든 잡히게 무앵커로 바꿨다 — `sk_live_`+15자 이상 영숫자가 우연히 등장할 값은
# 사실상 없어 오탐 위험은 낮다.
# ⚠️ 한계(현재 스코프 밖, 기록만): `sk_live_` 프리픽스만 검출한다 — `sk_test_`·GitHub
# 토큰·GCP 키 등 다른 시크릿 형태는 이 패턴으로 못 잡는다(스코프 확대는 후속).
_SECRET_SHAPE_RE = re.compile(r"sk_live_[A-Za-z0-9]{15,}")


def _run(cmd: list[str]) -> str:
    result = subprocess.run(cmd, capture_output=True, text=True, check=True)
    return result.stdout.strip()


def _load_allowlist() -> tuple[dict[str, set[str]], dict[str, dict]]:
    """반환: {service: {제외된 축 집합}} — ③은 절대 포함되지 않는다(코드에서 강제)."""
    import yaml

    data = yaml.safe_load(_ALLOWLIST_PATH.read_text())
    excluded_axes: dict[str, set[str]] = {}
    for entry in data.get("excluded_services", []):
        axes = set(entry.get("excluded_axes", []))
        axes.discard("secret_shape")  # ③은 축별 제외 대상에서 원천 배제
        excluded_axes[entry["service"]] = axes
    services = data.get("services", {})
    return excluded_axes, services


def _list_live_services() -> list[str]:
    out = _run([
        "gcloud", "run", "services", "list",
        f"--region={_REGION}", "--format=value(metadata.name)",
    ])
    return [line.strip() for line in out.splitlines() if line.strip()]


def _live_env_keys(service: str) -> set[str]:
    out = _run([
        "gcloud", "run", "services", "describe", service,
        f"--region={_REGION}",
        "--format=value(spec.template.spec.containers[0].env[].name)",
    ])
    if not out:
        return set()
    return {k.strip() for k in out.split(";") if k.strip()}


def _plain_secret_shaped_keys(service: str) -> list[str]:
    """③ — plain(비-secretKeyRef) env value가 알려진 시크릿 형태와 일치하는 키 이름만 반환.

    값 자체는 이 함수 밖으로 절대 나가지 않는다(정규식 매치 결과 bool만 사용) — 호출부는
    반환된 키 이름과 서비스만 로그에 남긴다."""
    import json as _json

    out = _run([
        "gcloud", "run", "services", "describe", service,
        f"--region={_REGION}",
        "--format=json(spec.template.spec.containers[0].env)",
    ])
    if not out:
        return []
    data = _json.loads(out)
    envs = (
        data.get("spec", {}).get("template", {}).get("spec", {})
        .get("containers", [{}])[0].get("env", [])
    )
    hits = []
    for entry in envs:
        value = entry.get("value")
        if value is not None and _SECRET_SHAPE_RE.search(value):
            hits.append(entry["name"])
    return hits


def _extract_keys_from_text(text: str) -> set[str]:
    """--update-env-vars=/--set-env-vars=/ENV_VARS_SPEC 류 문자열에서 KEY= 패턴 전수 추출.

    커스텀 구분자(^@^, ^##^)든 콤마든 상관없이 `[A-Z][A-Z0-9_]*=` 형태만 보므로 구분자
    파싱 자체는 불필요 — 값 안에 등장하는 대문자 패턴 오탐 가능성은 있으나(예: URL 안의
    쿼리 파라미터) 이 repo의 실제 값들 기준으로는 나타나지 않음(v1 실용적 타협).
    """
    return set(_KEY_RE.findall(text))


def _iac_covered_keys() -> set[str]:
    covered: set[str] = set()
    for rel in ("cloudbuild.yaml", ".github/workflows/cloud-build.yml"):
        path = _REPO_ROOT / rel
        if path.exists():
            covered |= _extract_keys_from_text(path.read_text())
    for scripts in _SERVICE_SCRIPT_MAP.values():
        for rel in scripts:
            path = _REPO_ROOT / rel
            if path.exists():
                covered |= _extract_keys_from_text(path.read_text())
    return covered


def main() -> int:
    excluded_axes, allowlist_services = _load_allowlist()
    iac_keys = _iac_covered_keys()

    live_services = _list_live_services()
    key_set_failures: list[str] = []
    secret_shape_failures: list[str] = []
    unmapped: list[str] = []

    checked = 0
    for service in live_services:
        # ③ 평문 시크릿 형태 검출 — excluded_services 여부와 무관하게 전 서비스에 적용.
        secret_hits = _plain_secret_shaped_keys(service)
        if secret_hits:
            secret_shape_failures.append(f"{service}: {', '.join(sorted(secret_hits))}")

        # ①키집합 대조 — 축별 제외(key_set) 대상이면 스킵.
        if "key_set" in excluded_axes.get(service, set()):
            continue
        if service not in _SERVICE_SCRIPT_MAP:
            unmapped.append(service)
            continue

        checked += 1
        live_keys = _live_env_keys(service)
        allowed_keys = {
            entry["key"] for entry in allowlist_services.get(service, {}).get("keys", [])
        }
        covered = iac_keys | allowed_keys
        missing = sorted(live_keys - covered)
        if missing:
            key_set_failures.append(f"{service}: {', '.join(missing)}")

    if unmapped:
        key_set_failures.append(
            "매핑 안 된 신규 서비스(⛔ _SERVICE_SCRIPT_MAP·excluded_services(key_set축) "
            "어느 쪽에도 없음 — gcloud 열거엔 잡히니 무시된 게 아니라 분류가 안 된 것): "
            + ", ".join(unmapped)
        )

    if key_set_failures or secret_shape_failures:
        print("❌ env 드리프트 발견:")
        if key_set_failures:
            print("  ①키집합 대조:")
            for line in key_set_failures:
                print(f"    - {line}")
        if secret_shape_failures:
            print("  ③평문 시크릿 형태 검출(⛔ 값은 출력하지 않음 — 키 이름만):")
            for line in secret_shape_failures:
                print(f"    - {line}")
        print(
            "\n→ ①은 파이프라인(cloudbuild.yaml/deploy_*.sh)에 편입하거나 "
            "infra/manual-env-allowlist.yml에 사유와 함께 등재. "
            "③은 즉시 Secret Manager secretKeyRef로 전환 바라는(평문 유지 시 재확定 시마다 재발)."
        )
        return 1

    print(
        f"✅ 드리프트 없음 — ①{checked}개 서비스 키집합 확認"
        f"(제외 {sum(1 for a in excluded_axes.values() if 'key_set' in a)}개), "
        f"③{len(live_services)}개 서비스 전체 평문시크릿 스캔 완료(제외 없음)."
    )
    return 0


if __name__ == "__main__":
    sys.exit(main())
