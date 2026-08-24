"""emit_story_status_changed의 side-effect 격리(best-effort) 단위 테스트.

notif/webhook/L2 등 side-effect가 raise해도 status 전이 흐름으로 전파되지 않아야 한다(gate 경로는
flush後 commit前 emit이라 side-effect 실패가 story done을 롤백하면 안 됨).
"""
from __future__ import annotations

import uuid
from contextlib import ExitStack
from types import SimpleNamespace
from unittest.mock import AsyncMock, patch

import pytest

from app.services.story_status_events import emit_story_status_changed


@pytest.fixture
def anyio_backend():
    return "asyncio"


def _story():
    return SimpleNamespace(
        id=uuid.uuid4(), epic_id=None, title="S", priority="low",
        project_id=uuid.uuid4(), status="done", assignee_id=uuid.uuid4(),
    )


def _base_patches(stack: ExitStack, *, notif=None, webhook=None, l2=None):
    stack.enter_context(patch("app.services.webhook_dispatch.fire_webhooks",
                              webhook or AsyncMock()))
    stack.enter_context(patch("app.services.workflow_pipeline.process_event",
                              l2 or AsyncMock()))
    stack.enter_context(patch("app.services.notification_dispatch.dispatch_notification",
                              notif or AsyncMock()))
    stack.enter_context(patch("app.services.member_resolver.canonicalize_member_id",
                              AsyncMock(return_value=uuid.uuid4())))


@pytest.mark.anyio
async def test_dispatch_notification_raise_does_not_propagate():
    # 핵심: dispatch_notification이 raise해도 emit이 예외를 전파하지 않는다(전이 롤백 방지).
    notif = AsyncMock(side_effect=RuntimeError("notif down"))
    with ExitStack() as stack:
        _base_patches(stack, notif=notif)
        await emit_story_status_changed(
            AsyncMock(), uuid.uuid4(), _story(), "in-review",
            actor_id=uuid.uuid4(), actor_type="human",
        )  # 예외 없이 반환.
    notif.assert_awaited_once()  # 시도는 했고(격리로 삼킴).


@pytest.mark.anyio
async def test_webhook_and_l2_raise_do_not_propagate():
    with ExitStack() as stack:
        _base_patches(
            stack,
            webhook=AsyncMock(side_effect=RuntimeError("wh down")),
            l2=AsyncMock(side_effect=RuntimeError("l2 down")),
        )
        await emit_story_status_changed(
            AsyncMock(), uuid.uuid4(), _story(), "in-review",
            actor_id=uuid.uuid4(), actor_type="human",
        )  # 예외 없이 반환.


@pytest.mark.anyio
async def test_noop_when_status_unchanged():
    # old==new면 어떤 side-effect도 발화 안 함.
    notif = AsyncMock()
    story = _story()
    with ExitStack() as stack:
        _base_patches(stack, notif=notif)
        await emit_story_status_changed(
            AsyncMock(), uuid.uuid4(), story, story.status, actor_id=uuid.uuid4(),
        )
    notif.assert_not_awaited()


# ── story #2173(2026-07-24) — 나머지 두 side-effect(SSE push·trust_pipeline)도 격리되는지
#    커버리지 보강. 이 파일 전체가 story_status_events.py 상단 docstring이 선언한 "예외
#    전파 0" 계약의 pin — update_story_status(단건)가 emit을 try/except 없이 부르는 것과
#    bulk_update_stories의 item별 try/except가 (emit 신뢰성이 아니라 다건성 때문에) 우연이
#    아니라는 근거가 이 계약이다(app/routers/stories.py 두 콜사이트 주석 참조). ──────────
@pytest.mark.anyio
async def test_sse_push_raise_does_not_propagate():
    with ExitStack() as stack:
        _base_patches(stack)
        stack.enter_context(patch(
            "app.services.project_auth.project_accessible_member_ids",
            AsyncMock(side_effect=RuntimeError("sse down")),
        ))
        await emit_story_status_changed(
            AsyncMock(), uuid.uuid4(), _story(), "in-review",
            actor_id=uuid.uuid4(), actor_type="human",
        )  # 예외 없이 반환.


@pytest.mark.anyio
async def test_trust_pipeline_raise_does_not_propagate():
    with ExitStack() as stack:
        _base_patches(stack)
        stack.enter_context(patch(
            "app.services.trust_pipeline.emit_on_story_status_change",
            AsyncMock(side_effect=RuntimeError("trust pipeline down")),
        ))
        await emit_story_status_changed(
            AsyncMock(), uuid.uuid4(), _story(), "in-review",
            actor_id=uuid.uuid4(), actor_type="human",
        )  # 예외 없이 반환.


# ── story #f2b66f32(3025, BE·상태 자가회수) — merge gate 자가회수도 다른 5종과 동일하게
#    격리돼야 한다(실패해도 done 전이 자체는 무영향). _story()는 status="done" 고정이라 이
#    side-effect가 실제로 시도되는 경로를 그대로 탄다. ───────────────────────────────────
@pytest.mark.anyio
async def test_gate_self_reclamation_raise_does_not_propagate():
    with ExitStack() as stack:
        _base_patches(stack)
        stack.enter_context(patch(
            "app.services.gate_self_reclamation.reclaim_stale_merge_gates_for_story",
            AsyncMock(side_effect=RuntimeError("reclaim down")),
        ))
        await emit_story_status_changed(
            AsyncMock(), uuid.uuid4(), _story(), "in-review",
            actor_id=uuid.uuid4(), actor_type="human",
        )  # 예외 없이 반환.


@pytest.mark.anyio
async def test_gate_self_reclamation_called_only_when_status_is_done():
    """음성대조(페드루 PO 요청) — done이 아닌 전이(예: in-progress)에서는 아예 호출 안 됨."""
    reclaim = AsyncMock()
    story = SimpleNamespace(
        id=uuid.uuid4(), epic_id=None, title="S", priority="low",
        project_id=uuid.uuid4(), status="in-progress", assignee_id=uuid.uuid4(),
    )
    with ExitStack() as stack:
        _base_patches(stack)
        stack.enter_context(patch(
            "app.services.gate_self_reclamation.reclaim_stale_merge_gates_for_story", reclaim,
        ))
        await emit_story_status_changed(
            AsyncMock(), uuid.uuid4(), story, "backlog",
            actor_id=uuid.uuid4(), actor_type="human",
        )
    reclaim.assert_not_awaited()


@pytest.mark.anyio
async def test_gate_self_reclamation_called_when_status_is_done():
    """양성대조 — done 전이에서는 실제로 호출됨(자기 자신의 story_id로)."""
    reclaim = AsyncMock()
    story = _story()  # status="done"
    with ExitStack() as stack:
        _base_patches(stack)
        stack.enter_context(patch(
            "app.services.gate_self_reclamation.reclaim_stale_merge_gates_for_story", reclaim,
        ))
        await emit_story_status_changed(
            AsyncMock(), uuid.uuid4(), story, "in-review",
            actor_id=uuid.uuid4(), actor_type="human",
        )
    reclaim.assert_awaited_once()
    assert reclaim.call_args.args[2] == story.id


def test_single_item_callsite_intentionally_unwrapped_source_pin():
    """단건 콜사이트(update_story_status)가 emit_story_status_changed를 try/except 없이
    부르는 것이 실수로 안 감싸진 게 아니라 #2173 판정에 근거한 의도적 상태임을 소스에 고정
    — 다음에 누가 "왜 여기만 안 감쌌지"로 다시 파지 않도록."""
    import inspect
    from app.routers import stories as stories_mod

    source = inspect.getsource(stories_mod.update_story_status)
    assert "#2173" in source
    assert "await emit_story_status_changed(" in source
