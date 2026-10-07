"""story #4607 (E-DESKTOP-2 · 1선 · run13b ⑪ · PO 21:02Z) — the device relay stream sends its first byte as it opens.

Measured (host-tail-30a9d340c.log): every ~5 min 20 s the server ends the stream (lifespan_reconnect) and the daemon's reconnect was
logged open 30 s later — the first heartbeat — because the front end holds the response head until the body's first byte. For those
30 s the daemon held its approvals; a permission question asked then reached the phone 29 s late. Now the stream's first chunk is an
SSE comment (`: open`), sent before any read, whatever the heartbeat.

The router is called directly and its body iterator read in this loop (reference: an SSE body over ASGITransport with real asyncpg
I/O hangs). The heartbeat is pushed out of reach so only an immediate first byte can arrive inside the wait.
"""
from __future__ import annotations

import asyncio

import pytest

from tests.test_4424_desktop_setup_realdb import (  # noqa: F401 — fixtures (autouse ones apply here too)
    _addresses,
    _client,
    _dispose_global_engine_after_test,
    anyio_backend,
    world,
)
from tests.test_4529_desktop_relay_realdb import _device, _enqueue, _remote_control_on  # noqa: F401

pytestmark = pytest.mark.anyio


class _Req:
    """what device_stream reads of its request: the cursor header and the disconnect check"""

    def __init__(self, headers: dict[str, str] | None = None) -> None:
        self.headers = headers or {}

    async def is_disconnected(self) -> bool:
        return False


async def _open(token: str, headers: dict[str, str] | None = None):
    from app.core.database import async_session_factory
    from app.routers.desktop_relay import device_stream
    from app.services import desktop_relay as relay

    db = async_session_factory()
    setup = await relay.device_for_token(db, token)
    assert setup is not None
    return db, await device_stream(_Req(headers), setup, db)


async def test_01_the_first_chunk_is_the_open_comment_before_any_heartbeat(world, monkeypatch):
    import app.routers.desktop_relay as router_mod

    # nothing else can send a byte inside the wait: the heartbeat · the recheck · the lifespan are an hour away
    for name in ("_HEARTBEAT_SEC", "_RECHECK_SEC", "_LIFESPAN_SEC"):
        monkeypatch.setattr(router_mod, name, 3600)
    monkeypatch.setattr(router_mod, "_LIFESPAN_JITTER_SEC", 0)
    async with _client() as c:
        d = await _device(c, name="d4607 first byte")
    db, resp = await _open(d["device_token"])
    try:
        # mutant: no `: open` → the first chunk waits for the heartbeat (an hour) → TimeoutError → RED
        first = await asyncio.wait_for(resp.body_iterator.__anext__(), timeout=20)
        assert first == ": open\n\n", first
    finally:
        await resp.body_iterator.aclose()
        await db.close()


async def test_02_a_waiting_command_still_follows_the_open_comment(world, monkeypatch):
    import app.routers.desktop_relay as router_mod

    monkeypatch.setattr(router_mod, "_HEARTBEAT_SEC", 3600)
    monkeypatch.setattr(router_mod, "_LIFESPAN_SEC", 3600)
    monkeypatch.setattr(router_mod, "_LIFESPAN_JITTER_SEC", 0)
    async with _client() as c:
        d = await _device(c, name="d4607 then command")
        await _enqueue(d["setup_id"], "start_session", {"agent_member_id": d["agents"][0]["member_id"], "runtime": "claude"}, "k1")
    db, resp = await _open(d["device_token"])
    try:
        chunks = [await asyncio.wait_for(resp.body_iterator.__anext__(), timeout=20) for _ in range(2)]
        assert chunks[0] == ": open\n\n"
        assert chunks[1].startswith("event: command\nid: 1\n"), chunks[1]
    finally:
        await resp.body_iterator.aclose()
        await db.close()
