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


async def _org_gate(db: AsyncSession, *, org_id: uuid.UUID, gate_id: uuid.UUID) -> Gate | None:
    """까디르 4621 codex P1 — 명령이 가리키는 게이트는 **명령의 조직** 것만 쓴다(다른 조직 게이트 id가 실려도 그 승인자에게
    새지 않게 · 4617과 같은 부류)."""
    return (await db.execute(select(Gate).where(Gate.id == gate_id, Gate.org_id == org_id))).scalar_one_or_none()


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
        gate = await _org_gate(db, org_id=command.org_id, gate_id=command.gate_id)
        facts = (gate.neutral_facts or {}) if gate is not None else {}
        key, stage = facts.get("triggered_by_event"), facts.get("stage")
        if gate is None or not key or not stage or await _definition(db, org_id=command.org_id, key=key) is None:
            return None
        return RecipePublishFailureContext(kind, key, stage, gate.work_item_type, gate.work_item_id, _approver(gate))

    if kind == "channel_post":
        from app.models.channel_post_version import ChannelPostVersion
        from app.services.channel_posts import get_channel_post_draft, resolve_recipe_context_for_scheduled_publication

        # 판(version) 행엔 조직 칸이 없다 — 바로 다음의 초안 조회가 명령의 조직으로 묶여, 다른 조직 판이면 여기서 끊긴다.
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

        gate = await _org_gate(db, org_id=command.org_id, gate_id=command.gate_id)
        if gate is None:
            return None
        ctx = await resolve_site_post_recipe_context(
            db, org_id=command.org_id, work_item_type=gate.work_item_type, work_item_id=gate.work_item_id,
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
    """승인자 ∪ 요청 stage에 바인딩된 에이전트. 둘 다 없으면 빈 집합(호출부가 경고). 둘 다 **이 조직의 멤버**일 때만 받는다
    (까디르 4621 codex P1 — 게이트 행의 승인자 id도 멤버십을 확인한다)."""
    from app.models.team import TeamMember
    from app.services.event_routing_resolver import _bound_member_for_stage, _resolve_work_item_project_id
    from app.services.member_resolver import resolve_member_identity

    recipients: set[uuid.UUID] = set()
    if ctx.approver_id is not None and await resolve_member_identity(ctx.approver_id, org_id, db) is not None:
        recipients.add(ctx.approver_id)
    project_id = await _resolve_work_item_project_id(
        db, org_id=org_id, payload={"work_item_type": ctx.work_item_type, "work_item_id": str(ctx.work_item_id)},
    )
    bound = await _bound_member_for_stage(
        db, org_id=org_id, project_id=project_id, definition_key=ctx.definition_key, stage=ctx.request_stage,
    )
    if bound is not None and (await db.execute(
        select(TeamMember.id).where(TeamMember.id == bound, TeamMember.org_id == org_id, TeamMember.type == "agent")
    )).first() is not None:
        recipients.add(bound)
    return recipients


RECIPE_PUBLISH_FAILED_EVENT_KEY = "preset.recipe.publish_failed"
# 사람이 손대야 이어지는 멈춤만 알린다(PO 08:51Z) — 표식은 `apply_command_failure`가 dead_letter · 연결 blocked 전이에서만
# 세운다. 재시도 대기(pending)와 조직 일시정지 blocked(해제하면 서버가 스스로 재큐)는 표식이 없어 통지 0.


async def _deliver_one_stop_notice(side: AsyncSession, command_id: uuid.UUID) -> bool:
    """한 명령의 멈춤 통지 — 표식을 잠그고(`FOR UPDATE SKIP LOCKED` · 겹친 워커는 건너뛴다) 통지를 내고 `sent`로 바꾼다. 둘이 같은
    트랜잭션이라(`publish_preset_event`는 호출자 트랜잭션에 참여 · 배달은 커밋 뒤) 커밋되면 둘 다, 실패하면 둘 다 없다 — 표식이
    `pending`으로 남아 다음 틱이 다시. 레시피 밖 발행이면 보낼 것이 없어 표식만 비운다. 통지를 냈으면 True."""
    import logging

    from app.routers.events import publish_preset_event
    from app.services.publication_command import STOP_NOTICE_PENDING, STOP_NOTICE_SENT, awaits_stop_notice

    row = (await side.execute(
        select(PublicationCommand)
        .where(PublicationCommand.id == command_id, PublicationCommand.stop_notice_state == STOP_NOTICE_PENDING)
        .with_for_update(skip_locked=True)
    )).scalar_one_or_none()
    if row is None:
        return False
    # 까디르 4621 델타 codex ①(PO 14:23Z) — 표식이 선 뒤 멈춤에서 벗어난 행(취소 · voided · 완료 · 재시도 뒤 pending 등)은 보낼
    # 멈춤이 아니다. 표식을 세운 쪽과 같은 판정으로 보고 비운다 — 쓰는 곳마다 비우기를 흩지 않고 여기 한 곳에서 막는다(안
    # 그러면 `stop_kind`가 이벤트 스키마 enum 밖이라 롤백 → 틱마다 재시도하는 독 행이 된다).
    if not awaits_stop_notice(row.status, row.failure_kind):
        row.stop_notice_state = None
        return False
    ctx = await resolve_recipe_publish_failure_context(side, row)
    if ctx is None:
        row.stop_notice_state = None
        return False
    if not await recipe_publish_failure_recipients(side, org_id=row.org_id, ctx=ctx):
        logging.getLogger(__name__).warning(
            "recipe publish %s: no approver and no bound agent — 0 recipients (command=%s definition=%s stage=%s)",
            row.status, command_id, ctx.definition_key, ctx.request_stage,
        )
    await publish_preset_event(side, row.org_id, RECIPE_PUBLISH_FAILED_EVENT_KEY, {
        "work_item_type": ctx.work_item_type,
        "work_item_id": str(ctx.work_item_id),
        "definition_key": ctx.definition_key,
        "stage": ctx.request_stage,
        "command_id": str(command_id),
        "content_kind": ctx.kind,
        "stop_kind": row.status,
        "reason_code": row.reason_code,
        "failure_kind": row.failure_kind,
    })
    row.stop_notice_state = STOP_NOTICE_SENT
    return True


async def deliver_pending_stop_notices(db: AsyncSession, *, limit: int = 50) -> int:
    """워커 틱 끝에 부른다(까디르 4621 codex P2 · PO 12:38Z). `stop_notice_state = pending`인 명령마다 **자기 세션 · 자기
    트랜잭션**으로 `_deliver_one_stop_notice`를 돈다 — 한 건이 실패해도 워커 세션 · 다른 건은 그대로(격리 세션의 rollback이
    배치의 ORM 객체를 만료시키지 않게). 표식은 `apply_command_failure`가 전이와 같은 커밋에 세운다 — 전이 커밋 뒤 통지 전에
    프로세스가 죽어도 다음 틱이 줍는다. 보낸 통지 수를 돌려준다."""
    from app.services.isolated_side_effect import run_side_effect_in_own_session
    from app.services.publication_command import STOP_NOTICE_PENDING

    ids = (await db.execute(
        select(PublicationCommand.id)
        .where(PublicationCommand.stop_notice_state == STOP_NOTICE_PENDING)
        .order_by(PublicationCommand.updated_at.asc())
        .limit(limit)
    )).scalars().all()
    await db.commit()  # 읽기만 한 트랜잭션을 닫는다(아래는 전부 별도 세션).
    sent = 0
    for command_id in ids:
        outcome: list[bool] = []

        async def _work(side: AsyncSession, command_id: uuid.UUID = command_id) -> None:
            outcome.append(await _deliver_one_stop_notice(side, command_id))

        if await run_side_effect_in_own_session(db, _work, describe=f"recipe publish stop notice command={command_id}"):
            if outcome[0]:
                sent += 1
        else:
            # 까디르 4621 델타 codex ③ — 실패한 행은 롤백돼 `updated_at`이 그대로라 `order_by(updated_at)`의 머리에 계속 남아
            # 뒤의 새 표식을 굶길 수 있다. 줄 뒤로 보낸다(표식은 pending 그대로 · 다음 틱에 다시).
            await _requeue_failed_stop_notice(db, command_id)
    return sent


async def _requeue_failed_stop_notice(db: AsyncSession, command_id: uuid.UUID) -> None:
    from sqlalchemy import func, update

    from app.services.isolated_side_effect import run_side_effect_in_own_session

    async def _touch(side: AsyncSession) -> None:
        await side.execute(
            update(PublicationCommand).where(PublicationCommand.id == command_id).values(updated_at=func.now())
        )

    await run_side_effect_in_own_session(db, _touch, describe=f"recipe publish stop notice requeue command={command_id}")
