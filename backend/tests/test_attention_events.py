"""story #3180(S3 후속) — attention.changed 발행 헬퍼 shape + best-effort(실패 swallow).

presence_events.py::emit_presence와 동형 테스트 구조(tests/test_presence_events_r2.py 참고) —
payload 없는 org 전체 트리거라는 점까지 동일하다."""
from __future__ import annotations

import uuid
from unittest.mock import AsyncMock, patch

import pytest


@pytest.mark.anyio
async def test_notify_attention_changed_publishes_trigger():
    from app.services import attention_events

    org = uuid.uuid4()
    with patch("app.routers.events.push_to_org_members", new=AsyncMock()) as pub:
        await attention_events.notify_attention_changed(org)

    pub.assert_awaited_once()
    args, kwargs = pub.await_args
    assert args[0] == str(org)
    assert args[1] == "attention.changed"
    assert args[2] == {}
    # presence와 동형 — member_ids 미지정 시 org 전체로 해소된다(command_center.py attention
    # 블록 자체가 org-scope).
    assert kwargs.get("member_ids") is None


@pytest.mark.anyio
async def test_notify_attention_changed_accepts_str_org_id():
    from app.services import attention_events

    org_str = str(uuid.uuid4())
    with patch("app.routers.events.push_to_org_members", new=AsyncMock()) as pub:
        await attention_events.notify_attention_changed(org_str)

    args, _ = pub.await_args
    assert args[0] == org_str


@pytest.mark.anyio
async def test_notify_attention_changed_swallows_publish_failure():
    """발행 실패가 caller(story/dependency/hypothesis/goal 쓰기)를 절대 깨면 안 됨."""
    from app.services import attention_events

    with patch(
        "app.routers.events.push_to_org_members",
        new=AsyncMock(side_effect=RuntimeError("bus down")),
    ):
        await attention_events.notify_attention_changed(uuid.uuid4())  # no raise
