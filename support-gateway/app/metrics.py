"""story #3264(지원v1·6방어·계측) AC3 — 문의 해결율/에스컬레이션율 집계.

**"턴" 정의**: role='agent'인 SupportMessage 1행 = 1턴. app/interaction.py::handle_turn의
세 경로(분류기 우회·비용상한 초과·정상 Interaction 호출) 전부가 반환 전에 정확히 1개의
agent 메시지를 만든다(실측 확認 — 예외 없이 저장) — 신뢰할 수 있는 분모.

**"에스컬레이션된 턴" 정의**: 그 시간창 안의 SupportEscalation 행 수. app/interaction.py의
모든 에스컬레이션 경로(분류기 판정·비용상한·escalate 도구 실호출·no_fiction_guard·
knowledge_fiction_guard)가 정확히 1턴당 최대 1개의 SupportEscalation을 만든다(가드들은
`if not escalated`로 게이팅돼 한 턴에 중복 에스컬레이션이 안 남 — 구조상 보장). 따라서
"SupportEscalation 개수 / agent 메시지 개수"가 곧 에스컬레이션율이다.

v1은 org 전체(선택적 org_id 필터) × 시간창 단위 집계만 — 대화별 세분화는 후속 스코프."""
from __future__ import annotations

import uuid
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone

from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.models import SupportEscalation, SupportMessage


@dataclass(frozen=True)
class ResolutionMetrics:
    total_turns: int
    escalated_turns: int
    resolved_turns: int
    # None = 표본 0(0/0을 "0% 해결"로 오판하지 않게 «측정 불가»와 구분 — 조용한 0 강등 금지
    # 원칙, Blueprint §4.3과 동형 정신).
    resolution_rate: float | None
    escalation_rate: float | None


async def compute_resolution_metrics(
    db: AsyncSession, *, since: datetime | None = None, org_id: uuid.UUID | None = None
) -> ResolutionMetrics:
    since = since or (datetime.now(timezone.utc) - timedelta(days=7))

    turns_query = select(func.count()).select_from(SupportMessage).where(
        SupportMessage.role == "agent", SupportMessage.created_at >= since
    )
    escalations_query = select(func.count()).select_from(SupportEscalation).where(
        SupportEscalation.created_at >= since
    )
    if org_id is not None:
        turns_query = turns_query.where(SupportMessage.org_id == org_id)
        escalations_query = escalations_query.where(SupportEscalation.org_id == org_id)

    total_turns = (await db.execute(turns_query)).scalar_one()
    escalated_turns = (await db.execute(escalations_query)).scalar_one()
    # 안전 클램프 — 정의상 escalated_turns <= total_turns여야 하지만(구조적 보장), 시간창
    # 경계에 걸친 레이스(에스컬레이션은 창 안·그 턴의 agent 메시지는 창 밖 같은 극단 케이스)
    # 로 음수 resolved_turns가 나오는 걸 막는다.
    escalated_turns = min(escalated_turns, total_turns)
    resolved_turns = total_turns - escalated_turns

    if total_turns == 0:
        return ResolutionMetrics(
            total_turns=0, escalated_turns=0, resolved_turns=0, resolution_rate=None, escalation_rate=None
        )
    return ResolutionMetrics(
        total_turns=total_turns,
        escalated_turns=escalated_turns,
        resolved_turns=resolved_turns,
        resolution_rate=resolved_turns / total_turns,
        escalation_rate=escalated_turns / total_turns,
    )
