"""E-LOOP-LEDGER P1-S11(+S11b): Context Pack agent dispatch 주입 단위 테스트(mock, 블루프린트 §2).

3개 델리버리 경로(BYO=event.payload passthrough·CC payload dict·CC delivery dict+
deliver_injected_event_webhook)가 전부 context_pack을 실제로 받는지, brief 없으면 null로
graceful하게 생략되는지, 기존 dispatch(trigger_metadata 등) 무회귀를 검증한다.
S11b(2026-07-02): story/epic도 resolve_primary_anchor로 간접 해소(hypothesis_anchor와 동일
SSOT)·sprint/doc은 그 anchor 메커니즘 자체가 커버 안 하는 범위라 동형으로 스코프 밖(즉시
None, DB 쿼리 0).
"""
from __future__ import annotations

import contextlib
import uuid
from datetime import datetime, timezone
from types import SimpleNamespace
from unittest.mock import AsyncMock, MagicMock, patch

import pytest

from app.models.hypothesis import Hypothesis
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


async def test_out_of_scope_entity_returns_none_without_query():
    """sprint/doc은 hypothesis_anchor 메커니즘 자체가 커버 안 하는 범위 — 동형으로 스코프 밖."""
    session = AsyncMock()
    session.execute = AsyncMock()
    out = await hyp_svc.resolve_dispatch_context_pack(session, uuid.uuid4(), "sprint", uuid.uuid4())
    assert out is None
    session.execute.assert_not_called()


async def test_story_with_no_primary_hypothesis_returns_none():
    """S11b: story/epic 모두 primary anchor가 없으면(hypothesis_story_links 미해소) None."""
    with patch.object(
        hyp_svc.HypothesisRepository, "resolve_primary_anchor", AsyncMock(return_value=None),
    ):
        session = AsyncMock()
        session.execute = AsyncMock()
        out = await hyp_svc.resolve_dispatch_context_pack(session, uuid.uuid4(), "story", uuid.uuid4())
    assert out is None
    session.execute.assert_not_called()  # anchor 자체가 없으면 loop/doc 쿼리 자체를 안 함.


async def test_story_resolves_via_primary_hypothesis_anchor_then_loop_and_doc():
    """S11b: story→primary hypothesis anchor→그 hypothesis의 loop→brief doc 경로가 전부 합류.

    anchor_hyp은 실제 Hypothesis 인스턴스여야 한다 — 까심 QA RC(2026-07-02) 이후
    resolve_dispatch_context_pack이 isinstance(anchor_hyp, Hypothesis) 방어를 갖췄으므로,
    SimpleNamespace를 쓰면 그 방어에 걸려 masking(잘못된 이유로 테스트가 통과/실패)된다."""
    anchor_hyp = Hypothesis(id=uuid.uuid4())
    doc_id = uuid.uuid4()
    loop = _loop(brief_doc_id=doc_id)
    doc = SimpleNamespace(content="## Context Pack\n\nstory 간접 해소 브리핑.")

    session = AsyncMock()
    loop_result = MagicMock()
    loop_result.scalar_one_or_none.return_value = loop
    doc_result = MagicMock()
    doc_result.scalar_one_or_none.return_value = doc
    session.execute = AsyncMock(side_effect=[loop_result, doc_result])

    with patch.object(
        hyp_svc.HypothesisRepository, "resolve_primary_anchor", AsyncMock(return_value=anchor_hyp),
    ):
        out = await hyp_svc.resolve_dispatch_context_pack(session, uuid.uuid4(), "story", uuid.uuid4())
    assert out == doc.content


async def test_epic_resolves_via_primary_hypothesis_anchor():
    """anchor_hyp은 실제 Hypothesis 인스턴스여야 isinstance 방어를 통과해 loop 쿼리까지
    genuinely 도달한다(SimpleNamespace면 방어에서 조기 반환돼 masking).

    까심/codex QA RC(2026-07-02): out is None 단독으로는 "가드가 조기 거부"와 "가드 통과 후
    loop 쿼리 결과가 없어 None"을 구분 못 한다(둘 다 out is None) — isinstance 가드를 통째로
    제거해도 이 테스트는 통과해 회귀탐지력이 0이었다. session.execute(loop 쿼리) 실제 호출
    여부를 직접 검증해 "가드를 genuinely 통과했다"는 것을 관찰 가능하게 만든다."""
    anchor_hyp = Hypothesis(id=uuid.uuid4())
    session = _scalar_one_or_none_session(None)  # anchor는 있지만 연결 loop이 없음.
    with patch.object(
        hyp_svc.HypothesisRepository, "resolve_primary_anchor", AsyncMock(return_value=anchor_hyp),
    ) as mock_resolve:
        out = await hyp_svc.resolve_dispatch_context_pack(session, uuid.uuid4(), "epic", uuid.uuid4())
    assert out is None
    mock_resolve.assert_called_once()
    assert mock_resolve.call_args.args[0] == "epic"
    # 가드 통과 증명 — 가드가 anchor_hyp을 거부했다면 loop 쿼리(session.execute)는 호출되지
    # 않았을 것이다. 이 assertion이 있어야 isinstance 가드 제거 시 이 테스트가 genuinely 실패한다.
    session.execute.assert_called_once()


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
