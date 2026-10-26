"""story 4788 (INFRA-DIET ③ · PO 10-26) — the agent stream does not send, on every reconnect, the events its client never acts on.

Prod, 82-minute sample: 154 Bun-client streams of `GET /api/v2/agent/stream` sent 25.9 MB EACH (≈44 GB a day). The stream replays everything after the agent's cursor on every connect; the Claude
Code plugin acts on a handful of event types and drops the rest BEFORE acking them, so the cursor stops at the last event it acted on and everything after it — events nobody there acts on —
comes again on every reconnect, for ever. These tests run the real `agent_stream()` generator over a real database (the harness of story 2381):
- the before: a client that sends no declaration gets the whole tail again, every time (the numbers are printed — AC1);
- a client that declares the types it acts on (`X-Sprintable-Accept-Events` — the plugin 0.9.23 sends its allow-list) is sent only those — the tail it would drop costs nothing, on connect and live;
- no loss: an event it acts on inside or after that tail still arrives; the agent's cursor is never moved by a declaration, so another connection of the same agent still gets everything;
- a malformed declaration is ignored as a whole (nothing partially dropped); the user agent is NOT a signal (the plugin and the SDK adapters are both Bun)."""
from __future__ import annotations

import asyncio
import json
import logging
import os
import re
import uuid

import pytest

from tests.agent_stream_auth import agent_stream_claims, seed_agent_stream_key
from tests.test_2381_ac4_live_wake_delivery_realdb import _patch_side_effects, _seed_agent, _session_factory

_REAL_DB_URL = os.getenv("PARITY_TEST_DATABASE_URL") or os.getenv("ALEMBIC_DATABASE_URL")

pytestmark = [
    pytest.mark.skipif(not _REAL_DB_URL, reason="통합 테스트는 실 PG(PARITY/ALEMBIC_DATABASE_URL) 필요"),
    pytest.mark.destructive_schema,
    pytest.mark.anyio,
]

FYI = "conversation.gate_created"  # an event type the plugin never acts on (not in its allow-list)
ACTS = "dispatched"


@pytest.fixture
def anyio_backend():
    return "asyncio"


class _Request:
    def __init__(self, headers: dict[str, str]):
        self.headers = {k.lower(): v for k, v in headers.items()}

    async def is_disconnected(self) -> bool:
        return False


async def _open(ag, Session, agent_id, org_id, headers):
    from app.dependencies.auth import AuthContext

    async with Session() as s:
        key_id = await seed_agent_stream_key(s, agent_id)
    auth = AuthContext(user_id=str(agent_id), email=None, claims=agent_stream_claims(key_id, org_id))
    resp = await ag.agent_stream(_Request(headers), auth=auth)
    assert resp.status_code == 200
    return resp.body_iterator


class _Reader:
    """Reads a stream's frames without ever cancelling it: a pending `__anext__` is kept between calls (cancelling it would end the generator — its cancel handler swallows the error and the stream
    "closes normally"), and `close()` ends the stream the one way it can be ended."""

    def __init__(self, agen):
        self.agen = agen
        self.task = None

    async def frames(self, quiet: float = 0.6) -> list[str]:
        """the frames that come until the stream goes quiet (heartbeats left out)"""
        out: list[str] = []
        while True:
            if self.task is None:
                self.task = asyncio.create_task(self.agen.__anext__())
            done, _ = await asyncio.wait({self.task}, timeout=quiet)
            if self.task not in done:
                return out
            frame = self.task.result()
            self.task = None
            if not frame.startswith("event: heartbeat"):
                out.append(frame)

    async def close(self) -> None:
        if self.task is not None:
            self.task.cancel()
            try:
                await self.task
            except (asyncio.CancelledError, StopAsyncIteration):
                pass
            self.task = None
        await self.agen.aclose()


def _types(frames: list[str]) -> list[str]:
    return [json.loads(next(line for line in f.splitlines() if line.startswith("data: "))[6:])["event_type"] for f in frames]


async def _event(Session, ids, event_type: str, size: int = 600) -> int:
    from app.models.event import Event
    from app.services.event_seq import assign_recipient_seq

    org_id, project_id, agent_id = ids
    async with Session() as s:
        ev = Event(project_id=project_id, org_id=org_id, event_type=event_type, recipient_id=agent_id, recipient_type="agent",
                   payload={"content": "x" * size, "title": event_type}, status="pending")
        s.add(ev)
        await s.flush()
        seq = await assign_recipient_seq(s, ev)
        await s.commit()
        return seq


async def _ack(Session, agent_id, seq: int) -> None:
    from app.models.agent_gateway import AgentEventCursor

    async with Session() as s:
        s.add(AgentEventCursor(agent_id=agent_id, acked_seq=seq))
        await s.commit()


async def _acked(Session, agent_id) -> int:
    from sqlalchemy import select

    from app.models.agent_gateway import AgentEventCursor

    async with Session() as s:
        return (await s.execute(select(AgentEventCursor.acked_seq).where(AgentEventCursor.agent_id == agent_id))).scalar_one()


async def _world(monkeypatch, tail: int = 120):
    """an agent whose client acted on 5 events (acked up to the last of them) and then got `tail` events it never acts on"""
    import app.routers.agent_gateway as ag

    _patch_side_effects(monkeypatch)
    engine, Session = await _session_factory()
    org_id, project_id, agent_id = await _seed_agent(Session)
    monkeypatch.setattr(ag, "async_session_factory", lambda: Session())
    ids = (org_id, project_id, agent_id)
    last = 0
    for _ in range(5):
        last = await _event(Session, ids, ACTS)
    await _ack(Session, agent_id, last)
    for _ in range(tail):
        await _event(Session, ids, FYI)
    return ag, engine, Session, ids


async def _cleanup(ag, engine, agent_id):
    ag._agent_connections.pop(str(agent_id), None)
    await engine.dispose()
    from app.core import shutdown as _shutdown_module

    _shutdown_module.reset_shutdown_event()


async def _connect(ag, Session, ids, headers) -> list[str]:
    reader = _Reader(await _open(ag, Session, ids[2], ids[0], headers))
    try:
        return await reader.frames()
    finally:
        await reader.close()


async def test_01_before_a_client_without_a_declaration_gets_the_whole_tail_on_every_reconnect(monkeypatch, caplog):
    """AC1 — the repro: the same tail again and again, as many bytes each time (printed). This is what every client without a declaration still gets."""
    ag, engine, Session, ids = await _world(monkeypatch)
    try:
        sizes = []
        with caplog.at_level(logging.INFO, logger="app.routers.agent_gateway"):
            for _ in range(4):
                frames = await _connect(ag, Session, ids, {"user-agent": "python-httpx/0.27"})
                assert _types(frames) == [FYI] * 120
                sizes.append(sum(len(f.encode()) for f in frames))
        print(f"\n[4788 AC1] unacked tail of 120 events · 4 reconnects with no declaration → bytes per connect {sizes}")
        assert len(set(sizes)) == 1 and sizes[0] > 120 * 600
        lines = [r.getMessage() for r in caplog.records if r.getMessage().startswith("agent_stream backfill")]
        assert len(lines) == 4 and all("mode=all" in ln and "rows=120" in ln and f"bytes={sizes[0]}" in ln and f"{FYI}:120" in ln for ln in lines), lines
        # who: the agent's member id, the first 8 characters of the key's id and the client's name — ids only (PO 10-26: the prod stream came through a proxy and could not be told apart)
        assert all(f"agent={ids[2]} " in ln and " ua=python-httpx/0.27 " in ln and re.search(r" key=[0-9a-f]{8} ", ln) for ln in lines), lines
    finally:
        await _cleanup(ag, engine, ids[2])


PLUGIN = {"x-sprintable-accept-events": "conversation.message_created, conversation:mention, dispatched, handoff, kickoff, qa_request, review_request, deploy_request, story_assigned"}


async def test_02_a_client_that_declares_what_it_acts_on_is_sent_only_that(monkeypatch, caplog):
    ag, engine, Session, ids = await _world(monkeypatch)
    try:
        before = await _acked(Session, ids[2])
        with caplog.at_level(logging.INFO, logger="app.routers.agent_gateway"):
            for _ in range(4):
                assert await _connect(ag, Session, ids, {**PLUGIN, "user-agent": "Bun/1.2.3"}) == [], "the tail of events it would drop costs nothing"
        assert await _acked(Session, ids[2]) == before, "a filter never moves the agent's cursor"
        assert all("mode=declared" in r.getMessage() and "rows=0" in r.getMessage() and "bytes=0" in r.getMessage()
                   for r in caplog.records if r.getMessage().startswith("agent_stream backfill"))
    finally:
        await _cleanup(ag, engine, ids[2])


async def test_03_no_loss_an_event_it_acts_on_still_arrives_inside_or_after_the_tail(monkeypatch):
    ag, engine, Session, ids = await _world(monkeypatch, tail=30)
    try:
        mid = await _event(Session, ids, ACTS)  # after the 30 events nobody acts on
        for _ in range(30):
            await _event(Session, ids, FYI)
        last = await _event(Session, ids, "conversation.message_created")
        frames = await _connect(ag, Session, ids, {**PLUGIN, "user-agent": "Bun/1.2.3"})
        got = [(t, json.loads(next(line for line in f.splitlines() if line.startswith("data: "))[6:])["recipient_seq"]) for t, f in zip(_types(frames), frames)]
        assert got == [(ACTS, mid), ("conversation.message_created", last)], got
    finally:
        await _cleanup(ag, engine, ids[2])


async def test_04_another_connection_of_the_same_agent_still_gets_everything(monkeypatch):
    """The cursor is the agent's, not the connection's: a connection that declared its types does not take away what the desktop app (no `Bun` agent) needs."""
    ag, engine, Session, ids = await _world(monkeypatch, tail=40)
    try:
        assert await _connect(ag, Session, ids, {**PLUGIN, "user-agent": "Bun/1.2.3"}) == []
        frames = await _connect(ag, Session, ids, {"user-agent": "node", "x-sprintable-receiver-id": "rcv_" + "A" * 22})
        assert _types(frames) == [FYI] * 40
    finally:
        await _cleanup(ag, engine, ids[2])


async def test_05_live_a_wake_for_an_event_it_does_not_act_on_sends_nothing_and_one_it_acts_on_arrives(monkeypatch):
    ag, engine, Session, ids = await _world(monkeypatch, tail=3)
    try:
        reader = _Reader(await _open(ag, Session, ids[2], ids[0], {**PLUGIN, "user-agent": "Bun/1.2.3"}))
        try:
            assert await reader.frames(quiet=0.5) == []  # (the heartbeat, then the replay: nothing it acts on)
            await _event(Session, ids, FYI)
            assert await reader.frames(quiet=0.8) == [], "a live event of a type it does not act on is not sent"
            seq = await _event(Session, ids, "conversation:mention")
            frames = await reader.frames(quiet=0.8)
            assert _types(frames) == ["conversation:mention"] and f"id: {seq}\n" in frames[0]
        finally:
            await reader.close()
    finally:
        await _cleanup(ag, engine, ids[2])


async def test_06_a_declared_set_is_what_is_sent_and_a_malformed_one_is_ignored_whole(monkeypatch):
    ag, engine, Session, ids = await _world(monkeypatch, tail=10)
    try:
        assert _types(await _connect(ag, Session, ids, {"x-sprintable-accept-events": f"{ACTS}, {FYI}"})) == [FYI] * 10
        assert await _connect(ag, Session, ids, {"x-sprintable-accept-events": ACTS}) == []
        # a declaration with a token that is not a type name: ignored as a whole (everything is sent) — never read partially
        assert _types(await _connect(ag, Session, ids, {"x-sprintable-accept-events": f"{ACTS}, bad token!"})) == [FYI] * 10
    finally:
        await _cleanup(ag, engine, ids[2])


def test_07_the_parsing_and_that_the_user_agent_is_no_signal():
    from app.services.agent_stream_accept import MAX_DECLARED_TYPES, accepted_event_types, parse_accept_header

    assert parse_accept_header(None) is None and parse_accept_header("") is None and parse_accept_header(" , ,") is None
    assert parse_accept_header("a, b.c ,d:e") == frozenset({"a", "b.c", "d:e"})
    assert parse_accept_header("a, b c") is None and parse_accept_header("x" * 65) is None
    assert parse_accept_header(",".join(f"t{i}" for i in range(MAX_DECLARED_TYPES))) is not None
    assert parse_accept_header(",".join(f"t{i}" for i in range(MAX_DECLARED_TYPES + 1))) is None
    assert accepted_event_types({"x-sprintable-accept-events": "a,b"}) == (frozenset({"a", "b"}), "declared")
    # the Claude Code plugin and the TypeScript SDK adapters are both Bun with the same headers: the user agent says nothing about what a client acts on
    assert accepted_event_types({"user-agent": "Bun/1.1.0"}) == (None, "all") and accepted_event_types({}) == (None, "all")
    assert accepted_event_types({"user-agent": "Bun/1.1.0", "x-sprintable-accept-events": "bad token!"}) == (None, "all")


async def test_09_the_log_line_carries_ids_only_and_a_hostile_user_agent_is_cleaned(monkeypatch, caplog):
    ag, engine, Session, ids = await _world(monkeypatch, tail=2)
    try:
        with caplog.at_level(logging.INFO, logger="app.routers.agent_gateway"):
            await _connect(ag, Session, ids, {"user-agent": "Bun/1.4.2 \n injected=1 " + "x" * 100})
        (line,) = [r.getMessage() for r in caplog.records if r.getMessage().startswith("agent_stream backfill")]
        assert "\n" not in line and "injected=1" not in line, line
        ua = line.split(" ua=")[1].split(" mode=")[0]
        assert len(ua) <= 40 and ua.startswith("Bun/1.4.2") and re.fullmatch(r"[A-Za-z0-9._/ -]*", ua), ua
    finally:
        await _cleanup(ag, engine, ids[2])


async def test_10_a_non_durable_push_is_filtered_by_the_declaration_too(monkeypatch):
    """The legacy direct push (no recipient_seq) goes through the same queue: a declared connection is sent the types it declared, and no others (codex 10-26)."""
    ag, engine, Session, ids = await _world(monkeypatch, tail=0)
    try:
        reader = _Reader(await _open(ag, Session, ids[2], ids[0], PLUGIN))
        try:
            assert await reader.frames(quiet=0.5) == []
            ag._push_to_agent_v2(str(ids[2]), {"event_type": "presence", "content": "x"})
            assert await reader.frames(quiet=0.8) == [], "a push of a type it did not declare is not sent"
            ag._push_to_agent_v2(str(ids[2]), {"event_type": "conversation.message_created", "content": "hello"})
            frames = await reader.frames(quiet=0.8)
            assert _types(frames) == ["conversation.message_created"], frames
        finally:
            await reader.close()
        undeclared = _Reader(await _open(ag, Session, ids[2], ids[0], {"user-agent": "node"}))
        try:
            assert await undeclared.frames(quiet=0.5) == []
            ag._push_to_agent_v2(str(ids[2]), {"event_type": "presence", "content": "x"})
            assert _types(await undeclared.frames(quiet=0.8)) == ["presence"], "no declaration: everything, as before"
        finally:
            await undeclared.close()
    finally:
        await _cleanup(ag, engine, ids[2])
