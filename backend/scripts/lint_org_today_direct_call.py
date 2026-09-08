"""story #3674(BE 確定, 페드루 PO 確定 2026-09-07) — "오늘"(캘린더 날짜) 계산의
프로세스-로컬/무조건-UTC 직접 호출을 막는다. 3665(#4020)가 `date.today()`(프로세스
로컬 TZ)를 UTC 고정으로 바꿔 "환경마다 다른 오늘"은 닫았지만, 그 UTC 고정 자체가
"조직의 오늘"(org.timezone 인지)을 무시한다 — 이 결함 클래스가 다시 새어 들어오는
걸 막는 가드. 정답은 항상 `app.services.org_time`의 헬퍼(org_today·to_org_date·
org_midnight_utc·org_date_sql)를 org_id/org_timezone과 함께 쓰는 것.

⛔이 lint가 잡는 패턴 5종(backend/app/ 전수, `.py` 파일):
  ① `date.today()`(datetime.date의 today — 프로세스 로컬 TZ, 3665 원 결함)
  ② `utcnow().date()`(datetime.utcnow() 자체가 이미 폐기 예정 API인데다 여전히
     "조직의 오늘"을 무시)
  ③ `now(timezone.utc).date()`(3665가 만든 UTC 고정 — org tz 인지 前 상태)
  ④ `now.date()`(변수에 담긴 "지금 이 순간" 값의 .date() — CHANGES 페드루 PO
     2026-09-07, pageview_counter.py 실물이 이 형이었다: 함수 파라미터로 받은
     `now: datetime`을 그대로 `.date()`해 org tz를 건너뛰었다. ①~③은 "그 자리에서
     즉시 계산"만 잡고 "먼저 변수에 담아 나중에 .date()"는 못 봤던 사각.
  ⑤ `today.date()`(④와 동형 사각, 식별자 이름만 `today` — CHANGES 페드루 PO
     2026-09-07, org_subscription_checkout.py 실물: 함수 파라미터 `today: datetime`
     을 그대로 `.date()`).

⛔이 lint가 «못 잡는» 것: 동적으로 조립된 표현(변수 재할당 뒤 다단계 호출), 이
리터럴 텍스트 패턴이 한 줄 안에 정확히 이어지지 않는 형태, `now`/`today` 아닌
다른 이름으로 담은 변수(④⑤는 식별자 이름이 정확히 그 둘일 때만 잡는다 —
`order.created_at.date()`류(저장된 과거 시각의 날짜 부분을 비교/키잉에 쓰는 것,
"오늘" 계산이 아님)까지 넓히면 오탐이 폭증한다, billing_scheduler.py의 `order.
created_at.date()`·`period_end.date()` 등이 그 예). 새 변수 이름이 나올 때마다
패턴을 추가하는 대신 AST 기반 재작성도 고려할 수 있으나, 지금까지 발견된 자리가
전부 `now`/`today` 두 관례적 이름에 수렴해 텍스트 패턴으로 충분(오탐 방지 우선,
다른 lint_*.py와 동일 원칙).

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
    re.compile(r"\bnow\.date\(\)"),  # ④ — 변수 now(파라미터·지역변수)의 .date().
    re.compile(r"\btoday\.date\(\)"),  # ⑤ — 변수 today(파라미터·지역변수)의 .date().
]


class AllowlistEntry(NamedTuple):
    file: str
    line_content: str
    reason: str
    added_by: str


# story #3674 CHANGES(페드루 PO, 2026-09-07) — billing_scheduler.py의 dunning
# 재시도 케이던스는 결제 정책 문서(pricing-policy-proposal-v1 §12.1)가 정한 절대
# 일수 앵커(D+1..D+grace_days)라 org의 "표시" 시간대와 무관하게 UTC로 결정적이어야
# 한다(디디 분류: 「내부 잡」 — l2_trigger_worker.py의 dedup 버킷과 동형 원칙, 3674
# 그라운딩 ①). 사용자가 화면에서 "보는" 날짜가 아니라 서버 상태기계 내부 계산.
ALLOWLIST: list[AllowlistEntry] = [
    AllowlistEntry(
        file="app/services/billing_scheduler.py",
        line_content="age_days = (now.date() - order.created_at.date()).days",
        reason="dunning 재시도 케이던스(D+1..D+grace_days) — 결제 정책 절대 일수 앵커, 내부 잡·UTC 의도",
        added_by="story #3674 CHANGES(페드루 PO)",
    ),
    AllowlistEntry(
        file="app/services/billing_scheduler.py",
        line_content="already_attempted_today = order.updated_at.date() >= now.date()",
        reason="같은 날 중복 재시도 방지 — dunning 내부 잡·UTC 의도(위와 동일 함수)",
        added_by="story #3674 CHANGES(페드루 PO)",
    ),
    AllowlistEntry(
        file="app/services/billing_scheduler.py",
        line_content="grace_anchor = order.created_at.date() if order is not None else now.date()",
        reason="order 없는 극단 실패 폴백 앵커 — dunning 내부 잡·UTC 의도(order.created_at.date()와 같은 축)",
        added_by="story #3674 CHANGES(페드루 PO)",
    ),
    # story #3674 CHANGES 2회차(페드루 PO, 2026-09-07) — checkout idempotency 키의
    # 날짜 축. 결제 내부 결정적 키(같은 org+offering+"같은 날"에 여러 번 요청해도
    # 같은 order_id로 수렴)라 org의 "표시" 시간대와 무관하게 UTC로 결정적이어야
    # 한다 — billing_scheduler.py의 dunning 케이던스와 동일 축.
    AllowlistEntry(
        file="app/services/org_subscription_checkout.py",
        line_content='return f"checkout:{org_id}:{offering_version_id}:{today.date().isoformat()}"',
        reason="checkout idempotency 키 날짜 축 — 결제 내부 키·UTC 의도",
        added_by="story #3674 CHANGES(페드루 PO)",
    ),
]


def _is_allowed(rel_file: str, line_text: str) -> bool:
    stripped = line_text.strip()
    return any(e.file == rel_file and e.line_content == stripped for e in ALLOWLIST)


def find_violations(path: Path, label: str | None = None) -> list[str]:
    """단일 파일 스캔 — 위반 라인을 `{label}:{lineno}: {line}` 형태로 반환(label 생략 시 path 그대로).

    story #3674 CHANGES(페드루 PO) — 줄 전체가 주석(strip() 결과가 `#`로 시작)이면
    스킵한다: 이 lint가 잡는 패턴을 "설명하는" docstring/주석(이 스크립트 자신의
    상단 docstring 포함, 실제로 billing_scheduler.py:630에서 재현됨 — 이 처방을 적은
    주석 자체가 오탐이었다)까지 코드로 오인하면 매번 문장을 우회 표현으로 돌려
    써야 하는 부담이 생긴다. 실제 호출 코드만 본다(다른 lint_*.py의 기존 한계
    — 문자열 리터럴 안 언급은 여전히 못 잡음, 그건 애초에 실행되는 코드가 아니라
    이 lint의 관심사 밖)."""
    text = path.read_text(encoding="utf-8")
    label = label or str(path)
    violations: list[str] = []
    for lineno, line in enumerate(text.splitlines(), start=1):
        if line.strip().startswith("#"):
            continue
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
