#!/usr/bin/env python3
"""story #4023 CHANGES 1(PO 지적) — 자매 self-expiring 선언 파일 3개(manual-env-allowlist.yml
`code_read_high_baseline`·serving-reality-allowlist.yml `declared_pins`/`declared_stalls`·
mcp-path-contract-allowlist.yml `declared_mismatches`/`declared_indirect`)는 각각의 가드
본체(`check_env_drift.py`/`check_serving_reality.py`/`mcp_path_contract_guard.py`)가 만료
자체는 FAIL로 잡지만, 그 가드들은 라이브(GCP) 대조가 있어 **스케줄 전용 워크플로우**
(env-drift-guard.yml, 새벽 로그)에서만 돈다 — PR을 여는 사람은 그 로그를 안 본다.

이 스크립트는 그 세 가드와 별개인 **네 번째, PR CI 전용, 경량 축**이다: GCP/gcloud 호출
0(파일만 읽음), `until`이 앞으로 14일 이내인 항목을 GitHub Actions 주석
(`::warning file=...::...`)으로 PR 화면에 직접 띄운다. exit 0 고정 — 이 축은 실패로 막지
않는다(만료 자체의 FAIL 판정은 각 가드 본체가 여전히 담당).

근본 사고(2026-09-17, story #4023) — «#3174가 착지하면 이 항목을 걷는다»는 문장만 있고
그 PR이 실제로 걷지 않아 만료 당일(2026-09-26)까지 아무도 못 볼 뻔했다. 이 경고가 있었다면
14일 전에 눈에 띄었을 것.

로컬 수동 실행:
    python3 infra/check_expiring_declarations.py
"""
from __future__ import annotations

import sys
from datetime import date, datetime, timezone
from pathlib import Path

_REPO_ROOT = Path(__file__).resolve().parent.parent
_INFRA_DIR = _REPO_ROOT / "infra"
_WARNING_DAYS = 14

# (파일명, [이 파일 안에서 `until` 계약을 쓰는 섹션 키들]) — declared_permanent_indirect
# 처럼 `until`이 애초에 없는(구조적 영구) 섹션은 대상이 아니다.
_SOURCES: list[tuple[str, list[str]]] = [
    ("manual-env-allowlist.yml", ["code_read_high_baseline"]),
    ("serving-reality-allowlist.yml", ["declared_pins", "declared_stalls"]),
    ("mcp-path-contract-allowlist.yml", ["declared_mismatches", "declared_indirect"]),
]


def _today() -> date:
    import os

    env = os.environ.get("CHECK_EXPIRING_DECLARATIONS_TODAY")
    if env:
        return date.fromisoformat(env)
    return datetime.now(timezone.utc).date()


def _load_yaml(path: Path) -> dict:
    import yaml

    if not path.exists():
        return {}
    return yaml.safe_load(path.read_text()) or {}


def _entry_label(entry: dict) -> str:
    """파일마다 항목을 식별하는 필드명이 다르다(key·service·module+function·
    module+method+path) — 사람이 읽을 한 줄로 정규화."""
    if "key" in entry:
        return str(entry["key"])
    if "service" in entry:
        return str(entry["service"])
    if "module" in entry and "function" in entry:
        return f"{entry['module']}.{entry['function']}"
    if "module" in entry and "method" in entry and "path" in entry:
        return f"{entry['module']} {entry['method']} {entry['path']}"
    return "(알 수 없는 항목)"


def collect_expiring_soon(
    repo_root: Path = _REPO_ROOT, today: date | None = None, warning_days: int = _WARNING_DAYS
) -> list[tuple[str, str]]:
    """(상대경로, 메시지) 목록 — 순수 함수(GCP/gcloud 호출 0, 파일 읽기만). 이미 만료됐거나
    (각 가드 본체 FAIL 축이 담당) `until`이 아예 없는 항목(구조적 영구 등)은 대상이 아니다."""
    today = today if today is not None else _today()
    findings: list[tuple[str, str]] = []
    for filename, sections in _SOURCES:
        rel_path = f"infra/{filename}"
        data = _load_yaml(repo_root / "infra" / filename)
        for section in sections:
            for entry in data.get(section) or []:
                until_raw = entry.get("until")
                if not until_raw:
                    continue
                try:
                    until = date.fromisoformat(str(until_raw))
                except ValueError:
                    continue
                horizon = (until - today).days
                if 0 <= horizon <= warning_days:
                    label = _entry_label(entry)
                    findings.append((
                        rel_path,
                        f"{section} `{label}` — {horizon}일 뒤 만료(until={until}) — "
                        "만료 전에 재triage 필요(story #4023 재발 방지 축)",
                    ))
    return findings


def format_gha_warning(rel_path: str, message: str) -> str:
    """GitHub Actions workflow command 형식 — PR의 Files changed/Checks 화면에 직접
    annotation으로 뜬다(별도 알림 채널 불요)."""
    return f"::warning file={rel_path}::{message}"


def main() -> int:
    findings = collect_expiring_soon()
    if not findings:
        print(
            "OK — self-expiring 선언 3파일(manual-env-allowlist.yml·"
            "serving-reality-allowlist.yml·mcp-path-contract-allowlist.yml) 전부 "
            f"{_WARNING_DAYS}일 이내 만료 항목 없음."
        )
        return 0
    for rel_path, message in findings:
        print(format_gha_warning(rel_path, message))
    return 0  # report-only — 이 축은 실패로 막지 않는다(각 가드 본체가 만료 자체는 FAIL).


if __name__ == "__main__":
    sys.exit(main())
