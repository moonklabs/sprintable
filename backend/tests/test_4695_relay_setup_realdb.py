"""story 4695 — `GET /api/v2/desktop/relay/setup`: the organization a device's setup belongs to, for the Mac app's pairing list (a setup made before the
app kept the organization's name asks for it with its own device token). Only a device token is a device here; the answer names its own org, no other."""
from __future__ import annotations

import pytest

from tests.test_4424_desktop_setup_realdb import (  # noqa: F401 — fixtures (autouse ones apply here too)
    ORG,
    OWNER,
    _addresses,
    _client,
    _dispose_global_engine_after_test,
    _person,
    _sql,
    anyio_backend,
    world,
)
from tests.test_4529_desktop_relay_realdb import _device, _tok
from tests.test_4533_agent_permissions_realdb import _remote_control_on  # noqa: F401

pytestmark = pytest.mark.anyio

SETUP = "/api/v2/desktop/relay/setup"


async def test_01_a_device_token_gets_its_own_orgs_id_and_name(world):
    async with _client() as c:
        device = await _device(c, name="d4424 mac 4695r")
        name = (await _sql(fetch=f"SELECT name FROM organizations WHERE id = '{ORG}'"))[0][0]
        r = await c.get(SETUP, headers=_tok(device["device_token"]))
        body = r.json()
        assert r.status_code == 200 and (body["org_id"], body["org_name"]) == (str(ORG), name), r.text
        # story 4734: the computer this setup belongs to, and the phones a person removed from a setup of it (none here)
        assert set(body) == {"org_id", "org_name", "computer_id", "removed_phones", "removed_phones_now"} and body["computer_id"] and body["removed_phones"] == [] and body["removed_phones_now"] == [], r.text


async def test_02_nobody_else_is_a_device_here(world):
    async with _client() as c:
        device = await _device(c, name="d4424 mac 4695s")
        assert (await c.get(SETUP)).status_code in (401, 422)
        assert (await c.get(SETUP, headers=_tok("sdt_" + "z" * 43))).status_code == 401
        assert (await c.get(SETUP, headers=_person(OWNER))).status_code in (401, 422)  # a person's login is no device token
        assert (await c.get(SETUP, headers={"Authorization": f"Bearer {device['agents'][0]['api_key']}"})).status_code in (401, 422)


async def test_03_remote_control_off_is_the_same_409_as_every_device_route(world):
    async with _client() as c:
        device = await _device(c, name="d4424 mac 4695t")
        await _sql(f"UPDATE organizations SET remote_control_enabled_at = NULL WHERE id = '{ORG}'")
        r = await c.get(SETUP, headers=_tok(device["device_token"]))
        assert r.status_code == 409, r.text
