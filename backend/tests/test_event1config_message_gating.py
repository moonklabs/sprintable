"""E-EVENT-1CONFIG Part A: 메시지 경로 SSE 게이팅 가드 (이중수신 박멸).

_dispatch_conversation_event / _dispatch_mention_events 가 webhook-covered agent recipient 의
SSE Event 를 스킵하되, ①비-mentioned participant ②human ③비-covered agent 는 SSE 유지함을
가드한다. active_webhook_member_ids(SSOT)는 별도 단위테스트(test_webhook_targeting)로 검증 —
여기선 authorized-set 계산 + skip 결정만 격리 검증(헬퍼는 patch).
"""
from __future__ import annotations

import uuid
from datetime import datetime, timezone
from types import SimpleNamespace
from unittest.mock import AsyncMock, patch

import pytest

import app.routers.conversations as conv


@pytest.fixture
def anyio_backend():
    return "asyncio"


def _result_all(rows: list):
    r = SimpleNamespace()
    r.all = lambda: rows
    return r


def _msg(mentioned=None):
    return SimpleNamespace(
        id=uuid.uuid4(),
        conversation_id=uuid.uuid4(),
        thread_id=None,
        reply_count=0,
        last_reply_at=None,
        content="hi",
        mentioned_ids=list(mentioned or []),
        attachments=[],
        created_at=datetime.now(timezone.utc),
    )


def _sender():
    return SimpleNamespace(id=uuid.uuid4(), name="송신자", type="human")


async def _assign_seq(_db, event):
    event.recipient_seq = 1


class _DB:
    """participant→member_type execute 2발 + add 캡처. webhook 헬퍼는 patch라 execute 미사용."""

    def __init__(self, exec_rows: list):
        self._exec_rows = list(exec_rows)
        self.added: list = []
        self.add = lambda ev: self.added.append(ev)
        self.flush = AsyncMock()

    async def execute(self, *_a, **_k):
        return self._exec_rows.pop(0)


def _patches(covered_fn):
    return [
        patch.object(conv, "assign_recipient_seq", _assign_seq),
        patch("app.services.activity_stream.extract_activities_best_effort", AsyncMock()),
        patch.object(conv, "active_webhook_member_ids", covered_fn),
        patch("app.services.presence_events.emit_conversation_working", lambda *_a, **_k: None),
        patch("app.services.presence_events.emit_presence", lambda *_a, **_k: None),
    ]


# ─── AC1: covered agent 는 스킵, uncovered agent·human 은 유지 ──────────────────

@pytest.mark.anyio
async def test_covered_agent_skipped_others_kept():
    import contextlib

    org_id = uuid.uuid4()
    sender = _sender()
    agent_cov = uuid.uuid4()
    agent_unc = uuid.uuid4()
    human = uuid.uuid4()
    conversation = SimpleNamespace(id=uuid.uuid4(), project_id=uuid.uuid4())
    msg = _msg()

    db = _DB([
        _result_all([(agent_cov,), (agent_unc,), (human,), (sender.id,)]),  # participants
        _result_all([(agent_cov, "agent"), (agent_unc, "agent"), (human, "human")]),  # types
    ])

    async def covered_fn(_db, _org, candidates):
        assert set(candidates) == {agent_cov, agent_unc}  # human 은 후보 아님
        return {agent_cov}

    with contextlib.ExitStack() as stack:
        for p in _patches(covered_fn):
            stack.enter_context(p)
        out = await conv._dispatch_conversation_event(db, conversation, msg, org_id, sender)

    recipients = {ev.recipient_id for ev in db.added}
    assert recipients == {agent_unc, human}, "covered agent 만 SSE 스킵"
    assert agent_cov not in recipients
    # 반환 push 페이로드도 covered 제외
    assert {uuid.UUID(pid) for pid, _ in out} == {agent_unc, human}


# ─── AC2/grant-only: mentioned 있으면 비-mentioned participant 는 후보 제외(skip 금지) ──

@pytest.mark.anyio
async def test_non_mentioned_participant_not_skipped_even_with_webhook():
    """멘션 있는 메시지: 멘션 안 된 participant agent 는 webhook 보유여도 SSE 유지(silent loss 0)."""
    import contextlib

    org_id = uuid.uuid4()
    sender = _sender()
    agent_mentioned = uuid.uuid4()
    agent_not_mentioned = uuid.uuid4()  # webhook 보유하지만 멘션 안 됨
    conversation = SimpleNamespace(id=uuid.uuid4(), project_id=uuid.uuid4())
    msg = _msg(mentioned=[agent_mentioned])

    db = _DB([
        _result_all([(agent_mentioned,), (agent_not_mentioned,)]),
        _result_all([(agent_mentioned, "agent"), (agent_not_mentioned, "agent")]),
    ])

    seen_candidates = {}

    async def covered_fn(_db, _org, candidates):
        seen_candidates["set"] = set(candidates)
        # 둘 다 webhook 보유라 가정해도, 후보에 든 멤버만 covered 가능
        return set(candidates)

    with contextlib.ExitStack() as stack:
        for p in _patches(covered_fn):
            stack.enter_context(p)
        await conv._dispatch_conversation_event(db, conversation, msg, org_id, sender)

    # 후보 = 멘션된 agent 만(authorized=mentioned 우선)
    assert seen_candidates["set"] == {agent_mentioned}
    recipients = {ev.recipient_id for ev in db.added}
    # 멘션된 covered agent 는 스킵, 멘션 안 된 participant 는 유지
    assert recipients == {agent_not_mentioned}


# ─── FORK2: human 은 webhook 보유여도 Event 무변경 ────────────────────────────

@pytest.mark.anyio
async def test_human_never_skipped():
    import contextlib

    org_id = uuid.uuid4()
    sender = _sender()
    human = uuid.uuid4()
    conversation = SimpleNamespace(id=uuid.uuid4(), project_id=uuid.uuid4())
    msg = _msg()

    db = _DB([
        _result_all([(human,)]),
        _result_all([(human, "human")]),
    ])

    async def covered_fn(_db, _org, candidates):
        assert set(candidates) == set()  # human 은 후보 아님 — 헬퍼 호출돼도 빈 후보
        return set()

    with contextlib.ExitStack() as stack:
        for p in _patches(covered_fn):
            stack.enter_context(p)
        await conv._dispatch_conversation_event(db, conversation, msg, org_id, sender)

    assert {ev.recipient_id for ev in db.added} == {human}


# ─── mention 경로: covered mentioned agent 스킵, uncovered 유지 ────────────────

@pytest.mark.anyio
async def test_mention_path_gates_covered_agent():
    import contextlib

    org_id = uuid.uuid4()
    sender = _sender()
    agent_cov = uuid.uuid4()
    agent_unc = uuid.uuid4()
    conversation = SimpleNamespace(id=uuid.uuid4(), project_id=uuid.uuid4())
    msg = _msg(mentioned=[agent_cov, agent_unc])
    targets = {agent_cov, agent_unc}

    db = _DB([
        _result_all([(agent_cov, "agent"), (agent_unc, "agent")]),  # member_type
    ])

    async def covered_fn(_db, _org, candidates):
        assert set(candidates) == {agent_cov, agent_unc}
        return {agent_cov}

    with contextlib.ExitStack() as stack:
        for p in _patches(covered_fn):
            stack.enter_context(p)
        await conv._dispatch_mention_events(db, conversation, msg, org_id, sender, targets)

    assert {ev.recipient_id for ev in db.added} == {agent_unc}
