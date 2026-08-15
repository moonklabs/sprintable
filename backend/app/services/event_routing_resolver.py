"""story #2633 — routing(상신선·전파선) 선언을 실제 member_id 집합으로 푸는 해석기.

#2632의 event_definition_registry.validate_event_routing()이 등록 시점에 두 부류(payload_
field/server_derived) 계약을 강제했다 — 이 모듈은 그 계약을 **소비**하는 쪽(발행 시점)이다.
kind="server_derived"의 target은 SERVER_DERIVED_TARGETS 닫힌 어휘 안에서만 존재하므로, 여기
resolver 매핑도 정확히 그 어휘와 1:1이어야 한다(어휘에 있는데 resolver가 모르면 등록은
통과했는데 발행이 조용히 빈 집합을 내는 결함 — 아래 _SERVER_DERIVED_RESOLVERS가 SERVER_
DERIVED_TARGETS 전체를 커버하는지 모듈 로드 시점에 assert로 고정한다)."""
from __future__ import annotations

import logging
import uuid

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.services.event_definition_registry import SERVER_DERIVED_TARGETS

logger = logging.getLogger(__name__)


class MissingRoutingPayloadFieldError(ValueError):
    """kind=payload_field인데 그 member_id_field가 payload에 없거나 값이 비었음 — 조용히
    빈 집합으로 넘기지 않고 발행 시점에 명시 오류(story #2633 AC4 "조용한 유실 금지")."""


async def _resolve_work_item_stakeholders(
    db: AsyncSession, *, org_id: uuid.UUID, payload: dict,
) -> set[uuid.UUID]:
    """work_item_type/work_item_id → 그 작업의 이해관계자(담당자·human owner·복수 assignee).
    타입별 필드가 제각각이라(story/task/goal 전부 다른 모델) 여기서 타입별 분기 — 코드베이스에
    범용 헬퍼가 없어 이 스토리에서 신설(그라운딩 확認, #2620/#2617류 재사용 대상 없음)."""
    work_item_type = payload.get("work_item_type")
    work_item_id_raw = payload.get("work_item_id")
    if not work_item_type or not work_item_id_raw:
        return set()
    work_item_id = uuid.UUID(work_item_id_raw)

    if work_item_type == "story":
        from app.models.pm import Story
        from app.models.story_assignee import StoryAssignee

        row = (await db.execute(
            select(Story.assignee_id, Story.human_owner_member_id).where(
                Story.id == work_item_id, Story.org_id == org_id,
            )
        )).one_or_none()
        ids: set[uuid.UUID] = set()
        if row is not None:
            ids |= {m for m in row if m is not None}
        extra = (await db.execute(
            select(StoryAssignee.member_id).where(StoryAssignee.story_id == work_item_id)
        )).scalars().all()
        ids |= set(extra)
        return ids

    if work_item_type == "task":
        from app.models.pm import Task

        assignee = (await db.execute(
            select(Task.assignee_id).where(Task.id == work_item_id, Task.org_id == org_id)
        )).scalar_one_or_none()
        return {assignee} if assignee else set()

    if work_item_type in ("goal", "epic"):
        from app.models.pm import Goal

        assignee = (await db.execute(
            select(Goal.assignee_id).where(Goal.id == work_item_id, Goal.org_id == org_id)
        )).scalar_one_or_none()
        return {assignee} if assignee else set()

    # 미지원 work_item_type — fail-open(빈 집합)·경고 로그만. 발행 자체를 막지 않는다(전파선
    # 해석 실패가 escalation까지 막으면 안 된다는 게 이 함수의 실패 정책 — best-effort).
    logger.warning(
        "event_routing_resolver: unsupported work_item_type=%s for work_item_stakeholders",
        work_item_type,
    )
    return set()


async def _resolve_goal_owner(db: AsyncSession, *, org_id: uuid.UUID, payload: dict) -> set[uuid.UUID]:
    from app.models.pm import Goal

    goal_id_raw = payload.get("goal_id")
    if not goal_id_raw:
        return set()
    assignee = (await db.execute(
        select(Goal.assignee_id).where(Goal.id == uuid.UUID(goal_id_raw), Goal.org_id == org_id)
    )).scalar_one_or_none()
    return {assignee} if assignee else set()


async def _resolve_none(db: AsyncSession, *, org_id: uuid.UUID, payload: dict) -> set[uuid.UUID]:  # noqa: ARG001
    return set()


# SERVER_DERIVED_TARGETS(event_definition_registry.py) 전체를 커버해야 한다 — 모듈 로드
# 시점에 어긋나면 즉시 ImportError로 드러나게(운영 중 조용한 미해석 대신).
_SERVER_DERIVED_RESOLVERS = {
    "none": _resolve_none,
    "work_item_stakeholders": _resolve_work_item_stakeholders,
    "goal_owner": _resolve_goal_owner,
}
assert set(_SERVER_DERIVED_RESOLVERS) == set(SERVER_DERIVED_TARGETS), (
    "event_routing_resolver의 server_derived resolver 어휘가 "
    "event_definition_registry.SERVER_DERIVED_TARGETS와 어긋남"
)


async def resolve_routing_leg(
    leg: dict, *, payload: dict, org_id: uuid.UUID, db: AsyncSession,
) -> set[uuid.UUID]:
    """routing.escalation 또는 routing.broadcast 한 leg를 실제 member_id 집합으로. leg는
    이미 validate_event_routing()을 통과한 정의에서 온 것을 전제(등록 시점 계약 검증 완료 —
    여기서 kind/target 모양을 다시 의심하지 않는다, 값 해석만)."""
    if leg["kind"] == "payload_field":
        field = leg["member_id_field"]
        value = payload.get(field)
        if not value:
            raise MissingRoutingPayloadFieldError(
                f"routing이 요구하는 payload.{field}가 없거나 비었습니다."
            )
        return {uuid.UUID(value)}

    resolver = _SERVER_DERIVED_RESOLVERS[leg["target"]]
    return await resolver(db, org_id=org_id, payload=payload)
