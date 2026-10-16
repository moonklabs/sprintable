"""story #4585 (E-2선 · 4535 gate · PO 01:35Z) — «원격 제어» is changed only by an *active* owner: the same rule as 4598's
«묻지 않고 일하기» (`agent_run_profile.is_active_owner`, fail closed). An owner whose member row is inactive gets the same 403
(`owner_required`) as an admin or a member, and reads `can_change: false`; made active again, the same person changes it.
(Members · admins: 4535's tests, unchanged · an owner with no members row: 4583's test.)
"""
from __future__ import annotations

import pytest

from tests.test_4424_desktop_setup_realdb import (  # noqa: F401 — fixtures (autouse ones apply here too)
    ORG,
    OWNER,
    OWNER_TM,
    _addresses,
    _client,
    _dispose_global_engine_after_test,
    _person,
    _sql,
    anyio_backend,
    world,
)

pytestmark = pytest.mark.anyio

URL = f"/api/v2/organizations/{ORG}/remote-control"


async def _active(on: bool):
    await _sql(f"UPDATE members SET is_active = {'true' if on else 'false'} WHERE id = '{OWNER_TM}'")


async def test_an_inactive_owner_cannot_change_it_and_the_same_owner_active_again_can(world):
    async with _client() as c:
        # positive control: the active owner changes it and reads that they may
        assert (await c.get(URL, headers=_person(OWNER))).json()["can_change"] is True
        on = await c.put(URL, json={"enabled": True}, headers=_person(OWNER))
        assert on.status_code == 200 and on.json()["enabled"] is True, on.text

        await _active(False)
        refused = await c.put(URL, json={"enabled": False}, headers=_person(OWNER))
        assert refused.status_code == 403 and refused.json()["error"]["code"] == "owner_required", refused.text
        view = (await c.get(URL, headers=_person(OWNER))).json()
        assert (view["can_change"], view["enabled"]) == (False, True), view  # refused: nothing changed
        assert (await _sql(fetch=f"SELECT remote_control_enabled_at IS NOT NULL FROM organizations WHERE id = '{ORG}'"))[0][0] is True

        await _active(True)
        off = await c.put(URL, json={"enabled": False}, headers=_person(OWNER))
        assert off.status_code == 200 and off.json()["enabled"] is False, off.text
