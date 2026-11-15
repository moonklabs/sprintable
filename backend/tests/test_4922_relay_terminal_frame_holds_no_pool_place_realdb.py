"""story 4922 (PO 11-14, after 5765) — the device relay stream's two terminal frames (`access_revoked` · `remote_control_off`) are sent with no DB session held.

`generate()` used to `yield` those frames from INSIDE `async with async_session_factory() as s:` and `return` right after. Starlette's StreamingResponse
does not close the generator when a send fails (it stops iterating), and those two frames are exactly the moments a daemon goes away — a revoked device
drops its connection, a turned-off org ends the line — so a generator parked at that `yield` kept a pool connection and its open read transaction until the
garbage collector found it (pool 3 + 1; the same shape 5765 removed from the events stream).

Each test reads the stream to the terminal frame and stops there — the client «gone», nothing resumes or closes the generator — and asks the app engine's pool
how many places are checked out. The router is called directly and its body iterator read in this loop (as test_4607 does).
"""
from __future__ import annotations

import pytest

from tests.test_4424_desktop_setup_realdb import (  # noqa: F401 — fixtures (autouse ones apply here too)
    _addresses,
    _client,
    _dispose_global_engine_after_test,
    anyio_backend,
    world,
)
from tests.test_4424_desktop_setup_realdb import ORG, _sql  # noqa: E402
from tests.test_4529_desktop_relay_realdb import _device, _remote_control_on  # noqa: F401
from tests.test_4607_relay_stream_first_byte_realdb import _open

pytestmark = pytest.mark.anyio


async def _read_to(resp, marker: str) -> list[str]:
    import asyncio

    sent: list[str] = []
    while True:
        chunk = await asyncio.wait_for(resp.body_iterator.__anext__(), timeout=20)
        sent.append(chunk)
        if chunk.startswith(marker):
            return sent


async def test_01_a_revoked_device_whose_client_is_gone_after_access_revoked_holds_no_pool_place(world, monkeypatch):
    import app.routers.desktop_relay as router_mod
    from app.core.database import engine as app_engine

    monkeypatch.setattr(router_mod, "_RECHECK_SEC", 0)
    async with _client() as c:
        d = await _device(c, name="d4922 revoked")
    db, resp = await _open(d["device_token"])
    try:
        # the REAL revocation (no stub: a stubbed check never touches the database, so no connection would be checked out and the test could not fail)
        await _sql(f"UPDATE desktop_setups SET revoked_at = now() WHERE id = '{d['setup_id']}'")
        sent = await _read_to(resp, "event: access_revoked")
        assert sent[0] == ": open\n\n" and "device_disconnected" in sent[-1], sent
        held = app_engine.sync_engine.pool.checkedout()
        # mutant: the terminal frame yielded inside `async with … as s` → the stream's session (connection + open read transaction) stays checked out → RED
        assert held == 0, f"{held} pool place(s) held by a relay stream that only waits for its client after access_revoked (story 4922)"
    finally:
        await resp.body_iterator.aclose()
        await db.close()


async def test_02_an_org_turned_off_whose_client_is_gone_after_remote_control_off_holds_no_pool_place(world, monkeypatch):
    import app.routers.desktop_relay as router_mod
    from app.core.database import engine as app_engine
    from app.services import remote_control

    monkeypatch.setattr(router_mod, "_RECHECK_SEC", 0)
    async with _client() as c:
        d = await _device(c, name="d4922 switched off")
    db, resp = await _open(d["device_token"])
    try:
        await _sql(f"UPDATE organizations SET remote_control_enabled_at = NULL WHERE id = '{ORG}'")  # the org turns it off (real, not stubbed)
        sent = await _read_to(resp, f"event: {remote_control.OFF_CODE}")
        assert sent[0] == ": open\n\n" and not any("access_revoked" in s for s in sent), sent
        held = app_engine.sync_engine.pool.checkedout()
        assert held == 0, f"{held} pool place(s) held by a relay stream that only waits for its client after remote_control_off (story 4922)"
    finally:
        await resp.body_iterator.aclose()
        await db.close()
