"""E-EVENT-1CONFIG Part A: 메시지 경로 SSE 게이팅 가드 (이중수신 박멸).

_dispatch_conversation_event / _dispatch_mention_events 가 **넘어온** webhook_covered_ids 의
agent recipient SSE Event 를 스킵하되 human·비-covered agent 는 유지함을 가드한다.

covered 집합 산출(authorized=mentioned우선·sender제외·member-bound·project독립·broadcast제외)은
resolve_conversation_webhook_targets 의 책임 → test_event1config_webhook_targets 에서 검증.
여기선 "covered 받으면 정확히 그 agent 만 스킵" 결정만 격리 가드(TOCTOU: skip↔deliver 동일 snapshot).
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
    """participant→member_type execute + add 캡처."""

    def __init__(self, exec_rows: list):
        self._exec_rows = list(exec_rows)
        self.added: list = []
        self.add = lambda ev: self.added.append(ev)
        self.flush = AsyncMock()

    async def execute(self, *_a, **_k):
        return self._exec_rows.pop(0)


def _patches():
    return [
        patch.object(conv, "assign_recipient_seq", _assign_seq),
        patch("app.services.activity_stream.extract_activities_best_effort", AsyncMock()),
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

    with contextlib.ExitStack() as stack:
        for p in _patches():
            stack.enter_context(p)
        out = await conv._dispatch_conversation_event(
            db, conversation, msg, org_id, sender, webhook_covered_ids={agent_cov},
        )

    recipients = {ev.recipient_id for ev in db.added}
    assert recipients == {agent_unc, human}, "covered agent 만 SSE 스킵"
    assert {uuid.UUID(pid) for pid, _ in out} == {agent_unc, human}


# ─── FORK2: human 은 covered 에 들어 있어도 Event 무변경(agent 만 스킵) ──────────

@pytest.mark.anyio
async def test_human_never_skipped_even_if_in_covered():
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

    with contextlib.ExitStack() as stack:
        for p in _patches():
            stack.enter_context(p)
        # human id 를 covered 에 일부러 넣어도 human Event 는 생성돼야(is_agent 가드)
        await conv._dispatch_conversation_event(
            db, conversation, msg, org_id, sender, webhook_covered_ids={human},
        )

    assert {ev.recipient_id for ev in db.added} == {human}


# ─── covered 없으면(빈/None) 전원 SSE 유지 ─────────────────────────────────────

@pytest.mark.anyio
async def test_no_covered_keeps_all_agents():
    import contextlib

    org_id = uuid.uuid4()
    sender = _sender()
    agent_a = uuid.uuid4()
    conversation = SimpleNamespace(id=uuid.uuid4(), project_id=uuid.uuid4())
    msg = _msg()

    db = _DB([
        _result_all([(agent_a,)]),
        _result_all([(agent_a, "agent")]),
    ])

    with contextlib.ExitStack() as stack:
        for p in _patches():
            stack.enter_context(p)
        await conv._dispatch_conversation_event(
            db, conversation, msg, org_id, sender, webhook_covered_ids=None,
        )

    assert {ev.recipient_id for ev in db.added} == {agent_a}


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

    with contextlib.ExitStack() as stack:
        for p in _patches():
            stack.enter_context(p)
        await conv._dispatch_mention_events(
            db, conversation, msg, org_id, sender, targets,
            webhook_covered_ids={agent_cov},
        )

    assert {ev.recipient_id for ev in db.added} == {agent_unc}
