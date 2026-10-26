"""story #4774 — a connection a PERSON opened keeps working after the person was removed from the organization (measured on a real socket server: the SSE stream delivered
events for 110 s after the removal).

A real socket server (uvicorn, lifespan off) in this process and a real SSE client (httpx stream) — the same measurement harness as the story's AC1, now with the assertions. Pins:
  02 SSE: an event pushed for the removed person's member after the removal is NOT delivered and the stream ends with `access_revoked`; a living person's stream keeps receiving;
  03 a person who lives on passes every check (nothing closes) and one check costs exactly one SQL statement;
  05 the recheck reads the same seat the request authentication reads: an ACCOUNT DELETION or an ORGANIZATION DELETE ends the seat too.
The WebSocket cells (01·01b·01c·04) follow with the ws_chat.py part of the story, after story 4775 (same file) is merged."""
from __future__ import annotations

import asyncio
import json
import os
import socket
import time
import uuid

import httpx
import pytest
import uvicorn

from tests.test_4752_account_delete_realdb import _close, _world
from tests.test_4769_member_removal_closes_devices_realdb import _remove, _seat
from tests.test_4772_request_auth_org_membership_realdb import _bearer, _project_of, _two_organizations

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


@pytest.fixture(autouse=True)
def _no_rate_limit(monkeypatch):
    from app.core.rate_limit import limiter
    monkeypatch.setattr(limiter, "enabled", False)


def _free_port() -> int:
    s = socket.socket()
    s.bind(("127.0.0.1", 0))
    port = s.getsockname()[1]
    s.close()
    return port


class _Server:
    """A real socket server of the app in this process (so a real client can hold a connection open across a removal)."""

    def __init__(self, app) -> None:
        self.port = _free_port()
        self.server = uvicorn.Server(uvicorn.Config(app, host="127.0.0.1", port=self.port, lifespan="off", log_level="warning"))
        self.task: asyncio.Task | None = None

    async def __aenter__(self):
        self.task = asyncio.create_task(self.server.serve())
        for _ in range(100):
            if self.server.started:
                return self
            await asyncio.sleep(0.1)
        raise RuntimeError("server did not start")

    async def __aexit__(self, *exc):
        self.server.should_exit = True
        await asyncio.sleep(0.3)
        if self.task is not None:
            self.task.cancel()


async def _scalar(w, q: str, **kw):
    from sqlalchemy import text
    async with w.Session() as s:
        return (await s.execute(text(q), kw)).scalar_one()


async def _world_with_agent():
    """Org X (owner O, admin M with a single organization), an agent of X and the tokens."""
    engine, w = await _world()
    owner_email, org_x, org_y, m, m_email, tok_x, tok_y = await _two_organizations(w)
    # one organization for M unless a test is about two (a TeamMember row per organization is the thing under test in 04)
    await w.sql("DELETE FROM project_access WHERE org_member_id IN (SELECT id FROM org_members WHERE org_id = :y AND user_id = :u)", y=org_y, u=m)
    owner = await w.tokens(owner_email)
    project = await _project_of(w, org_x)
    r = await w.client.post("/api/v2/agents", headers=_bearer(owner, org_x), json={"name": "Agent 4774", "scope_mode": "projects", "project_ids": [str(project)]})
    assert r.status_code == 201, r.text
    owner_uid = await _scalar(w, "SELECT id FROM users WHERE email = :e", e=owner_email)
    return engine, w, owner_email, owner, owner_uid, org_x, org_y, m, tok_x, tok_y, r.json()["id"], project


async def _ws_url(port: int, agent_id, tokens: dict) -> str:
    return f"ws://127.0.0.1:{port}/ws/chat/{agent_id}?token={tokens['access_token']}"


async def test_02_an_sse_stream_of_a_removed_person_gets_nothing_more_and_ends_access_revoked():
    from app.routers import events as ev

    engine, w, owner_email, owner, owner_uid, org_x, org_y, m, tok_x, tok_y, agent_id, project = await _world_with_agent()
    try:
        seat = await _seat(w, org_x, m)
        owner_seat = await _seat(w, org_x, owner_uid)
        async with _Server(w.app) as srv:
            got_m: list[str] = []
            got_owner: list[str] = []

            async def reader(tokens, member, sink):
                async with httpx.AsyncClient(timeout=None) as c:
                    async with c.stream("GET", f"http://127.0.0.1:{srv.port}/api/v2/events/stream?member_id={member}", headers=_bearer(tokens)) as resp:
                        async for line in resp.aiter_lines():
                            if line:
                                sink.append(line)

            tm = asyncio.create_task(reader(tok_x, seat, got_m))
            to = asyncio.create_task(reader(owner, owner_seat, got_owner))
            await asyncio.sleep(1.5)
            ev._push_to_agent(str(seat), {"event_type": "probe", "event_id": str(uuid.uuid4()), "note": "before"})
            ev._push_to_agent(str(owner_seat), {"event_type": "probe", "event_id": str(uuid.uuid4()), "note": "before"})
            await asyncio.sleep(1)
            assert any("probe" in x for x in got_m), "control: the seated person's stream delivers"
            assert (await _remove(w, owner_email, org_x, m)).status_code == 200
            before_n = len(got_m)
            ev._push_to_agent(str(seat), {"event_type": "probe", "event_id": str(uuid.uuid4()), "note": "AFTER"})
            ev._push_to_agent(str(owner_seat), {"event_type": "probe", "event_id": str(uuid.uuid4()), "note": "owner after"})
            await asyncio.wait_for(tm, 15)   # the stream of the removed person ends by itself, soon
            assert not any("AFTER" in x for x in got_m[before_n:]), got_m
            assert any("access_revoked" in x for x in got_m[before_n:]), got_m
            # the living owner kept receiving, and is still connected
            await asyncio.sleep(1)
            assert any("owner after" in x for x in got_owner), got_owner
            assert not to.done(), "a living person's stream is not closed"
            to.cancel()
    finally:
        await _close(engine, w)


async def test_03_the_recheck_passes_for_a_person_who_lives_on_and_costs_one_indexed_read():
    """A person with a live seat: `SeatRecheck.due` answers None every time (nothing closes), and one call is exactly one SQL statement (the cost table of the story)."""
    from sqlalchemy import event

    from app.core.database import engine as global_engine
    from app.services.stream_access import SeatRecheck

    engine, w, owner_email, owner, owner_uid, org_x, org_y, m, tok_x, tok_y, agent_id, project = await _world_with_agent()
    try:
        count = {"n": 0}

        def _count(conn, cursor, statement, parameters, context, executemany):
            count["n"] += 1

        event.listen(global_engine.sync_engine, "before_cursor_execute", _count)
        try:
            seat = SeatRecheck(m, org_x)
            assert await seat.due(0) is None
            assert count["n"] == 1, f"one seat read per check, got {count['n']}"
            for _ in range(5):
                assert await seat.due(0) is None
            assert count["n"] == 6
            assert (await _remove(w, owner_email, org_x, m)).status_code == 200
            assert await seat.due(0) == "seat_ended"
        finally:
            event.remove(global_engine.sync_engine, "before_cursor_execute", _count)
    finally:
        await _close(engine, w)


async def test_05_an_organization_delete_and_an_account_deletion_end_the_person_s_open_connection_too():
    from app.services.stream_access import SeatRecheck

    engine, w, owner_email, owner, owner_uid, org_x, org_y, m, tok_x, tok_y, agent_id, project = await _world_with_agent()
    try:
        owner_seat = SeatRecheck(owner_uid, org_x)
        m_seat = SeatRecheck(m, org_x)
        assert await owner_seat.due(0) is None and await m_seat.due(0) is None
        # M deletes the account: the seat ends with it
        assert (await w.delete(tok_x)).status_code == 200
        assert await m_seat.due(0) == "seat_ended"
        # the organization is deleted by its owner: every seat of it ends
        name = await _scalar(w, "SELECT name FROM organizations WHERE id = :o", o=org_x)
        owner = await w.tokens(owner_email)
        r = await w.client.request("DELETE", f"/api/v2/organizations/{org_x}", headers=_bearer(owner), json={"confirmation": name})
        assert r.status_code == 200, r.text
        assert await owner_seat.due(0) == "seat_ended"
    finally:
        await _close(engine, w)
