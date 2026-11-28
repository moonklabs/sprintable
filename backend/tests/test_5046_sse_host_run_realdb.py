"""story 5046 (C13) — the SSE `conversation.working` event carries `host_run` per working agent, from the SAME answer as GET /working (one helper, `with_host_run`). The web then needs no second source: it draws the
«지금 끼어들기 / 끝나고 이어서» choice from the value it was handed. Red when: an item of the event has no `host_run` · a host-run agent reads false (or any other reads true) · a failed read of host_run costs the list
(it must answer «not host-run», the list stays) · a key that was there before is gone (member_id · state · updated_at stay) · the REST route and the event can answer differently (both go through the one helper).
The header is the client's own word and decides only what is DRAWN (see test_5046_host_run_realdb.py for the census): nothing here changes who receives what.
"""
from __future__ import annotations

import pathlib
import uuid
from datetime import datetime, timedelta, timezone

import pytest
from sqlalchemy import text

from tests.test_4846_org_chat_rooms_realdb import (  # noqa: F401 — fixtures used by name
    _REAL_DB_URL,
    _dispose_global_engine_after_test,
    _world,
)

APP = pathlib.Path(__file__).resolve().parents[1] / "app"

pytestmark = [
    pytest.mark.skipif(not _REAL_DB_URL, reason="real Postgres 필요"),
    pytest.mark.anyio,
]


@pytest.fixture
def anyio_backend():
    return "asyncio"


async def _row(Session, agent, kind, *, age_sec=0):
    t = datetime.now(timezone.utc) - timedelta(seconds=age_sec)
    async with Session() as s:
        await s.execute(
            text("INSERT INTO agent_gateway_sessions (id, agent_id, connected_at, last_seen_at, last_ack_seq, client_kind) VALUES (:i, :a, :t, :t, 0, :k)"),
            {"i": uuid.uuid4(), "a": agent, "t": t, "k": kind},
        )
        await s.commit()


async def _event_payload(monkeypatch, w, room):
    """run the real emitter for the room and catch what it would push"""
    from app.routers import events
    from app.services import presence_events

    caught: list[dict] = []

    async def _push(org_id, event, payload, **kw):
        caught.append({"event": event, "payload": payload, "kw": kw})

    monkeypatch.setattr(events, "push_to_org_members", _push)
    await presence_events.emit_conversation_working(w.org, room)
    assert len(caught) == 1 and caught[0]["event"] == "conversation.working", caught
    return caught[0]["payload"]


async def test_the_event_says_host_run_per_working_agent_and_keeps_what_was_there(monkeypatch):
    from app.services import chat_presence

    engine, Session, w = await _world()
    try:
        await _row(Session, w.g_p, "host")
        await _row(Session, w.g_2, None)
        for a in (w.g_p, w.g_2):
            await chat_presence.set_working(str(w.r_agents), str(a))
        payload = await _event_payload(monkeypatch, w, w.r_agents)
        by = {i["member_id"]: i for i in payload["working"]}
        assert by[str(w.g_p)]["host_run"] is True, payload
        assert by[str(w.g_2)]["host_run"] is False, payload          # a stream that said nothing (the channel plugin · an old host)
        assert payload["conversation_id"] == str(w.r_agents)
        assert {"member_id", "state"} <= set(by[str(w.g_p)]), by    # what the old clients read is still there
    finally:
        await engine.dispose()


async def test_no_stream_row_and_a_stale_one_read_false(monkeypatch):
    from app.core.config import settings
    from app.routers.agent_gateway import _SESSION_FRESH_TTL
    from app.services import chat_presence

    monkeypatch.setattr(settings, "presence_online_redis_enabled", False)
    engine, Session, w = await _world()
    try:
        await _row(Session, w.g_p, "host", age_sec=_SESSION_FRESH_TTL + 60)   # a host row that only waits to expire
        # g_2: no row at all (a webhook agent)
        for a in (w.g_p, w.g_2):
            await chat_presence.set_working(str(w.r_agents), str(a))
        payload = await _event_payload(monkeypatch, w, w.r_agents)
        assert all(i["host_run"] is False for i in payload["working"]), payload
    finally:
        await engine.dispose()


async def test_a_failed_read_of_host_run_costs_no_list_item(monkeypatch):
    from app.services import agent_push_reach, chat_presence

    engine, Session, w = await _world()
    try:
        await chat_presence.set_working(str(w.r_agents), str(w.g_p))

        async def _boom(*a, **k):
            raise RuntimeError("db hiccup")

        monkeypatch.setattr(agent_push_reach, "host_run_agent_ids", _boom)
        payload = await _event_payload(monkeypatch, w, w.r_agents)
        assert [i["member_id"] for i in payload["working"]] == [str(w.g_p)], payload   # the list is whole
        assert payload["working"][0]["host_run"] is False, payload                     # …and says «not a host» (the choice is simply not drawn)
    finally:
        await engine.dispose()


async def test_an_empty_list_stays_an_empty_list(monkeypatch):
    engine, Session, w = await _world()
    try:
        payload = await _event_payload(monkeypatch, w, w.r_agents)
        assert payload["working"] == [], payload
    finally:
        await engine.dispose()


def test_one_helper_serves_the_route_and_the_event():
    """the REST answer and the event cannot drift apart: both go through `with_host_run`, and neither reads the client's word itself"""
    reach = (APP / "services" / "agent_push_reach.py").read_text(encoding="utf-8")
    assert "async def with_host_run(" in reach
    assert "with_host_run(" in (APP / "routers" / "conversations.py").read_text(encoding="utf-8")
    assert "with_host_run(" in (APP / "services" / "presence_events.py").read_text(encoding="utf-8")
    for p in ("routers/conversations.py", "services/presence_events.py"):
        assert "client_kind" not in (APP / p).read_text(encoding="utf-8"), p


async def test_when_redis_cannot_answer_a_row_that_only_waits_to_expire_is_not_a_live_host(monkeypatch):
    """codex (security lens): with Redis presence on but ANSWERING NOTHING (an outage), the old rule reads «any row» as alive — a stale host row would then read as host-run. For the display-only flag a stale row does not count"""
    from app.core.config import settings
    from app.routers.agent_gateway import _SESSION_FRESH_TTL
    from app.services import agent_push_reach, presence_online

    monkeypatch.setattr(settings, "presence_online_redis_enabled", True)
    monkeypatch.setattr(settings, "redis_url", "redis://unreachable.invalid:6379/0")

    async def _no_answer(_agent):
        return None

    monkeypatch.setattr(presence_online, "is_online", _no_answer)
    engine, Session, w = await _world()
    try:
        await _row(Session, w.g_p, "host", age_sec=_SESSION_FRESH_TTL + 60)   # a stale host row
        await _row(Session, w.g_2, "host")                                    # a fresh host row
        async with Session() as s:
            got = await agent_push_reach.host_run_agent_ids(s, {w.g_p, w.g_2})
        assert got == {w.g_2}, got
        # …and the reach decision keeps its old reading (any row) — only the display-only flag is stricter
        async with Session() as s:
            live = await agent_push_reach._agents_with_live_stream(s, sorted({w.g_p, w.g_2}))
        assert live == {w.g_p, w.g_2}, live
    finally:
        await engine.dispose()


async def test_when_redis_answers_online_the_row_is_not_judged_by_its_age(monkeypatch):
    """with Redis answering, `last_seen_at` is not kept fresh (the stream does not touch it): an online host with an old row is still a host"""
    from app.core.config import settings
    from app.routers.agent_gateway import _SESSION_FRESH_TTL
    from app.services import agent_push_reach, presence_online

    monkeypatch.setattr(settings, "presence_online_redis_enabled", True)
    monkeypatch.setattr(settings, "redis_url", "redis://unreachable.invalid:6379/0")

    async def _online(_agent):
        return True

    monkeypatch.setattr(presence_online, "is_online", _online)
    engine, Session, w = await _world()
    try:
        await _row(Session, w.g_p, "host", age_sec=_SESSION_FRESH_TTL + 600)
        async with Session() as s:
            assert await agent_push_reach.host_run_agent_ids(s, {w.g_p}) == {w.g_p}
    finally:
        await engine.dispose()


def test_the_presence_list_is_read_before_a_database_connection_is_taken():
    src = (APP / "services" / "presence_events.py").read_text(encoding="utf-8")
    body = src.split("async def emit_conversation_working")[1].split("async def emit_presence")[0]
    assert body.index("await chat_presence.list_working(") < body.index("async with async_session_factory()"), "the Redis read must come first"
    assert body.count("chat_presence.list_working(") == 1

