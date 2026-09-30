"""story #4440 — a person's own new message reaches their other tabs and devices live.

The send fan-out (`_dispatch_conversation_event`) leaves the sender out: every recipient gets an Event row (what counts as
unread, what notifies, what wakes an agent) and a push to all of that member's connections. The sender had no row, so none of
their connections got anything — with the desktop app and a browser open together, a message sent from one appeared in the
other only after a reload.

Now a person who sends also gets one transient push (no Event row: nothing unread, no notification) on all their
connections, carrying the sender-only `delivery_withheld`. An agent sender is still left out (its own message must not wake
it). The tab that sent drops its own echo on the client (tested on the web side).
"""
from __future__ import annotations

import asyncio
import os
from datetime import datetime, timezone

import pytest

from tests.test_1994_backlink_api_realdb import (
    _client_for,
    _make_agent_member,
    _make_conversation,
    _make_human_member,
    _make_org,
    _make_project,
    _session_factory,
    _setup_app_human,
)

_REAL_DB_URL = os.getenv("PARITY_TEST_DATABASE_URL") or os.getenv("ALEMBIC_DATABASE_URL")

pytestmark = [
    pytest.mark.skipif(not _REAL_DB_URL, reason="통합 테스트는 실 PG(PARITY/ALEMBIC_DATABASE_URL) 필요"),
    pytest.mark.anyio,
]


@pytest.fixture
def anyio_backend():
    return "asyncio"


@pytest.fixture(autouse=True)
async def _dispose_global_engine_after_test():
    yield
    from app.core.database import engine as _global_engine

    await _global_engine.dispose()


def _open_connections(member_id, n: int) -> list[asyncio.Queue]:
    """`n` open browser-stream connections for this member (what the event stream registers per tab/device)."""
    from app.routers import events as ev

    queues = [asyncio.Queue(maxsize=100) for _ in range(n)]
    for q in queues:
        ev._agent_connections[str(member_id)].add(q)
    return queues


def _close_all(*member_ids) -> None:
    from app.routers import events as ev

    for mid in member_ids:
        ev._agent_connections.pop(str(mid), None)


def _drain(q: asyncio.Queue) -> list[dict]:
    out = []
    while not q.empty():
        out.append(q.get_nowait())
    return out


def _created(frames: list[dict], message_id: str) -> list[dict]:
    return [f for f in frames if f.get("event_type") == "conversation.message_created" and f.get("id") == message_id]


async def _as(app, Session, user_id, org_id, fn):
    await _setup_app_human(app, Session, user_id, org_id)
    try:
        async with _client_for(app) as client:
            return await fn(client)
    finally:
        app.dependency_overrides.clear()


async def _event_rows_for(Session, member_id, message_id) -> int:
    from sqlalchemy import func, select

    from app.models.event import Event

    async with Session() as s:
        return (await s.execute(select(func.count()).select_from(Event).where(
            Event.recipient_id == member_id, Event.source_entity_id == message_id,
        ))).scalar_one()


async def test_a_persons_message_reaches_all_their_connections_without_an_event_row():
    engine, Session = await _session_factory()
    try:
        async with Session() as session:
            org = await _make_org(session)
            project = await _make_project(session, org.id)
            sender_id, sender_user = await _make_human_member(session, org.id, project.id)
            other_id, _ = await _make_human_member(session, org.id, project.id)
            conv_id = await _make_conversation(session, org.id, project.id, [sender_id, other_id], sender_id)
        from app.main import app

        mine = _open_connections(sender_id, 2)  # e.g. the desktop app and a browser tab
        theirs = _open_connections(other_id, 1)
        try:
            sent = await _as(app, Session, sender_user, org.id,
                             lambda c: c.post(f"/api/v2/conversations/{conv_id}/messages",
                                              json={"content": "from the app", "client_nonce": "tab-a-7f3c"}))
            assert sent.status_code == 201, sent.text
            msg_id = sent.json()["data"]["id"]
            for q in mine:
                frames = _created(_drain(q), msg_id)
                assert len(frames) == 1, frames  # each of my connections gets it once
                assert frames[0]["content"] == "from the app"
                assert frames[0]["sender"]["id"] == str(sender_id)
                assert "event_id" not in frames[0]  # transient: no Event row behind it
                # PO 19:37Z — the echo can arrive before the send answer: the nonce the sending tab made lets it know its own
                assert frames[0]["client_nonce"] == "tab-a-7f3c"
            [their_frame] = _created(_drain(theirs[0]), msg_id)  # the other participant as before
            assert "client_nonce" not in their_frame  # the nonce goes back to the sender only
            assert await _event_rows_for(Session, sender_id, msg_id) == 0  # nothing unread / notified for me
        finally:
            _close_all(sender_id, other_id)
    finally:
        await engine.dispose()


async def test_the_withheld_mark_reaches_my_other_connections_too():
    """The sender-only `delivery_withheld` (story #4430) rides on the sender's echo — another tab shows the same line."""
    engine, Session = await _session_factory()
    try:
        async with Session() as session:
            org = await _make_org(session)
            project = await _make_project(session, org.id)
            blocker_id, blocker_user = await _make_human_member(session, org.id, project.id)
            sender_id, sender_user = await _make_human_member(session, org.id, project.id)
            conv_id = await _make_conversation(session, org.id, project.id, [blocker_id, sender_id], sender_id)
        from app.main import app

        await _as(app, Session, blocker_user, org.id,
                  lambda c: c.post("/api/v2/user-blocks", json={"blocked_member_id": str(sender_id)}))
        mine = _open_connections(sender_id, 1)
        blocker_conn = _open_connections(blocker_id, 1)
        try:
            sent = await _as(app, Session, sender_user, org.id,
                             lambda c: c.post(f"/api/v2/conversations/{conv_id}/messages", json={"content": "hello?"}))
            msg_id = sent.json()["data"]["id"]
            [frame] = _created(_drain(mine[0]), msg_id)
            assert frame.get("delivery_withheld") == {
                "withheld_count": 1, "reason": "recipient_blocked_sender", "conversation_type": "dm",
            }, frame
            assert _created(_drain(blocker_conn[0]), msg_id) == []  # the blocker still gets nothing
        finally:
            _close_all(sender_id, blocker_id)
    finally:
        await engine.dispose()


async def test_an_agent_sender_is_still_left_out():
    """An agent's own message must not reach its connections — it would wake on its own words."""
    from app.dependencies.auth import AuthContext, get_current_user
    from tests.conftest import override_db_and_read

    engine, Session = await _session_factory()
    try:
        async with Session() as session:
            org = await _make_org(session)
            project = await _make_project(session, org.id)
            human_id, _ = await _make_human_member(session, org.id, project.id)
            agent_id = await _make_agent_member(session, org.id, project.id)
            conv_id = await _make_conversation(session, org.id, project.id, [human_id, agent_id], human_id)
        from app.main import app

        async def _db():
            async with Session() as s:
                try:
                    yield s
                    await s.commit()
                except Exception:
                    await s.rollback()
                    raise

        async def _agent_auth():
            return AuthContext(user_id=str(agent_id), email=None,
                               claims={"app_metadata": {"api_key_id": "k", "org_id": str(org.id)}}, org_id=str(org.id))

        override_db_and_read(app, _db)
        app.dependency_overrides[get_current_user] = _agent_auth
        agent_conn = _open_connections(agent_id, 1)
        human_conn = _open_connections(human_id, 1)
        try:
            async with _client_for(app) as c:
                sent = await c.post(f"/api/v2/conversations/{conv_id}/messages", json={"content": "done"},
                                    headers={"X-Org-Id": str(org.id)})
            assert sent.status_code == 201, sent.text
            msg_id = sent.json()["data"]["id"]
            assert _created(_drain(agent_conn[0]), msg_id) == []
            assert len(_created(_drain(human_conn[0]), msg_id)) == 1
        finally:
            app.dependency_overrides.clear()
            _close_all(agent_id, human_id)
    finally:
        await engine.dispose()



async def test_a_nonce_that_is_not_a_short_token_is_refused():
    """The nonce only travels back to the sender's own connections; still, it is a short token, nothing else."""
    engine, Session = await _session_factory()
    try:
        async with Session() as session:
            org = await _make_org(session)
            project = await _make_project(session, org.id)
            sender_id, sender_user = await _make_human_member(session, org.id, project.id)
            other_id, _ = await _make_human_member(session, org.id, project.id)
            conv_id = await _make_conversation(session, org.id, project.id, [sender_id, other_id], sender_id)
        from app.main import app

        for bad in ("x" * 65, "has space", "<script>"):
            r = await _as(app, Session, sender_user, org.id,
                          lambda c, b=bad: c.post(f"/api/v2/conversations/{conv_id}/messages", json={"content": "hi", "client_nonce": b}))
            assert r.status_code == 422, (bad, r.status_code)
    finally:
        await engine.dispose()
