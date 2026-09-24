"""story #4258 — 레시피 문맥의 서버 비동기 발행이 사람 재시도 대기(`dead_letter`)로 끝났을 때, 그 실패를 누구에게 알릴지.

비동기 발행 경로는 셋이고(워커 `process_due_publication_commands`), 성공이면 레시피 다음 단계를 서버가 낸다. 실패면 예전엔
레시피 쪽 통지가 0이었다 — 에이전트는 «할 일 없음»을 본 채 기다리고, 재시도는 사람 전용인데 사람도 몰랐다.

- 뉴스레터 발송(`newsletter_send`): 명령의 게이트 = 발송 게이트 = 레시피 게이트(`neutral_facts.triggered_by_event` ·
  `stage` = 발송 요청 단계).
- 채널 게시(`channel_post`): 명령의 게이트 = 연결 스코프 게이트(레시피 게이트 승인으로 자동 충족). 사람이 승인한 쪽은
  레시피 게이트(스코프 없음)라 `resolve_recipe_context_for_scheduled_publication`으로 찾는다.
- 외부 블로그(`site_post`): 명령의 게이트 = 초안 게이트(사람이 승인한 게이트 그 자체). 레시피 회차 판정은
  `resolve_site_post_recipe_context`(자사 블로그 자동 발행 · 승인 알림과 같은 판정).

수신자(PO 07:19Z · 4255와 같은 규칙) = 그 발행을 연 게이트를 **실제로 승인한 사람**(resolver · 없으면 지정 승인자) ∪
요청 stage에 바인딩된 **에이전트**. 사람 승인 stage의 바인딩으로 사람을 찾지 않는다(마케팅 적용 창은 그 자리를 싣지 않는다).
"""
from __future__ import annotations

import uuid
from dataclasses import dataclass

from sqlalchemy import or_, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.gate import Gate
from app.models.publication_command import PublicationCommand


@dataclass(frozen=True)
class RecipePublishFailureContext:
    kind: str  # newsletter_send · channel_post · site_post
    definition_key: str
    request_stage: str  # 발행을 요청한(= 서버 발행 바로 앞) 레시피 stage
    work_item_type: str
    work_item_id: uuid.UUID
    approver_id: uuid.UUID | None


def _approver(gate: Gate) -> uuid.UUID | None:
    return gate.resolver_id or gate.designated_approver_id


async def _definition(db: AsyncSession, *, org_id: uuid.UUID, key: str):
    from app.models.event_definition import EventDefinition

    return (await db.execute(
        select(EventDefinition).where(
            EventDefinition.key == key, EventDefinition.enabled.is_(True),
            or_(EventDefinition.org_id == org_id, EventDefinition.org_id.is_(None)),
        ).order_by(EventDefinition.org_id.is_(None)).limit(1)
    )).scalars().first()


def _stage_before(definition, stage: str) -> str | None:
    enum = ((definition.payload_schema.get("properties") or {}).get("stage") or {}).get("enum") or []
    if stage not in enum:
        return None
    idx = enum.index(stage)
    return enum[idx - 1] if idx > 0 else None


async def resolve_recipe_publish_failure_context(
    db: AsyncSession, command: PublicationCommand,
) -> RecipePublishFailureContext | None:
    """레시피 문맥이면 그 실패의 (정의 · 요청 stage · 작업 항목 · 승인자). 레시피 밖 발행이거나 판정이 안 서면 None(추측 0)."""
    kind = command.content_kind or "channel_post"
    if kind == "newsletter_send":
        gate = await db.get(Gate, command.gate_id)
        facts = (gate.neutral_facts or {}) if gate is not None else {}
        key, stage = facts.get("triggered_by_event"), facts.get("stage")
        if gate is None or not key or not stage or await _definition(db, org_id=command.org_id, key=key) is None:
            return None
        return RecipePublishFailureContext(kind, key, stage, gate.work_item_type, gate.work_item_id, _approver(gate))

    if kind == "channel_post":
        from app.models.channel_post_version import ChannelPostVersion
        from app.services.channel_posts import get_channel_post_draft, resolve_recipe_context_for_scheduled_publication

        version = (await db.execute(
            select(ChannelPostVersion).where(ChannelPostVersion.id == command.approved_version)
        )).scalar_one_or_none()
        draft = (
            await get_channel_post_draft(db, org_id=command.org_id, draft_id=version.draft_id) if version is not None else None
        )
        if draft is None:
            return None
        ctx = await resolve_recipe_context_for_scheduled_publication(
            db, org_id=command.org_id, work_item_id=draft.work_item_id, connection_id=draft.connection_id,
        )
        if ctx is None:
            return None
        recipe_gate, key, _next_stage = ctx
        stage = (recipe_gate.neutral_facts or {}).get("stage")
        if not stage:
            return None
        return RecipePublishFailureContext(
            kind, key, stage, recipe_gate.work_item_type, recipe_gate.work_item_id, _approver(recipe_gate),
        )

    if kind == "site_post":
        from app.routers.events import resolve_site_post_recipe_context

        gate = await db.get(Gate, command.gate_id)
        if gate is None:
            return None
        ctx = await resolve_site_post_recipe_context(
            db, org_id=gate.org_id, work_item_type=gate.work_item_type, work_item_id=gate.work_item_id,
            draft_id=(gate.neutral_facts or {}).get("draft_id"),
        )
        if ctx is None:
            return None
        key, auto_stage = ctx
        definition = await _definition(db, org_id=command.org_id, key=key)
        stage = _stage_before(definition, auto_stage) if definition is not None else None
        if not stage:
            return None
        return RecipePublishFailureContext(kind, key, stage, gate.work_item_type, gate.work_item_id, _approver(gate))

    return None


async def recipe_publish_failure_recipients(
    db: AsyncSession, *, org_id: uuid.UUID, ctx: RecipePublishFailureContext,
) -> set[uuid.UUID]:
    """승인자 ∪ 요청 stage에 바인딩된 에이전트. 둘 다 없으면 빈 집합(호출부가 경고)."""
    from app.models.team import TeamMember
    from app.services.event_routing_resolver import _bound_member_for_stage, _resolve_work_item_project_id

    recipients: set[uuid.UUID] = set()
    if ctx.approver_id is not None:
        recipients.add(ctx.approver_id)
    project_id = await _resolve_work_item_project_id(
        db, org_id=org_id, payload={"work_item_type": ctx.work_item_type, "work_item_id": str(ctx.work_item_id)},
    )
    bound = await _bound_member_for_stage(
        db, org_id=org_id, project_id=project_id, definition_key=ctx.definition_key, stage=ctx.request_stage,
    )
    if bound is not None and (await db.execute(
        select(TeamMember.id).where(TeamMember.id == bound, TeamMember.type == "agent")
    )).first() is not None:
        recipients.add(bound)
    return recipients


RECIPE_PUBLISH_FAILED_EVENT_KEY = "preset.recipe.publish_failed"
# 사람이 손대야 이어지는 멈춤만 알린다(PO 08:51Z). 재시도 대기(pending · next_attempt_at)는 아직 도는 중이라 0.
STOPPED_STATUSES = frozenset({"dead_letter", "blocked"})


async def notify_recipe_publish_stopped(db: AsyncSession, command: PublicationCommand) -> None:
    """워커가 이 명령의 이번 틱 결과(`dead_letter` · `blocked`)를 **커밋한 뒤** 부른다. 레시피 문맥이면 실패 통지 이벤트 1을
    격리 세션에서 낸다(워커 세션은 건드리지 않는다 · 실패해도 발행 기록은 그대로). 레시피 밖 발행이면 아무것도 안 한다."""
    import logging

    from app.services.isolated_side_effect import run_side_effect_in_own_session

    if command.status not in STOPPED_STATUSES:
        return
    # blocked 중 조직 일시정지(`failure_kind = paused`)는 해제하면 서버가 스스로 다시 큐에 올린다(external_publish_pause
    # `requeue_paused_commands_of_unpaused_orgs`) — 사람 손이 필요한 멈춤이 아니라 통지 0. 연결이 끊긴 blocked는 재연결
    # 뒤에도 자동으로 이어지지 않아(재연결 경로에 명령 재큐 없음) 사람 재시도가 필요하다.
    if command.status == "blocked" and command.failure_kind != "connection":
        return
    command_id, org_id, stop_kind = command.id, command.org_id, command.status

    async def _work(side: AsyncSession) -> None:
        from app.routers.events import publish_preset_event

        row = await side.get(PublicationCommand, command_id)
        if row is None:
            return
        ctx = await resolve_recipe_publish_failure_context(side, row)
        if ctx is None:
            return
        if not await recipe_publish_failure_recipients(side, org_id=org_id, ctx=ctx):
            logging.getLogger(__name__).warning(
                "recipe publish %s: no approver and no bound agent — 0 recipients (command=%s definition=%s stage=%s)",
                stop_kind, command_id, ctx.definition_key, ctx.request_stage,
            )
        await publish_preset_event(side, org_id, RECIPE_PUBLISH_FAILED_EVENT_KEY, {
            "work_item_type": ctx.work_item_type,
            "work_item_id": str(ctx.work_item_id),
            "definition_key": ctx.definition_key,
            "stage": ctx.request_stage,
            "command_id": str(command_id),
            "content_kind": ctx.kind,
            "stop_kind": stop_kind,
            "reason_code": row.reason_code,
            "failure_kind": row.failure_kind,
        })

    await run_side_effect_in_own_session(db, _work, describe=f"recipe publish {stop_kind} notice command={command_id}")
