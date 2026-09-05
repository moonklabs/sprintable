"""story #3498(Phase2·마케팅운영, 페드루 PO 決定 2026-09-05) — 생성 비용 한도(크레딧
게이트). 블루프린트 v3 §2 「생성 비용 한도」·§PO-3 댄 걸린 자리 4·10.

잔량은 저장하지 않고 매번 계산한다(PO 決定②) — Sprintable 결제 원장(lab_credit_minor·
billing_ledger)과 무접촉이다: 생성 비용은 고객이 자기 AI 공급자에 쓰는 돈이라 조직의
«정책값»(`org_content_rules.rules.generation_budget`)일 뿐이다. `limit_minor`에서
evidence(type=metric·payload.kind=generation_cost·기간 내)의 cost_minor 합을 뺀 값이
잔량이다."""
from __future__ import annotations

import uuid
from datetime import datetime, timezone
from typing import Any

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.evidence import Evidence
from app.services.content_rules import get_org_content_rules

_GENERATION_COST_KIND = "generation_cost"
_SUPPORTED_PERIODS = frozenset({"month"})


class GenerationBudgetExceededError(Exception):
    """AC2·AC4의 공용 거부 신호 — submit 시점·발행 직전 재검사 둘 다 이 예외 하나로
    통일한다(호출부 라우터가 각자 상황에 맞는 HTTP status로 감싼다). detail 4값은
    story 確定 그대로(limit·spent·estimated·remaining)."""

    def __init__(self, *, limit_minor: int, spent_minor: int, estimated_cost_minor: int, remaining_minor: int):
        self.limit_minor = limit_minor
        self.spent_minor = spent_minor
        self.estimated_cost_minor = estimated_cost_minor
        self.remaining_minor = remaining_minor
        super().__init__(
            f"generation budget exceeded: limit={limit_minor} spent={spent_minor} "
            f"estimated={estimated_cost_minor} remaining={remaining_minor}"
        )


def _period_window(period: str, now: datetime) -> tuple[datetime, datetime]:
    """"month"만 지원(story 確定 — period 값은 지금 이거 하나, 다른 값은 규칙 저장
    시점에 이미 422로 막힌다·이 함수는 방어적으로만 raise). UTC 달력 월 경계 —
    evidence.created_at 자체가 UTC라 그 축에 그대로 맞춘다(org timezone 무관)."""
    if period not in _SUPPORTED_PERIODS:
        raise ValueError(f"unsupported generation_budget period: {period}")
    start = now.replace(hour=0, minute=0, second=0, microsecond=0, day=1)
    end = start.replace(year=start.year + 1, month=1) if start.month == 12 else start.replace(month=start.month + 1)
    return start, end


async def compute_generation_budget_status(
    db: AsyncSession, *, org_id: uuid.UUID, now: datetime | None = None,
) -> dict[str, Any] | None:
    """규칙 자체가 없으면(«규칙 없음») None — 호출자는 이걸 "검사 없음"으로 읽는다.
    「규칙 없음」과 「0 한도(정지)」를 가르는 유일한 신호가 이 반환값이다: None=규칙
    없음(검사 스킵) · dict(limit_minor=0, ...)=정지(0보다 큰 어떤 추정치도 거부)."""
    row = await get_org_content_rules(db, org_id=org_id)
    if row is None:
        return None
    budget = (row.rules or {}).get("generation_budget")
    if not budget:
        return None
    limit_minor = int(budget["limit_minor"])
    currency = budget.get("currency", "KRW")
    period = budget.get("period", "month")

    now = now or datetime.now(timezone.utc)
    start, end = _period_window(period, now)

    rows = (await db.execute(
        select(Evidence.payload).where(
            Evidence.org_id == org_id, Evidence.type == "metric",
            Evidence.payload["kind"].astext == _GENERATION_COST_KIND,
            Evidence.created_at >= start, Evidence.created_at < end,
        )
    )).scalars().all()
    spent_minor = 0
    for payload in rows:
        try:
            cost = int((payload or {}).get("cost_minor") or 0)
        except (TypeError, ValueError):
            continue  # 기형 payload(비-숫자 cost_minor) — 지출로 안 잡는다(관대한 reader).
        # 페드루 PO REQUIRED(2026-09-05, PR#3847 리뷰①) — 두 겹 방어의 두 번째 겹.
        # 쓰기 시점(evidence.py::create_evidence)이 이미 음수를 422로 막지만, 이
        # 합산 자체도 음수를 무시한다 — 어느 한쪽이 우회돼도(예: 과거 데이터·내부
        # 서비스 직접 insert) 음수 cost로 잔량을 부풀려 한도를 뚫을 수 없다.
        if cost < 0:
            continue
        spent_minor += cost

    return {
        "limit_minor": limit_minor, "currency": currency, "period": period,
        # story #3498 조각①(미르코 FE 그라운딩 후속, 페드루 PO 決定) — GET /generation-
        # budget 조회 응답이 그대로 쓰는 경계값(FE가 "이번 기간" 문구를 조립할 수
        # 있게, 서버가 계산한 값 그대로 — FE 재조립 0).
        "period_start": start, "period_end": end,
        "spent_minor": spent_minor, "remaining_minor": limit_minor - spent_minor,
    }


async def check_generation_budget_or_raise(
    db: AsyncSession, *, org_id: uuid.UUID, estimated_cost_minor: int | None, now: datetime | None = None,
) -> None:
    """AC2·AC4의 공용 판정 지점 — submit 시점·발행 직전 둘 다 이 함수 하나를 부른다
    (story #3414/#3478의 "판정 지점 하나" 관례 그대로). estimated_cost_minor가 None이면
    검사 자체를 안 한다(호출자가 이 축을 아예 안 실었다는 뜻 — AC2 "미설정이면 통과")."""
    if estimated_cost_minor is None:
        return
    status = await compute_generation_budget_status(db, org_id=org_id, now=now)
    if status is None:
        return
    if estimated_cost_minor > status["remaining_minor"]:
        raise GenerationBudgetExceededError(
            limit_minor=status["limit_minor"], spent_minor=status["spent_minor"],
            estimated_cost_minor=estimated_cost_minor, remaining_minor=status["remaining_minor"],
        )
