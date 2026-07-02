"""E-LOOP-LEDGER P1-S11: Context Pack agent dispatch 주입 단위 테스트(mock, 블루프린트 §2).

3개 델리버리 경로(BYO=event.payload passthrough·CC payload dict·CC delivery dict+
deliver_injected_event_webhook)가 전부 context_pack을 실제로 받는지, brief 없으면 null로
graceful하게 생략되는지, 기존 dispatch(trigger_metadata 등) 무회귀를 검증한다.
hypothesis-only 스코프(story/epic/sprint/doc은 즉시 None, DB 쿼리 0)도 확인.
"""
from __future__ import annotations

import contextlib
import uuid
from datetime import datetime, timezone
from types import SimpleNamespace
from unittest.mock import AsyncMock, MagicMock, patch

import pytest

from app.services import agent_dispatch as svc
from app.services import hypothesis as hyp_svc


@pytest.fixture
def anyio_backend():
    return "asyncio"


# ── resolve_dispatch_context_pack: 단위 ────────────────────────────────────

def _loop(status="briefing", brief_doc_id=None, created_at=None):
    return SimpleNamespace(
        id=uuid.uuid4(), status=status, brief_doc_id=brief_doc_id,
        created_at=created_at or datetime(2026, 1, 1, tzinfo=timezone.utc),
    )


def _scalar_one_or_none_session(value):
    s = AsyncMock()
    result = MagicMock()
    result.scalar_one_or_none.return_value = value
    s.execute = AsyncMock(return_value=result)
    return s


async def test_non_hypothesis_entity_returns_none_without_query():
    session = AsyncMock()
    session.execute = AsyncMock()
    out = await hyp_svc.resolve_dispatch_context_pack(session, uuid.uuid4(), "story", uuid.uuid4())
    assert out is None
    session.execute.assert_not_called()


async def test_no_linked_loop_returns_none():
    session = _scalar_one_or_none_session(None)
    out = await hyp_svc.resolve_dispatch_context_pack(session, uuid.uuid4(), "hypothesis", uuid.uuid4())
    assert out is None


async def test_loop_without_brief_doc_returns_none():
    loop = _loop(brief_doc_id=None)
    session = _scalar_one_or_none_session(loop)
    out = await hyp_svc.resolve_dispatch_context_pack(session, uuid.uuid4(), "hypothesis", uuid.uuid4())
    assert out is None


async def test_loop_with_brief_doc_returns_doc_content():
    doc_id = uuid.uuid4()
    loop = _loop(brief_doc_id=doc_id)
    doc = SimpleNamespace(content="## Context Pack\n\n과거 유사 항목 1건 발견.")

    session = AsyncMock()
    loop_result = MagicMock()
    loop_result.scalar_one_or_none.return_value = loop
    doc_result = MagicMock()
    doc_result.scalar_one_or_none.return_value = doc
    session.execute = AsyncMock(side_effect=[loop_result, doc_result])

    out = await hyp_svc.resolve_dispatch_context_pack(session, uuid.uuid4(), "hypothesis", uuid.uuid4())
    assert out == doc.content


# ── dispatch_entity_to_assignee: context_pack payload/delivery/content 주입 ──

def _agent_member():
    return SimpleNamespace(id=uuid.uuid4(), type="agent")


async def _assign_seq(_db, event):
    event.recipient_seq = 1


def _patches(context_pack_value):
    proj = uuid.uuid4()
    return [
        patch.object(svc, "_fetch_entity", AsyncMock(return_value=(uuid.uuid4(), "H", "desc", proj))),
        patch.object(svc, "resolve_member_identity", AsyncMock(return_value=_agent_member())),
        patch.object(svc, "assign_recipient_seq", _assign_seq),
        patch.object(svc, "extract_activities_best_effort", AsyncMock()),
        patch.object(svc, "dispatch_notification", AsyncMock()),
        patch.object(svc, "wake_agent", MagicMock()),
        patch("app.services.hypothesis.resolve_dispatch_anchor", AsyncMock(return_value=None)),
        patch("app.services.hypothesis.resolve_dispatch_context_pack", AsyncMock(return_value=context_pack_value)),
    ]


def _db_capturing(captured):
    db = AsyncMock()
    db.add = lambda ev: captured.__setitem__("event", ev)
    return db


async def test_context_pack_present_appears_in_payload_delivery_and_content():
    captured: dict = {}
    db = _db_capturing(captured)
    cp = "## Context Pack\n\n과거 유사 항목 1건 발견."
    with contextlib.ExitStack() as stack:
        for p in _patches(cp):
            stack.enter_context(p)
        resp, delivery = await svc.dispatch_entity_to_assignee(
            db, uuid.uuid4(), "hypothesis", uuid.uuid4(), "msg",
        )
    assert captured["event"].payload["context_pack"] == cp
    assert delivery["context_pack"] == cp
    assert cp in captured["event"].payload["content"]  # 에이전트가 실제로 읽는 content에도 반영.


async def test_context_pack_absent_is_null_not_omitted():
    captured: dict = {}
    db = _db_capturing(captured)
    with contextlib.ExitStack() as stack:
        for p in _patches(None):
            stack.enter_context(p)
        resp, delivery = await svc.dispatch_entity_to_assignee(
            db, uuid.uuid4(), "hypothesis", uuid.uuid4(), "msg",
        )
    # hypothesis_anchor와 동형 — always-present/nullable(생략 아님).
    assert captured["event"].payload["context_pack"] is None
    assert delivery["context_pack"] is None


async def test_existing_dispatch_behavior_unaffected():
    """기존 trigger_metadata additive 계약이 context_pack 추가로 안 깨지는지(무회귀)."""
    captured: dict = {}
    db = _db_capturing(captured)
    with contextlib.ExitStack() as stack:
        for p in _patches(None):
            stack.enter_context(p)
        resp, delivery = await svc.dispatch_entity_to_assignee(
            db, uuid.uuid4(), "hypothesis", uuid.uuid4(), "msg",
            trigger_metadata={"trigger": "deadline"},
        )
    assert resp.dispatched is True
    assert captured["event"].payload["trigger_metadata"] == {"trigger": "deadline"}


# ── deliver_injected_event_webhook: context_pack passthrough ───────────────

async def test_webhook_delivery_passes_through_context_pack():
    from app.services.conversation_webhook import deliver_injected_event_webhook

    wh = SimpleNamespace(
        id=uuid.uuid4(), url="https://discord.com/api/webhooks/1/a", secret=None,
        events=None, member_id=uuid.uuid4(), is_active=True,
    )
    result = MagicMock()
    result.scalars.return_value.all.return_value = [wh]
    db = MagicMock()
    db.execute = AsyncMock(return_value=result)

    def _factory():
        @contextlib.asynccontextmanager
        async def _cm():
            yield db
        return _cm()

    calls = []

    async def _capture(url, secret, payload):
        calls.append(payload)

    cp = "## Context Pack\n\n과거 유사 항목 1건 발견."
    with patch("app.core.database.async_session_factory", _factory), \
         patch("app.services.conversation_webhook._attempt_delivery", new=AsyncMock(side_effect=_capture)):
        await deliver_injected_event_webhook(
            org_id=uuid.uuid4(), recipient_id=wh.member_id,
            content="[hypothesis] H", event_type="dispatched",
            source_entity_type="hypothesis", source_entity_id=uuid.uuid4(),
            hypothesis_anchor=None, context_pack=cp,
        )
    assert len(calls) == 1
    assert calls[0]["context_pack"] == cp


async def test_webhook_delivery_defaults_context_pack_none_backward_compat():
    """기존 호출부(context_pack 인자 없이 호출)도 여전히 동작 — 기본값 None."""
    from app.services.conversation_webhook import deliver_injected_event_webhook

    wh = SimpleNamespace(
        id=uuid.uuid4(), url="https://discord.com/api/webhooks/1/a", secret=None,
        events=None, member_id=uuid.uuid4(), is_active=True,
    )
    result = MagicMock()
    result.scalars.return_value.all.return_value = [wh]
    db = MagicMock()
    db.execute = AsyncMock(return_value=result)

    def _factory():
        @contextlib.asynccontextmanager
        async def _cm():
            yield db
        return _cm()

    calls = []

    async def _capture(url, secret, payload):
        calls.append(payload)

    with patch("app.core.database.async_session_factory", _factory), \
         patch("app.services.conversation_webhook._attempt_delivery", new=AsyncMock(side_effect=_capture)):
        await deliver_injected_event_webhook(
            org_id=uuid.uuid4(), recipient_id=wh.member_id,
            content="[story] S", event_type="dispatched",
        )
    assert calls[0]["context_pack"] is None
