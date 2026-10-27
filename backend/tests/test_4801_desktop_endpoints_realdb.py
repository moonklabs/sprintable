"""story #4801 (E-INFRA-DIET ⑦-앱) — `GET /api/v2/desktop/endpoints`: the two addresses a device's agents should use NOW.

The app keeps each agent's addresses from the day of its setup; when the server's address moves they go stale. The app asks this with the agent's own
key (while the old address still answers) and writes what it hears beside the same key. So the answer must (a) follow the deployment's current
`FASTAPI_URL` / `MCP_PUBLIC_URL` — not a copy taken at setup, (b) say nothing when the deployment set none (never a localhost fallback: a stale
agent would quietly run against it — Qadir 4825), and (c) be given only to a live device's key: a person's session · a key that is not a device's ·
a revoked key or setup → 404 `setup_not_found` with nothing of the addresses in it.
Real PG · real HTTP. Each test goes red without the line it names (mutants in the PR body).
"""
from __future__ import annotations

import pytest

from tests.test_4424_desktop_setup_realdb import (  # noqa: F401 — fixtures (autouse ones apply here too)
    OWNER,
    _addresses,
    _client,
    _dispose_global_engine_after_test,
    _person,
    _sql,
    anyio_backend,
    world,
)
from tests.test_4529_desktop_relay_realdb import _device

pytestmark = pytest.mark.anyio

URL = "/api/v2/desktop/endpoints"


def _key(device) -> dict:
    return {"Authorization": f"Bearer {device['agents'][0]['api_key']}"}


async def test_01_the_device_hears_the_deployments_current_addresses_not_the_ones_of_its_setup(world, monkeypatch):
    async with _client() as c:
        device = await _device(c, name="d4801 mac 1")
        first = await c.get(URL, headers=_key(device))
        assert first.status_code == 200, first.text
        assert first.json() == {"api_url": "https://api.d4424.test", "mcp_url": "https://mcp.d4424.test/mcp"}
        # the server moves: the same key, the same setup — the answer follows the deployment
        monkeypatch.setenv("FASTAPI_URL", "https://dev-api.moved.test/")
        monkeypatch.setenv("MCP_PUBLIC_URL", "https://mcp.moved.test/mcp")
        moved = await c.get(URL, headers=_key(device))
        assert moved.json() == {"api_url": "https://dev-api.moved.test", "mcp_url": "https://mcp.moved.test/mcp"}  # trailing slash cut, as at setup


async def test_02_an_address_the_deployment_did_not_set_is_null_never_a_local_fallback(world, monkeypatch):
    async with _client() as c:
        device = await _device(c, name="d4801 mac 2")
        monkeypatch.delenv("FASTAPI_URL")
        only_mcp = await c.get(URL, headers=_key(device))
        assert only_mcp.status_code == 200 and only_mcp.json() == {"api_url": None, "mcp_url": "https://mcp.d4424.test/mcp"}
        assert "localhost" not in only_mcp.text and "127.0.0.1" not in only_mcp.text
        monkeypatch.delenv("MCP_PUBLIC_URL")
        neither = await c.get(URL, headers=_key(device))
        assert neither.json() == {"api_url": None, "mcp_url": None}


async def test_03_only_a_live_devices_key_is_told(world):
    async with _client() as c:
        device = await _device(c, name="d4801 mac 3")
        # a person's session: not a device's key
        person = await c.get(URL, headers=_person(OWNER))
        assert (person.status_code, person.json()["error"]["code"]) == (404, "setup_not_found")
        assert "api.d4424.test" not in person.text and "mcp.d4424.test" not in person.text
        # no credentials at all
        assert (await c.get(URL)).status_code in (401, 403)
        # the key revoked → nothing told
        await _sql(f"UPDATE agent_api_keys SET revoked_at = now() WHERE desktop_setup_id = '{device['setup_id']}'")
        revoked = await c.get(URL, headers=_key(device))
        assert revoked.status_code in (401, 404) and "api.d4424.test" not in revoked.text


async def test_04_a_revoked_setup_is_not_told_either(world):
    async with _client() as c:
        device = await _device(c, name="d4801 mac 4")
        assert (await c.get(URL, headers=_key(device))).status_code == 200
        await _sql(f"UPDATE desktop_setups SET revoked_at = now() WHERE id = '{device['setup_id']}'")
        gone = await c.get(URL, headers=_key(device))
        assert gone.status_code in (401, 404) and "api.d4424.test" not in gone.text
