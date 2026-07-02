"""L2-S1: dispatch_entity_to_assignee 서비스 단위 테스트.

라우터 경유 거동(AC①②④)은 기존 dispatch 스위트가 커버한다. 여기서는 라우터가 넘기지 않는
trigger_metadata(AC③·L2 트리거 전용)와 service 직호출 계약을 검증한다.
"""
from __future__ import annotations

import uuid
from types import SimpleNamespace
from unittest.mock import AsyncMock, MagicMock, patch

import pytest

from app.services import agent_dispatch as svc


@pytest.fixture
def anyio_backend():
    return "asyncio"


def _agent_member():
    return SimpleNamespace(id=uuid.uuid4(), type="agent")


async def _assign_seq(_db, event):
    event.recipient_seq = 1


def _patches():
    proj = uuid.uuid4()
    return [
        patch.object(svc, "_fetch_entity", AsyncMock(return_value=(uuid.uuid4(), "Story T", "desc", proj))),
        patch.object(svc, "resolve_member_identity", AsyncMock(return_value=_agent_member())),
        patch.object(svc, "assign_recipient_seq", _assign_seq),
        patch.object(svc, "extract_activities_best_effort", AsyncMock()),
        patch.object(svc, "dispatch_notification", AsyncMock()),
        patch.object(svc, "wake_agent", MagicMock()),
        patch("app.services.hypothesis.resolve_dispatch_anchor", AsyncMock(return_value=None)),
        patch("app.services.hypothesis.resolve_dispatch_context_pack", AsyncMock(return_value=None)),
    ]


def _db_capturing(captured):
    db = AsyncMock()
    db.add = lambda ev: captured.__setitem__("event", ev)
    return db


@pytest.mark.anyio
async def test_trigger_metadata_added_to_payload_additive():
    captured: dict = {}
    db = _db_capturing(captured)
    import contextlib

    with contextlib.ExitStack() as stack:
        for p in _patches():
            stack.enter_context(p)
        resp, delivery = await svc.dispatch_entity_to_assignee(
            db, uuid.uuid4(), "story", uuid.uuid4(), "msg",
            trigger_metadata={"trigger": "deadline", "rule": "r1"},
        )

    assert resp.dispatched is True and resp.assignee_type == "agent"
    assert captured["event"].payload["trigger_metadata"] == {"trigger": "deadline", "rule": "r1"}
    assert delivery is not None and delivery["event_type"] == "dispatched"


@pytest.mark.anyio
async def test_no_trigger_metadata_key_when_absent():
    captured: dict = {}
    db = _db_capturing(captured)
    import contextlib

    with contextlib.ExitStack() as stack:
        for p in _patches():
            stack.enter_context(p)
        await svc.dispatch_entity_to_assignee(db, uuid.uuid4(), "story", uuid.uuid4(), "msg")

    assert "trigger_metadata" not in captured["event"].payload  # additive — 미전달 시 키 없음


@pytest.mark.anyio
async def test_invalid_entity_type_raises_400():
    from fastapi import HTTPException

    with pytest.raises(HTTPException) as ei:
        await svc.dispatch_entity_to_assignee(AsyncMock(), uuid.uuid4(), "bogus", uuid.uuid4(), None)
    assert ei.value.status_code == 400


@pytest.mark.anyio
async def test_no_assignee_returns_dispatched_false():
    with patch.object(svc, "_fetch_entity", AsyncMock(return_value=(None, "T", "d", uuid.uuid4()))):
        resp, delivery = await svc.dispatch_entity_to_assignee(AsyncMock(), uuid.uuid4(), "story", uuid.uuid4(), None)
    assert resp.dispatched is False and resp.reason == "no_assignee" and delivery is None
