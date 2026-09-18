"""story #2476(결제②-A1후속 재그라운딩, 2026-09-01) — legacy `subscriptions`·
`subscription_checkout_sessions` 테이블이 OSS backend 코드에 다시 참조되면 CI를 빨갛게 한다.

배경: 두 테이블은 OSS(이 레포)에서 참조 0건(재그라운딩 시점 전수 grep 확認)이지만, 死
테이블은 아니다 — `docs/pk-triage-orm-unmodeled.md`(story a74bdc84)가 이미 별도 SaaS 제품이
같은 물리 DB를 라이브로 쓰는 중임을 확認해 뒀다(subscriptions 206 refs·subscription_
checkout_sessions 35 refs). OSS 정본은 `org_subscriptions`(app/models/org_subscription.py::
OrgSubscription) 하나뿐 — 누군가 실수로(또는 예전 설계문서를 그대로 베껴) 이 legacy 테이블을
ORM 모델이나 raw SQL로 다시 끌어오면, 그 코드는 SaaS가 실제로 쓰는 스키마를 OSS 배포가
건드리게 될 위험이 있다. 「참조 0」을 계수 가능하게 유지하는 가드.

⛔이 lint가 잡는 것(패턴 3종, backend/app/ 전수):
  ① `__tablename__ = "subscriptions"` / `"subscription_checkout_sessions"` (ORM 모델 재도입)
  ② raw SQL: FROM/INTO/UPDATE/JOIN 뒤에 그 테이블명이 오는 경우(대소문자 무관)
  ③ `sa.Table("subscriptions", ...)` / `Table("subscription_checkout_sessions", ...)` 리플렉션

⛔이 lint가 «못 잡는» 것: 동적으로 조립된 테이블명(f-string·변수 결합), ORM 관계 문자열이
아닌 완전히 별도 표현으로 우회한 raw SQL. 오탐 방지 우선(다른 lint_*.py와 동일 원칙) — 걸리면
그건 이 스크립트가 못 잡던 새 우회 경로이지, 안전하다는 뜻이 아니다.
"""
from __future__ import annotations

import re
import sys
from pathlib import Path

_TABLES = ("subscriptions", "subscription_checkout_sessions")

_PATTERNS = [
    re.compile(rf'__tablename__\s*=\s*["\']({"|".join(_TABLES)})["\']'),
    re.compile(
        rf'\b(FROM|INTO|UPDATE|JOIN)\s+({"|".join(_TABLES)})\b', re.IGNORECASE
    ),
    re.compile(rf'\bTable\(\s*["\']({"|".join(_TABLES)})["\']'),
]

SCAN_ROOT = "app"


def find_violations(path: Path, label: str | None = None) -> list[str]:
    """단일 파일 스캔 — 위반 라인을 `{label}:{lineno}: {line}` 형태로 반환(label 생략 시 path 그대로)."""
    text = path.read_text(encoding="utf-8")
    label = label or str(path)
    violations: list[str] = []
    for lineno, line in enumerate(text.splitlines(), start=1):
        for pattern in _PATTERNS:
            if pattern.search(line):
                violations.append(f"{label}:{lineno}: {line.strip()}")
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
            "FAIL: legacy subscriptions/subscription_checkout_sessions 테이블이 OSS backend "
            "코드에 재도입됐다 (story #2476 — OSS 정본은 org_subscriptions뿐, legacy는 SaaS "
            "전용 라이브 스키마라 OSS가 건드리면 안 된다):"
        )
        for v in violations:
            print(f"  {v}")
        return 1
    print("OK: legacy subscriptions 테이블 참조 0건 유지")
    return 0


if __name__ == "__main__":
    sys.exit(main())
