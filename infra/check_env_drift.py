#!/usr/bin/env python3
"""ⓒ 라이브 env 드리프트 가드 — ① 키집합 대조 (design doc env-drift-guard-design 참고).

라이브 Cloud Run 서비스의 env var 키 이름 전체가 (IaC 선언 키 ∪ manual-env-allowlist.yml)
안에 있는지 확認한다. 서비스 목록은 `gcloud run services list`로 매 실행 동적 열거 —
하드코딩하지 않는다(mcp-dev 키 유출 사건이 "아무도 안 본 서비스"에서 났다는 교훈).

로컬 수동 실행:
    python3 infra/check_env_drift.py

exit code: 0=드리프트 없음, 1=드리프트 발견(FAIL 상세를 stdout에 출력).
"""
from __future__ import annotations

import json
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


def _run(cmd: list[str]) -> str:
    result = subprocess.run(cmd, capture_output=True, text=True, check=True)
    return result.stdout.strip()


def _load_allowlist() -> tuple[set[str], dict[str, dict]]:
    import yaml

    data = yaml.safe_load(_ALLOWLIST_PATH.read_text())
    excluded = {e["service"] for e in data.get("excluded_services", [])}
    services = data.get("services", {})
    return excluded, services


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
    excluded, allowlist_services = _load_allowlist()
    iac_keys = _iac_covered_keys()

    live_services = _list_live_services()
    failures: list[str] = []
    unmapped: list[str] = []

    checked = 0
    for service in live_services:
        if service in excluded:
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
            failures.append(f"{service}: {', '.join(missing)}")

    if unmapped:
        failures.append(
            "매핑 안 된 신규 서비스(⛔ _SERVICE_SCRIPT_MAP·excluded_services 어느 쪽에도 "
            "없음 — gcloud 열거엔 잡히니 무시된 게 아니라 분류가 안 된 것): "
            + ", ".join(unmapped)
        )

    if failures:
        print("❌ env 드리프트 발견:")
        for line in failures:
            print(f"  - {line}")
        print(
            "\n→ 파이프라인(cloudbuild.yaml/deploy_*.sh)에 편입하거나 "
            "infra/manual-env-allowlist.yml에 사유와 함께 등재하기 바라는."
        )
        return 1

    print(f"✅ 드리프트 없음 — {checked}개 서비스 확認(제외 {len(excluded)}개, 총 열거 {len(live_services)}개).")
    return 0


if __name__ == "__main__":
    sys.exit(main())
