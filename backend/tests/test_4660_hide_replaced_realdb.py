"""story 4660 (PO 2026-10-13) — a line the same machine's new setup replaced is the same computer, so the «연결된 기기» list
leaves it out. A line a person disconnected is still listed, as before (its reason is null).

Real database. The row itself is kept (closed, reason replaced_by_new_setup); only the list response skips it.
"""
from __future__ import annotations

import pytest

from app.core.config import settings
from tests.test_4424_desktop_setup_realdb import (  # noqa: F401 — fixtures (autouse ones apply here too)
    ORG,
    OWNER,
    _client,
    _code,
    _confirm,
    _dispose_global_engine_after_test,
    _person,
    _sql,
    anyio_backend,
    world,
)

pytestmark = pytest.mark.anyio

SECRET = "test-desktop-machine-key-secret-value-4660-hide"
SAME_MACHINE = "e" * 64
OTHER_MACHINE = "f" * 64
EXCHANGE = "/api/v2/desktop/setup-codes/exchange"
LIST = "/api/v2/desktop/setups"


@pytest.fixture(autouse=True)
def _addresses(monkeypatch):
    """The exchange hands over the API and MCP addresses; a deployment sets them, a test sets its own (as in 4424)."""
    monkeypatch.setenv("MCP_PUBLIC_URL", "https://mcp.d4660h.test/mcp")
    monkeypatch.setenv("FASTAPI_URL", "https://api.d4660h.test")


@pytest.fixture
def secret(monkeypatch):
    monkeypatch.setattr(settings, "channel_oauth_state_secret", SECRET)
    return SECRET


async def _device(c, name: str, device_id: str) -> dict:
    code, verifier = await _code(c, name)
    assert (await _confirm(c, code)).status_code == 200
    r = await c.post(EXCHANGE, json={"code": code, "verifier": verifier, "device_id": device_id})
    assert r.status_code == 200, r.text
    return r.json()


async def _listed(c) -> dict[str, dict]:
    r = await c.get(LIST, headers=_person(OWNER, ORG))
    assert r.status_code == 200, r.text
    return {s["setup_id"]: s for s in r.json()["setups"]}


async def test_a_line_the_same_machines_new_setup_replaced_is_left_out_of_the_list(world, secret):
    async with _client() as c:
        old = await _device(c, "d4660h old mac", SAME_MACHINE)
        new = await _device(c, "d4660h new mac", SAME_MACHINE)

        listed = await _listed(c)
        assert old["setup_id"] not in listed
        assert new["setup_id"] in listed and listed[new["setup_id"]]["state"] != "disconnected"
        # the row is kept: closed with the reason, so the server still knows the line was replaced
        rows = await _sql(fetch=f"SELECT revoked_reason FROM desktop_setups WHERE id = '{old['setup_id']}'")
        assert rows[0][0] == "replaced_by_new_setup"


async def test_a_line_a_person_disconnected_stays_in_the_list(world, secret):
    async with _client() as c:
        mine = await _device(c, "d4660h person mac", OTHER_MACHINE)
        r = await c.delete(f"/api/v2/desktop/setups/{mine['setup_id']}", headers=_person(OWNER, ORG))
        assert r.status_code == 200, r.text

        listed = await _listed(c)
        assert listed[mine["setup_id"]]["state"] == "disconnected"
        assert listed[mine["setup_id"]]["revoked_reason"] is None
