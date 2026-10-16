"""story #4618 (PO 02:24Z · Mirko pairing-fanout-ac0) — the relay stream says which organization its setup belongs to, so the daemon
gives a phone paired on one setup to its sibling setups of the same organization only. The header is the setup's own org (read
from the row its device token names), never anything the caller sends."""
from __future__ import annotations

import pytest

from tests.test_4424_desktop_setup_realdb import (  # noqa: F401 — fixtures (autouse ones apply here too)
    ORG,
    ORG2,
    _addresses,
    _client,
    _dispose_global_engine_after_test,
    _sql,
    anyio_backend,
    world,
)
from tests.test_4529_desktop_relay_realdb import _device, _tok
from tests.test_4533_agent_permissions_realdb import _remote_control_on  # noqa: F401 — autouse: remote control on for ORG

pytestmark = pytest.mark.anyio

STREAM = "/api/v2/desktop/relay/stream"


@pytest.fixture(autouse=True)
def _short_stream(monkeypatch):
    from app.routers import desktop_relay as router_mod

    monkeypatch.setattr(router_mod, "_LIFESPAN_SEC", 0.3)
    monkeypatch.setattr(router_mod, "_LIFESPAN_JITTER_SEC", 0)


async def test_01_each_setup_stream_names_its_own_org(world):
    async with _client() as c:
        d1 = await _device(c, name="d4424 mac 4618a")
        d2 = await _device(c, name="d4424 mac 4618b")
        for d in (d1, d2):
            r = await c.get(STREAM, headers=_tok(d["device_token"]))
            assert r.status_code == 200
            assert r.headers.get("x-desktop-org-id") == str(ORG), d["setup_id"]


async def test_02_a_setup_of_another_org_names_that_org(world):
    async with _client() as c:
        mine = await _device(c, name="d4424 mac 4618c")
        other = await _device(c, name="d4424 mac 4618d")
        # the same Mac's second setup belongs to another organization (with its own remote control on)
        await _sql(f"UPDATE organizations SET remote_control_enabled_at = now() WHERE id = '{ORG2}'")
        await _sql(f"UPDATE desktop_setups SET org_id = '{ORG2}' WHERE id = '{other['setup_id']}'")
        a = await c.get(STREAM, headers=_tok(mine["device_token"]))
        b = await c.get(STREAM, headers=_tok(other["device_token"]))
        assert (a.headers.get("x-desktop-org-id"), b.headers.get("x-desktop-org-id")) == (str(ORG), str(ORG2))


async def test_03_a_caller_cannot_name_the_org(world):
    async with _client() as c:
        d = await _device(c, name="d4424 mac 4618e")
        r = await c.get(STREAM, headers={**_tok(d["device_token"]), "x-desktop-org-id": str(ORG2)})
        assert r.headers.get("x-desktop-org-id") == str(ORG)
        # no stream, no header: a refused token says nothing about any org
        bad = await c.get(STREAM, headers=_tok("not-a-token"))
        assert bad.status_code == 401 and "x-desktop-org-id" not in bad.headers


async def test_05_the_stream_names_who_confirmed_the_setup_never_what_the_caller_sends(world):
    """Kadir 420 ③ · PO 05:36Z: the daemon gives a phone only to setups the same person confirmed — `X-Desktop-Confirmed-By` is the
    setup row's confirmed_by (another person's setup on the same Mac names that person) · absent when the row has none · a caller's
    value is ignored · nothing on a refused token."""
    import uuid

    async with _client() as c:
        mine = await _device(c, name="d4424 mac 4618g")
        theirs = await _device(c, name="d4424 mac 4618h")
        rows = {r[0]: r[1] for r in await _sql(fetch=f"SELECT id::text, confirmed_by::text FROM desktop_setups WHERE id IN ('{mine['setup_id']}', '{theirs['setup_id']}')")}
        assert rows[mine["setup_id"]], "the fixture's setups are confirmed by someone"
        a = await c.get(STREAM, headers={**_tok(mine["device_token"]), "x-desktop-confirmed-by": str(uuid.uuid4())})
        assert a.status_code == 200 and a.headers.get("x-desktop-confirmed-by") == rows[mine["setup_id"]]
        # the same Mac's other setup was confirmed by another person of the same org
        other_person = str(uuid.uuid4())
        await _sql(f"UPDATE desktop_setups SET confirmed_by = '{other_person}' WHERE id = '{theirs['setup_id']}'")
        b = await c.get(STREAM, headers=_tok(theirs["device_token"]))
        assert (b.headers.get("x-desktop-org-id"), b.headers.get("x-desktop-confirmed-by")) == (str(ORG), other_person)
        # a row with no confirmer: no header (the daemon gives that setup nothing)
        await _sql(f"UPDATE desktop_setups SET confirmed_by = NULL WHERE id = '{theirs['setup_id']}'")
        n = await c.get(STREAM, headers=_tok(theirs["device_token"]))
        assert n.status_code == 200 and "x-desktop-confirmed-by" not in n.headers
        bad = await c.get(STREAM, headers=_tok("not-a-token"))
        assert bad.status_code == 401 and "x-desktop-confirmed-by" not in bad.headers


async def test_04_remote_control_off_is_409_with_no_org(world):
    """Didi review 5003 (non-blocking): the 409 path ends in `_device` too — a paused device learns no org either."""
    async with _client() as c:
        d = await _device(c, name="d4424 mac 4618f")
        # the setup's org with its remote control off (ORG2 is never turned on here)
        await _sql(f"UPDATE organizations SET remote_control_enabled_at = NULL WHERE id = '{ORG2}'")
        await _sql(f"UPDATE desktop_setups SET org_id = '{ORG2}' WHERE id = '{d['setup_id']}'")
        off = await c.get(STREAM, headers=_tok(d["device_token"]))
        assert off.status_code == 409 and "x-desktop-org-id" not in off.headers
