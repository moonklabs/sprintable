"""emit_story_status_changed의 side-effect 격리(best-effort) 단위 테스트.

notif/webhook/L2 등 side-effect가 raise해도 status 전이 흐름으로 전파되지 않아야 한다(gate 경로는
flush後 commit前 emit이라 side-effect 실패가 story done을 롤백하면 안 됨).
"""
from __future__ import annotations

import uuid
from contextlib import ExitStack
from types import SimpleNamespace
from unittest.mock import AsyncMock, MagicMock, patch

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
    stack.enter_context(patch("app.routers.events.publish_event", MagicMock()))
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
