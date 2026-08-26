"""story #2608 P1 AC1 — _dispatch_human_intervention_event 격리 가드(mock DB, test_event1config_
message_gating.py와 동일 패턴). "연쇄 cap 초과 시 침묵이 아니라 이벤트로"의 이벤트 생성부만
좁게 검증 — target 산출(human만·agent/sender 제외)과 payload 형태(blocked_recipient_ids·
chain_depth_cap·reason)."""
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
        deleted_at=None,
    )


def _sender():
    # story #2901 — _msg_payload가 sender.avatar_url을 읽는다(ResolvedMember/TeamMember
    # 실 타입 둘 다 이 속성을 갖는다).
    return SimpleNamespace(id=uuid.uuid4(), name="에이전트A", type="agent", avatar_url=None)


class _DB:
    def __init__(self, exec_rows: list):
        self._exec_rows = list(exec_rows)
        self.added: list = []
        self.add = lambda ev: self.added.append(ev)
        self.flush = AsyncMock()

    async def execute(self, *_a, **_k):
        return self._exec_rows.pop(0)


def _patches():
    return [patch("app.services.activity_stream.extract_activities_best_effort", AsyncMock())]


@pytest.mark.anyio
async def test_only_human_participants_receive_intervention_event():
    conversation = SimpleNamespace(id=uuid.uuid4(), project_id=uuid.uuid4())
    msg = _msg()
    sender = _sender()
    human1, human2, agent_other = uuid.uuid4(), uuid.uuid4(), uuid.uuid4()
    blocked = {uuid.uuid4()}  # 상대 agent(연쇄 게이트에 막힌 agent recipient)

    db = _DB([
        _result_all([(human1, "human"), (human2, "human"), (agent_other, "agent")]),
    ])

    import contextlib
    with contextlib.ExitStack() as stack:
        for p in _patches():
            stack.enter_context(p)
        result = await conv._dispatch_human_intervention_event(
            db, conversation, msg, uuid.uuid4(), sender, blocked, chain_depth_cap=4,
        )

    assert len(db.added) == 2, "human 참가자 2명에게만 Event가 만들어져야(agent는 제외)"
    recipient_ids = {ev.recipient_id for ev in db.added}
    assert recipient_ids == {human1, human2}
    for ev in db.added:
        assert ev.event_type == "conversation.human_intervention_requested"
        assert ev.recipient_type == "human"
        assert ev.payload["reason"] == "chain-expired"
        assert ev.payload["chain_depth_cap"] == 4
        assert ev.payload["blocked_recipient_ids"] == [str(next(iter(blocked)))]
    assert len(result) == 2


@pytest.mark.anyio
async def test_no_human_participants_no_event_and_no_db_roundtrip():
    """human이 대화에 아무도 없으면(전부 agent) — 조회 1회 후 바로 빈 결과, INSERT 0건."""
    conversation = SimpleNamespace(id=uuid.uuid4(), project_id=uuid.uuid4())
    msg = _msg()
    sender = _sender()
    agent_only = uuid.uuid4()

    db = _DB([_result_all([(agent_only, "agent")])])

    result = await conv._dispatch_human_intervention_event(
        db, conversation, msg, uuid.uuid4(), sender, {uuid.uuid4()}, chain_depth_cap=4,
    )
    assert result == []
    assert db.added == []


@pytest.mark.anyio
async def test_no_project_id_returns_empty_without_query():
    """project_id 없는 conversation은 조회조차 안 한다(_dispatch_conversation_event와 동일
    선행 가드 — DM 미배정 등 edge case)."""
    conversation = SimpleNamespace(id=uuid.uuid4(), project_id=None)
    msg = _msg()
    sender = _sender()

    db = _DB([])  # execute가 호출되면 IndexError로 즉시 실패 — 조회 0회를 강제.
    result = await conv._dispatch_human_intervention_event(
        db, conversation, msg, uuid.uuid4(), sender, {uuid.uuid4()}, chain_depth_cap=4,
    )
    assert result == []
