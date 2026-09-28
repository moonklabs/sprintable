#!/usr/bin/env python3
"""story #4023 CHANGES 1/2(PO 지적) — 자매 self-expiring 선언 파일 3개(manual-env-allowlist.yml
`code_read_high_baseline`·serving-reality-allowlist.yml `declared_pins`/`declared_stalls`·
mcp-path-contract-allowlist.yml `declared_mismatches`/`declared_indirect`)는 각각의 가드
본체(`check_env_drift.py`/`check_serving_reality.py`/`mcp_path_contract_guard.py`)가 만료
자체는 FAIL로 잡지만, 그 가드들은 라이브(GCP) 대조가 있어 **스케줄 전용 워크플로우**
(env-drift-guard.yml, 새벽 로그)에서만 돈다 — PR을 여는 사람은 그 로그를 안 본다.

이 스크립트는 그 세 가드와 별개인 **네 번째, PR CI 전용, 경량 축**이다: GCP/gcloud 호출
0(파일만 읽음), `until`이 앞으로 14일 이내인 항목을 GitHub Actions 주석
(`::warning file=...::...`)으로 PR 화면에 직접 띄운다.

⚠️CHANGES 2(PO 지적) — 이 축이 조용히 꺼지는 길이 3개 있었다: ①파일 자체가 없어져도
`_load_yaml`이 빈 dict를 돌려줘 "OK"로 보고됨 ②섹션 키 이름이 바뀌어도(리팩터 등)
`data.get(section) or []`가 조용히 빈 목록 취급 ③`until` 날짜 형식이 깨져도 `continue`로
그 항목 자체가 조회 대상에서 사라짐. 이 셋은 "지금 만료 임박 항목이 없다"(정상)와 근본적으로
다른 상태 — **이 축 자체가 대상을 못 보고 있다**는 뜻이라 구조적 오류(`::error`+exit 1)로
승격한다. 날짜 형식 파손은 즉시 위험은 아니되 숨기면 안 되므로 `::warning`으로 드러낸다.

exit code: 구조적 오류(파일/섹션 부재·형식 파손) 있으면 1, 그 외(만료 임박 경고 포함)는 0 —
"만료 임박"은 예정대로 report-only(실패로 안 막음, 각 가드 본체가 만료 자체의 FAIL을 담당).

근본 사고(2026-09-17, story #4023) — «#3174가 착지하면 이 항목을 걷는다»는 문장만 있고
그 PR이 실제로 걷지 않아 만료 당일(2026-09-26)까지 아무도 못 볼 뻔했다. 이 경고가 있었다면
14일 전에 눈에 띄었을 것.

로컬 수동 실행:
    python3 infra/check_expiring_declarations.py
"""
from __future__ import annotations

import sys
from dataclasses import dataclass, field
from datetime import date, datetime, timezone
from pathlib import Path

_REPO_ROOT = Path(__file__).resolve().parent.parent
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


@dataclass
class ExpiryScanResult:
    warnings: list[tuple[str, str]] = field(default_factory=list)  # 만료 임박·날짜 형식 파손
    errors: list[tuple[str, str]] = field(default_factory=list)  # 파일/섹션 자체가 안 보임


def collect_expiry_findings(
    repo_root: Path = _REPO_ROOT, today: date | None = None, warning_days: int = _WARNING_DAYS
) -> ExpiryScanResult:
    """순수 함수(GCP/gcloud 호출 0, 파일 읽기만). 이미 만료된 항목(각 가드 본체 FAIL 축이
    담당)이나 `until`이 아예 없는 항목(구조적 영구 등)은 대상이 아니다 — 그건 정상이다.
    반면 파일/섹션 키 자체가 안 보이는 것은 "지금 0건"과 다른 상태라 errors로 분리한다."""
    today = today if today is not None else _today()
    result = ExpiryScanResult()
    for filename, sections in _SOURCES:
        rel_path = f"infra/{filename}"
        path = repo_root / "infra" / filename
        if not path.exists():
            result.errors.append((rel_path, "파일 자체가 없다 — 이 축이 이 파일을 못 본다"))
            continue
        import yaml

        data = yaml.safe_load(path.read_text()) or {}
        for section in sections:
            if section not in data:
                result.errors.append((
                    rel_path,
                    f"섹션 `{section}`이 이 파일에 없다(키 이름이 바뀌었거나 지워짐) — "
                    "이 축이 그 섹션을 못 본다(빈 목록 `[]`이면 정상, 키 자체 부재는 오류)",
                ))
                continue
            for entry in data[section] or []:
                until_raw = entry.get("until")
                if not until_raw:
                    continue
                label = _entry_label(entry)
                try:
                    until = date.fromisoformat(str(until_raw))
                except ValueError:
                    result.warnings.append((
                        rel_path,
                        f"{section} `{label}` — `until` 형식이 YYYY-MM-DD가 아니다: "
                        f"{until_raw!r}(재triage 필요)",
                    ))
                    continue
                horizon = (until - today).days
                if 0 <= horizon <= warning_days:
                    result.warnings.append((
                        rel_path,
                        f"{section} `{label}` — {horizon}일 뒤 만료(until={until}) — "
                        "만료 전에 재triage 필요(story #4023 재발 방지 축)",
                    ))
    return result


def format_gha_warning(rel_path: str, message: str) -> str:
    """GitHub Actions workflow command 형식 — PR의 Files changed/Checks 화면에 직접
    annotation으로 뜬다(별도 알림 채널 불요)."""
    return f"::warning file={rel_path}::{message}"


def format_gha_error(rel_path: str, message: str) -> str:
    return f"::error file={rel_path}::{message}"


def main() -> int:
    result = collect_expiry_findings()
    if not result.warnings and not result.errors:
        print(
            "OK — self-expiring 선언 3파일(manual-env-allowlist.yml·"
            "serving-reality-allowlist.yml·mcp-path-contract-allowlist.yml) 전부 "
            f"{_WARNING_DAYS}일 이내 만료 항목 없음."
        )
    for rel_path, message in result.warnings:
        print(format_gha_warning(rel_path, message))
    for rel_path, message in result.errors:
        print(format_gha_error(rel_path, message))
    return 1 if result.errors else 0


if __name__ == "__main__":
    sys.exit(main())
