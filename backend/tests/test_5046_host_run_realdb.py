"""story 5046 (C13) — WHICH working agents the «지금 끼어들기 / 끝나고 이어서» choice is for: the ones a HOST runs. A host says so when it opens its stream (`X-Sprintable-Client: host`); the server keeps that on the
session row (`client_kind`) and tells the room's readers per working agent (`host_run`). The web draws the choice only for host-run agents — the other roads (a webhook · the channel plugin) have nobody who reads `delivery_mode`,
so «끝나고 이어서» there would be a promise nothing keeps.

⚠ The header is the CLIENT'S OWN WORD, not a login: it decides nothing but what the web DRAWS. It never gates a permission, a delivery road, a key, a room's read, or what the agent receives. Red when:
 · any word but exactly `host` (other case · padding · a list · empty · missing) is kept as «host» · a row of another agent leaks into an agent's answer · a mix (a host session AND another kind) says host-run ·
   an agent with no session row (a webhook agent) says host-run · the old host (no header) says host-run — so the choice never stands for it, and nothing changes for it ·
 · `client_kind` is read anywhere that is not the display (the census below: a new reader of it must be a decision made on purpose) · the stream does not store it.
"""
from __future__ import annotations

import pathlib
import re
import uuid
from datetime import datetime, timedelta, timezone

import pytest
from sqlalchemy import text

from tests.test_4846_ac14_room_reads_realdb import _as
from tests.test_4846_org_chat_rooms_realdb import (  # noqa: F401 — fixtures used by name
    _REAL_DB_URL,
    _dispose_global_engine_after_test,
    _world,
)

APP = pathlib.Path(__file__).resolve().parents[1] / "app"


# ---- pure (no database): the one word that counts ---------------------------------------------------------------------------------------------------------------
def test_only_the_exact_word_host_is_host():
    from starlette.datastructures import Headers

    from app.routers.agent_gateway import client_kind_of

    h = lambda v: Headers({"x-sprintable-client": v} if v is not None else {})  # noqa: E731
    assert client_kind_of(h("host")) == "host"
    for bad in (None, "", "Host", "HOST", " host", "host ", "host,plugin", "plugin", "hosts", "host\n", "h"):
        assert client_kind_of(h(bad)) is None, bad
    # the NAME is case-insensitive like every header name
    assert client_kind_of(Headers({"X-Sprintable-Client": "host"})) == "host"


def test_the_stream_stores_what_the_header_said_on_the_session_row():
    src = (APP / "routers" / "agent_gateway.py").read_text(encoding="utf-8")
    assert "client_kind_of(request.headers)" in src
    assert re.search(r"AgentGatewaySession\(\s*id=session_id,.{0,400}?client_kind=_client_kind", src, re.S), "the session row is made without the client kind"


def test_client_kind_is_read_only_where_it_is_displayed():
    """the census: the only code that mentions `client_kind` — a new place must be added here on purpose (a header the client writes must not become a decision)"""
    found = {str(p.relative_to(APP)) for p in APP.rglob("*.py") if "client_kind" in p.read_text(encoding="utf-8", errors="ignore")}
    assert found == {"models/agent_gateway.py", "routers/agent_gateway.py", "services/agent_push_reach.py"}, found
    # …and the two roads that DECIDE who gets a message (the push-reach decision for `set_working` · the webhook targets) never read it
    reach = (APP / "services" / "agent_push_reach.py").read_text(encoding="utf-8")
    decision = reach.split("async def host_run_agent_ids")[0]
    assert "client_kind" not in decision, "the reach decision (who is shown as working / reached) must not read the client's own word"


@pytest.fixture
def anyio_backend():
    return "asyncio"


async def _session_row(Session, agent, kind, *, age_sec=0):
    t = datetime.now(timezone.utc) - timedelta(seconds=age_sec)
    async with Session() as s:
        await s.execute(
            text("INSERT INTO agent_gateway_sessions (id, agent_id, connected_at, last_seen_at, last_ack_seq, client_kind) VALUES (:i, :a, :t, :t, 0, :k)"),
            {"i": uuid.uuid4(), "a": agent, "t": t, "k": kind},
        )
        await s.commit()


async def _host_run(Session, ids):
    from app.services.agent_push_reach import host_run_agent_ids

    async with Session() as s:
        return await host_run_agent_ids(s, set(ids))


@pytest.mark.skipif(not _REAL_DB_URL, reason="real Postgres 필요")
@pytest.mark.anyio
async def test_host_run_is_every_live_session_saying_host_and_nothing_else():
    engine, Session, w = await _world()
    try:
        a, b, c, d = w.g_p, w.g_2, w.g_admin, w.g_plain
        await _session_row(Session, a, "host")            # a host
        await _session_row(Session, b, None)              # the plugin / an old host (no word)
        await _session_row(Session, c, "host")           # a host AND another kind at once → not host-run (a message can go to either)
        await _session_row(Session, c, None)
        # d: no session row at all (a webhook agent · an agent not connected)
        assert await _host_run(Session, [a, b, c, d]) == {a}
        assert await _host_run(Session, [b, c, d]) == set()      # another agent's row never leaks into the answer
        assert await _host_run(Session, []) == set()
    finally:
        await engine.dispose()


@pytest.mark.skipif(not _REAL_DB_URL, reason="real Postgres 필요")
@pytest.mark.anyio
async def test_a_row_that_only_waits_to_expire_is_not_a_live_host(monkeypatch):
    """codex (security lens): a lifespan end STAMPS the row to expire instead of deleting it — a host that is gone, then a webhook marks the agent working, must not read as host-run"""
    from app.core.config import settings
    from app.routers.agent_gateway import _SESSION_FRESH_TTL

    monkeypatch.setattr(settings, "presence_online_redis_enabled", False)  # the rows' own freshness is the liveness (the Redis road reads liveness from Redis)
    engine, Session, w = await _world()
    try:
        old = _SESSION_FRESH_TTL + 60
        a, b, c = w.g_p, w.g_2, w.g_admin
        await _session_row(Session, a, "host", age_sec=old)                 # only a stale host row → no live stream at all
        await _session_row(Session, b, "host")                              # a live host row …
        await _session_row(Session, b, None, age_sec=old)                   # … beside a STALE other row (a dead plugin connection): the stale one is not counted
        await _session_row(Session, c, "host", age_sec=old)                 # a stale host row beside a LIVE plugin row → not host-run (the live one decides)
        await _session_row(Session, c, None)
        assert await _host_run(Session, [a, b, c]) == {b}
    finally:
        await engine.dispose()


@pytest.mark.skipif(not _REAL_DB_URL, reason="real Postgres 필요")
@pytest.mark.anyio
async def test_the_rooms_working_list_says_host_run_per_agent_and_changes_nothing_else():
    engine, Session, w = await _world()
    try:
        await _session_row(Session, w.g_p, "host")
        r = await _as(Session, w, "participant", "POST", f"/api/v2/conversations/{w.r_human}/messages", {"content": "hello", "mentioned_ids": [str(w.g_p)]})
        assert r.status_code == 201, r.text
        got = await _as(Session, w, "participant", "GET", f"/api/v2/conversations/{w.r_human}/working")
        assert got.status_code == 200, got.text
        items = got.json()["data"]
        mine = [i for i in items if i["member_id"] == str(w.g_p)]
        assert len(mine) == 1 and mine[0]["host_run"] is True, items
        assert {"member_id", "state", "updated_at"} <= set(mine[0]), mine  # what was there stays
    finally:
        await engine.dispose()


@pytest.mark.skipif(not _REAL_DB_URL, reason="real Postgres 필요")
@pytest.mark.anyio
async def test_an_agent_that_is_not_a_host_is_still_listed_as_working_but_not_host_run():
    engine, Session, w = await _world()
    try:
        await _session_row(Session, w.g_p, None)   # the channel plugin, or an old host that sends no word
        r = await _as(Session, w, "participant", "POST", f"/api/v2/conversations/{w.r_human}/messages", {"content": "hello", "mentioned_ids": [str(w.g_p)]})
        assert r.status_code == 201, r.text
        got = await _as(Session, w, "participant", "GET", f"/api/v2/conversations/{w.r_human}/working")
        mine = [i for i in got.json()["data"] if i["member_id"] == str(w.g_p)]
        assert len(mine) == 1 and mine[0]["host_run"] is False, got.json()
    finally:
        await engine.dispose()
