"""story #3674(BE 確定, 페드루 PO 確定 2026-09-07) — "오늘"(캘린더 날짜) 계산의
프로세스-로컬/무조건-UTC 직접 호출을 막는다. 3665(#4020)가 `date.today()`(프로세스
로컬 TZ)를 UTC 고정으로 바꿔 "환경마다 다른 오늘"은 닫았지만, 그 UTC 고정 자체가
"조직의 오늘"(org.timezone 인지)을 무시한다 — 이 결함 클래스가 다시 새어 들어오는
걸 막는 가드. 정답은 항상 `app.services.org_time`의 헬퍼(org_today·to_org_date·
org_midnight_utc·org_date_sql)를 org_id/org_timezone과 함께 쓰는 것.

⛔이 lint가 잡는 패턴 3종(backend/app/ 전수, `.py` 파일):
  ① `date.today()`(datetime.date의 today — 프로세스 로컬 TZ, 3665 원 결함)
  ② `utcnow().date()`(datetime.utcnow() 자체가 이미 폐기 예정 API인데다 여전히
     "조직의 오늘"을 무시)
  ③ `now(timezone.utc).date()`(3665가 만든 UTC 고정 — org tz 인지 前 상태)

⛔이 lint가 «못 잡는» 것: 동적으로 조립된 표현(변수 재할당 뒤 다단계 호출), 이 3개
리터럴 텍스트 패턴이 한 줄 안에 정확히 이어지지 않는 형태. 오탐 방지 우선(다른
lint_*.py와 동일 원칙).

허용 목록은 **파일 + 그 줄의 strip()된 내용 완전 일치**로 키를 잡는다(줄번호 X —
story #3609/#3611의 처방과 동형: 무관한 줄이 위에 추가돼 줄번호만 밀려도 안 깨진다).
새 항목을 등재하려면 reason·addedBy를 반드시 채울 것(사유 없는 예외 금지)."""
from __future__ import annotations

import re
import sys
from pathlib import Path
from typing import NamedTuple

SCAN_ROOT = "app"

_PATTERNS = [
    re.compile(r"\bdate\.today\(\)"),
    re.compile(r"\butcnow\(\)\.date\(\)"),
    re.compile(r"\bnow\(timezone\.utc\)\.date\(\)"),
]


class AllowlistEntry(NamedTuple):
    file: str
    line_content: str
    reason: str
    added_by: str


# story #3674 — 현재 등재분 0건(전수 grep 후 org_time.py 헬퍼로 전부 이전 完了).
# 정말 필요한 새 예외가 생기면 여기에 file(backend/app/ 기준 상대경로)·line_content
# (그 줄을 strip()한 정확한 원문)·reason·added_by를 채워 추가한다.
ALLOWLIST: list[AllowlistEntry] = []


def _is_allowed(rel_file: str, line_text: str) -> bool:
    stripped = line_text.strip()
    return any(e.file == rel_file and e.line_content == stripped for e in ALLOWLIST)


def find_violations(path: Path, label: str | None = None) -> list[str]:
    """단일 파일 스캔 — 위반 라인을 `{label}:{lineno}: {line}` 형태로 반환(label 생략 시 path 그대로)."""
    text = path.read_text(encoding="utf-8")
    label = label or str(path)
    violations: list[str] = []
    for lineno, line in enumerate(text.splitlines(), start=1):
        if _is_allowed(label, line):
            continue
        for pattern in _PATTERNS:
            if pattern.search(line):
                violations.append(f"{label}:{lineno}: {line.strip()}")
                break
    return violations


def scan(backend_root: Path) -> list[str]:
    violations: list[str] = []
    for f in sorted((backend_root / SCAN_ROOT).rglob("*.py")):
        violations.extend(find_violations(f, label=str(f.relative_to(backend_root))))
    return violations


def main() -> int:
    backend_root = Path(__file__).resolve().parent.parent
    violations = scan(backend_root)
    if violations:
        print(
            "FAIL: '오늘' 계산이 조직 시간대를 무시하는 직접 호출이 있다(story #3674 — "
            "app.services.org_time의 헬퍼(org_today·to_org_date·org_midnight_utc·"
            "org_date_sql)를 org_id/org_timezone과 함께 쓸 것. 정말 예외라면 스크립트의 "
            "ALLOWLIST에 file+line_content+reason+added_by로 등재):"
        )
        for v in violations:
            print(f"  {v}")
        return 1
    print(f"OK: '오늘' 직접 호출 0건(ALLOWLIST {len(ALLOWLIST)}건)")
    return 0


if __name__ == "__main__":
    sys.exit(main())
