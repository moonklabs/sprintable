#!/usr/bin/env python3
"""ⓒ 라이브 env 드리프트 가드 — ①키집합 대조 + ②값 대조(story #2098) + ③평문 시크릿 형태 검출.

라이브 Cloud Run 서비스의 env var 키 이름 전체가 (IaC 선언 키 ∪ manual-env-allowlist.yml)
안에 있는지 확認한다(①). 서비스 목록은 `gcloud run services list`로 매 실행 동적 열거 —
하드코딩하지 않는다(mcp-dev 키 유출 사건이 "아무도 안 본 서비스"에서 났다는 교훈).

②(값 대조)는 DRY_RUN을 지원하는 deploy_backend.sh/deploy_frontend.sh 대상(backend-dev/prod,
frontend-dev/prod)만 커버한다 — #2381이 잡은 APP_ENV/FRONTEND_URL/COOKIE_DOMAIN류 버그가
정확히 이 두 스크립트의 계산값 클래스였다. realtime-dev(cloudbuild.yaml 단일 소스)·
mcp-dev/prod(항상 `--set-env-vars` 전체교체라 additive-drift 리스크 자체가 낮음)는 이번
스코프 밖 — 후속으로 넓힐 수 있음(못 잡는 것을 못 잡는다고 적어두는 것).

⛔ ③(평문 시크릿 형태 검출)은 excluded_services 여부와 무관하게 **전 서비스**에 적용한다 —
①②축은 "이 repo의 IaC로 대조 불가"라는 이유로 뺄 수 있지만, ③은 라이브 env value만 보면
판정되는 축이라 IaC 유무와 무관하다(오르테가군 지적, 2026-07-22: "제외"가 "감시 밖"이
되면 이 가드를 만든 이유 자체가 무효화된다 — mcp-dev 사고가 정확히 그 구멍에서 났다).

④(story #2135, 2026-07-24) — Settings 커버리지: app.core.config.Settings를 실제로 쓰는
서비스(backend-dev/prod·realtime-dev — 같은 이미지)의 라이브 env 키가 Settings 필드명(대문자
변환) ∪ manual-env-allowlist.yml의 settings_exempt와 매칭되는지. 오늘 실측된 결함류
("REDIS_CONSUME_ENABLED"가 실제 필드 `event_broker_redis_consume_enabled`와 안 맞아
pydantic-settings의 extra="ignore"가 조용히 삼킨 것)를 배포 시점(CI)에 잡기 위함 —
Settings 클래스 자체를 extra="forbid"로 바꾸는 건 안 함(플랫폼/런타임 주입 키가 기동을
막는 위험, 오르테가 판정 2026-07-24). ⚠️report-only로 시작 — 라이브 env엔 플랫폼 주입키
(K_SERVICE·PORT·PYTHONPATH·GOOGLE_*·CLOUDSDK_* 등)가 반드시 섞여 있어 exempt 목록이
안정화되기 전엔 FAIL 승격하지 않는다(exit code에 반영 안 함 — stdout 열거만). exempt 목록이
triage로 정리된 後 별도 커밋에서 fail로 승격할 것.

값 자체는 절대 출력/기록하지 않는다 — 매치 여부(bool)만 사용, stdout엔 키 이름·서비스만.

로컬 수동 실행:
    python3 infra/check_env_drift.py

exit code: 0=드리프트 없음, 1=드리프트 발견(FAIL 상세를 stdout에 출력).
"""
from __future__ import annotations

import json
import os
import re
import subprocess
import sys
from pathlib import Path

_REPO_ROOT = Path(__file__).resolve().parent.parent
_REGION = "asia-northeast3"
_ALLOWLIST_PATH = _REPO_ROOT / "infra" / "manual-env-allowlist.yml"

# ④ Settings 커버리지 대상 — app.core.config.Settings를 실제로 임포트해서 쓰는 서비스만
# (같은 이미지). frontend·mcp·admin은 이 클래스 자체를 안 쓰므로 제외(오탐 방지 핵심).
_SETTINGS_CONSUMING_SERVICES = {
    "sprintable-backend-dev", "sprintable-backend-prod", "sprintable-realtime-dev",
}


_SETTINGS_CONFIG_PATH = _REPO_ROOT / "backend" / "app" / "core" / "config.py"
# `    field_name: type = default` 형태의 클래스 필드 선언만 잡는다(4칸 들여쓰기 — Settings
# 클래스 본문 레벨). config.py가 오늘 순수 선언형(82필드 전부 이 형태)이라 정확히 맞는다.
_SETTINGS_FIELD_RE = re.compile(r"^    ([a-z_][a-zA-Z0-9_]*)\s*:\s*[^=\n]+=", re.MULTILINE)


def _settings_field_env_keys() -> set[str]:
    """app/core/config.py를 **static 파싱**해 Settings 필드명을 env var 키로 변환(env_prefix
    없음 ⇒ 필드명 대문자 == env 키, alias 0개 전제 — 전제가 깨지면 이 함수도 갱신 필요).

    ⛔story #2135 라이브 실증(2026-07-24, 오르테가 재트리거) — 원래는 `from app.core.config
    import Settings`로 실제 import했으나, env-drift-guard.yml 워크플로는 gcloud+파싱만
    하는 가벼운 CI라 backend 의존성(pydantic_settings 등)이 설치돼 있지 않다.
    `ModuleNotFoundError: No module named 'pydantic_settings'`로 매일 00:00 크래시하는
    가드를 배포할 뻔했다 — fixture(pytest, backend 의존성 있는 환경) 통과가 라이브 동작을
    보증하지 않는다는 것을 이 사건 자체가 실증한다. **infra 도구가 앱 런타임을 import하면
    안 된다**가 근본 — static 파싱으로 층을 분리한다(import 0·의존성 0).
    ⚠️한계: config.py가 동적으로 필드를 생성하면(현재는 순수 선언형 82필드 전부 이 형태라
    해당 없음) 이 파싱이 놓친다."""
    text = _SETTINGS_CONFIG_PATH.read_text()
    return {name.upper() for name in _SETTINGS_FIELD_RE.findall(text)}


def _load_settings_exempt() -> dict[str, str]:
    """반환: {key: reason} — 플랫폼/런타임 주입 등 Settings가 몰라도 되는 키."""
    import yaml
    data = yaml.safe_load(_ALLOWLIST_PATH.read_text())
    return {
        entry["key"]: entry.get("reason", "")
        for entry in data.get("settings_exempt", [])
    }

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

# ② 값 대조 대상 — DRY_RUN=1로 ENV_VARS_SPEC을 stdout에 뽑아낼 수 있는 스크립트만.
_SERVICE_DRY_RUN_MAP: dict[str, tuple[str, str]] = {
    "sprintable-backend-dev": ("backend/scripts/deploy_backend.sh", "dev"),
    "sprintable-backend-prod": ("backend/scripts/deploy_backend.sh", "prod"),
    "sprintable-frontend-dev": ("backend/scripts/deploy_frontend.sh", "dev"),
    "sprintable-frontend-prod": ("backend/scripts/deploy_frontend.sh", "prod"),
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


def _live_env_entries(service: str) -> list[dict]:
    """서비스의 raw env 리스트(name + value 또는 valueFrom) — ②③이 공유."""
    out = _run([
        "gcloud", "run", "services", "describe", service,
        f"--region={_REGION}",
        "--format=json(spec.template.spec.containers[0].env)",
    ])
    if not out:
        return []
    data = json.loads(out)
    return (
        data.get("spec", {}).get("template", {}).get("spec", {})
        .get("containers", [{}])[0].get("env", [])
    )


def _plain_secret_shaped_keys(envs: list[dict]) -> list[str]:
    """③ — plain(비-secretKeyRef) env value가 알려진 시크릿 형태와 일치하는 키 이름만 반환.

    값 자체는 이 함수 밖으로 절대 나가지 않는다(정규식 매치 결과 bool만 사용) — 호출부는
    반환된 키 이름과 서비스만 로그에 남긴다."""
    hits = []
    for entry in envs:
        value = entry.get("value")
        if value is not None and _SECRET_SHAPE_RE.search(value):
            hits.append(entry["name"])
    return hits


def _live_plain_env_values(envs: list[dict]) -> dict[str, str]:
    """② 대조용 — plain(비-secretKeyRef) env만 key→value. secretKeyRef는 값이 안 보이니
    비교 대상이 아니다(① 키집합 대조가 그 존재 자체는 이미 커버)."""
    return {e["name"]: e["value"] for e in envs if e.get("value") is not None}


def _parse_key_value_spec(spec: str) -> dict[str, str]:
    """`KEY1=val1,KEY2=val2` 또는 `^@^KEY1=val1@KEY2=val2` 류 구분자 무관 파싱.

    `_extract_keys_from_text`와 동일 전제(`[A-Z][A-Z0-9_]*=` 위치 기준) — 각 키 매치의
    시작~다음 키 매치 시작 사이를 값으로 보고, 끝에 남은 구분자 문자(,·@·#·^)만 벗겨낸다.
    """
    matches = list(_KEY_RE.finditer(spec))
    result: dict[str, str] = {}
    for i, m in enumerate(matches):
        key = m.group(1)
        val_start = m.end()
        val_end = matches[i + 1].start() if i + 1 < len(matches) else len(spec)
        result[key] = spec[val_start:val_end].rstrip(",@#^")
    return result


def _dry_run_env_vars_spec(script_rel: str, env_arg: str) -> dict[str, str]:
    """deploy_backend.sh/deploy_frontend.sh를 DRY_RUN=1로 돌려 ENV_VARS_SPEC 계산값을 얻는다.

    실 배포(gcloud run deploy)는 스킵되고 resolved config만 stdout으로 나온다(스크립트
    자체의 DRY_RUN 계약) — network 부작용 없음(단, prod frontend의 FASTAPI_URL 동적
    discovery 자체는 read-only gcloud describe 1콜을 그대로 수행)."""
    script_path = _REPO_ROOT / script_rel
    result = subprocess.run(
        ["bash", str(script_path), env_arg],
        capture_output=True, text=True, check=True,
        env={**os.environ, "DRY_RUN": "1", "COMMIT_SHA": "dry-run-placeholder", "ENV": env_arg},
    )
    for line in result.stdout.splitlines():
        if line.startswith("ENV_VARS_SPEC="):
            return _parse_key_value_spec(line[len("ENV_VARS_SPEC="):])
    return {}


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
    settings_field_keys = _settings_field_env_keys()
    settings_exempt = _load_settings_exempt()

    live_services = _list_live_services()
    key_set_failures: list[str] = []
    value_check_failures: list[str] = []
    secret_shape_failures: list[str] = []
    settings_coverage_report: list[str] = []  # ④ report-only — FAIL 집합에 안 넣음(위 docstring).
    unmapped: list[str] = []

    checked = 0
    value_checked = 0
    for service in live_services:
        envs = _live_env_entries(service)

        # ③ 평문 시크릿 형태 검출 — excluded_services 여부와 무관하게 전 서비스에 적용.
        secret_hits = _plain_secret_shaped_keys(envs)
        if secret_hits:
            secret_shape_failures.append(f"{service}: {', '.join(sorted(secret_hits))}")

        # ④ Settings 커버리지(story #2135, report-only) — Settings 소비 서비스만.
        if service in _SETTINGS_CONSUMING_SERVICES:
            live_keys_for_settings = {e["name"] for e in envs}
            unrecognized = sorted(
                live_keys_for_settings - settings_field_keys - set(settings_exempt)
            )
            if unrecognized:
                settings_coverage_report.append(f"{service}: {', '.join(unrecognized)}")

        # ② 값 대조 — DRY_RUN 지원 스크립트 매핑이 있는 서비스만.
        if service in _SERVICE_DRY_RUN_MAP:
            skip_keys = {
                entry["key"] for entry in allowlist_services.get(service, {}).get("keys", [])
                if entry.get("value_check") == "skip"
            }
            script_rel, env_arg = _SERVICE_DRY_RUN_MAP[service]
            expected = _dry_run_env_vars_spec(script_rel, env_arg)
            live_plain = _live_plain_env_values(envs)
            value_checked += 1
            mismatched = sorted(
                key for key, exp_val in expected.items()
                if key not in skip_keys and key in live_plain and live_plain[key] != exp_val
            )
            if mismatched:
                value_check_failures.append(f"{service}: {', '.join(mismatched)}")

        # ①키집합 대조 — 축별 제외(key_set) 대상이면 스킵.
        if "key_set" in excluded_axes.get(service, set()):
            continue
        if service not in _SERVICE_SCRIPT_MAP:
            unmapped.append(service)
            continue

        checked += 1
        live_keys = {e["name"] for e in envs}
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

    if key_set_failures or value_check_failures or secret_shape_failures or settings_coverage_report:
        print("❌ env 드리프트 발견:")
        if key_set_failures:
            print("  ①키집합 대조:")
            for line in key_set_failures:
                print(f"    - {line}")
        if value_check_failures:
            print("  ②값 대조(⛔ 값은 출력하지 않음 — 키 이름만, 스크립트 계산값 ≠ 라이브):")
            for line in value_check_failures:
                print(f"    - {line}")
        if secret_shape_failures:
            print("  ③평문 시크릿 형태 검출(⛔ 값은 출력하지 않음 — 키 이름만):")
            for line in secret_shape_failures:
                print(f"    - {line}")
        if settings_coverage_report:
            print(
                "  ④Settings 커버리지 — 이 키는 IaC가 배포하지만 Settings(app/core/config.py)도\n"
                "    settings_exempt(infra/manual-env-allowlist.yml)도 모른다. 오늘 발견된\n"
                "    REDIS_CONSUME_ENABLED류(pydantic-settings extra=\"ignore\"가 조용히 삼킨)와\n"
                "    같은 결함류일 수 있다:"
            )
            for line in settings_coverage_report:
                print(f"    - {line}")
        else:
            # story #2135 후속(2026-07-24, 오르테가 지적) — 다른 축이 FAIL이어도 ④ 자체는
            # "돌았고 통과했다"를 눈에 보이게 남긴다. 안 그러면 "④가 실행은 됐나"를 출력만
            # 보고는 알 수 없다 — 오늘 반복된 그 계열(성공이 관측 안 되면 성공했는지 모른다).
            print(
                f"  ④Settings 커버리지 — 이상 없음"
                f"({len(_SETTINGS_CONSUMING_SERVICES)}개 서비스 검사·미커버 0건)."
            )
        print(
            "\n→ ①은 파이프라인(cloudbuild.yaml/deploy_*.sh)에 편입하거나 "
            "infra/manual-env-allowlist.yml에 사유와 함께 등재. "
            "②는 스크립트 재실행 시 라이브 값을 되돌릴 위험 — 스크립트를 라이브에 맞게 "
            "고치거나 의도적이면 allowlist에 `value_check: skip`+사유로 등재. "
            "③은 즉시 Secret Manager secretKeyRef로 전환 바라는(평문 유지 시 재확定 시마다 재발). "
            "④는 (a) 플랫폼/런타임 주입 → settings_exempt 등재(어느 파일이 읽는지 명시), "
            "(b) 진짜 무효 배선 → 제거 또는 Settings 필드 추가, (c) 이름만 다른 alias → "
            "Settings 필드명 자체를 그 이름에 맞게 정정."
        )
        return 1

    print(
        f"✅ 드리프트 없음 — ①{checked}개 서비스 키집합"
        f"(제외 {sum(1 for a in excluded_axes.values() if 'key_set' in a)}개), "
        f"②{value_checked}개 서비스 값 대조, "
        f"③{len(live_services)}개 서비스 전체 평문시크릿 스캔 완료(제외 없음), "
        f"④{len(_SETTINGS_CONSUMING_SERVICES)}개 서비스 Settings 커버리지 대조 완료."
    )
    return 0


if __name__ == "__main__":
    sys.exit(main())
