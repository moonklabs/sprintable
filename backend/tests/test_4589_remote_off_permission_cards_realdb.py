"""story #4589 (E-2선 · 4583 곁 · PO 00:37Z) — a permission request that was waiting when the org turned «원격 제어» off.

Read, never withdrawn: while off its row is listed with `answerable: false` · `remote_control_off: true` and no signing values, and it
is off the approvals badge; turned on again, the same row is answerable again. The answer route still refuses it (409
remote_control_off) — a second guard, with no command made.
"""
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
from tests.test_4529_desktop_relay_realdb import _device
from tests.test_4533_agent_permissions_realdb import (  # noqa: F401 — the autouse remote-control-on fixture applies here too
    REQS,
    _answer,
    _ask,
    _pair,
    _post_ask,
    _register,
    _remote_control_on,
    _with_session,
)

pytestmark = pytest.mark.anyio

BADGE = "/api/v2/gates/designated-pending-count"


async def _switch(on: bool):
    await _sql(f"UPDATE organizations SET remote_control_enabled_at = {'now()' if on else 'NULL'} WHERE id = '{ORG}'")


async def test_a_waiting_request_while_off_is_listed_unanswerable_and_off_the_badge_then_back_when_on(world):
    async with _client() as c:
        device = await _device(c, name="d4424 mac 4589a")
        agent = await _with_session(c, device)
        phone_id, der = await _register(c)
        await _pair(c, device["device_token"], der)
        assert (await _post_ask(c, device, _ask(agent))).status_code == 201

        [on] = (await c.get(REQS, headers=_person(OWNER))).json()["requests"]  # positive control: answerable while on
        assert (on["answerable"], on["remote_control_off"], on["device_reachable"]) == (True, False, True)
        assert (await c.get(BADGE, headers=_person(OWNER))).json()["count"] == 1

        await _switch(False)  # the owner turns it off (the device's last word is still fresh: «reachable»)
        [off] = (await c.get(REQS, headers=_person(OWNER))).json()["requests"]
        assert (off["state"], off["answerable"], off["remote_control_off"], off["device_reachable"]) == ("pending", False, True, True)
        assert (off["session_key"], off["input_hash"]) == (None, None)  # not answerable → no signing values
        badge = await c.get(BADGE, headers=_person(OWNER))
        assert badge.status_code == 200 and badge.json()["count"] == 0, badge.text
        refused = await c.post(f"{REQS}/{off['id']}/answer", json=_answer(phone_id), headers=_person(OWNER))
        assert refused.status_code == 409 and refused.json()["error"]["code"] == "remote_control_off", refused.text
        assert (await _sql(fetch=f"SELECT count(*) FROM desktop_commands WHERE setup_id = '{device['setup_id']}'"))[0][0] == 0
        assert (await _sql(fetch=f"SELECT state FROM agent_permission_requests WHERE id = '{off['id']}'"))[0][0] == "pending"

        await _switch(True)  # on again: the same row, answerable again — it was never withdrawn
        [back] = (await c.get(REQS, headers=_person(OWNER))).json()["requests"]
        assert (back["id"], back["answerable"], back["remote_control_off"]) == (off["id"], True, False)
        assert back["input_hash"] is not None
        assert (await c.get(BADGE, headers=_person(OWNER))).json()["count"] == 1


async def test_off_and_terminal_only_together_on_one_device(world):
    """Kadir 2선 (4996 codex 01a11ace · PO 09:29Z ①): the place 4996's rebase merged by hand — `answerable` needs both «not terminal
    only» and «not off», and the badge counts neither — pinned in one run: an ordinary and a terminal-only question on the same
    paired, reachable device, through on → off → on. The answer route refuses terminal-only first (it is never answerable here,
    on or off), then off."""
    def _terminal_ask(agent):
        body = _ask(agent, terminal_only=True)
        del body["input_hash"]
        return body

    async def _rows():
        listed = (await c.get(REQS, headers=_person(OWNER))).json()["requests"]
        return {r["terminal_only"]: r for r in listed}

    async def _badge():
        return (await c.get(BADGE, headers=_person(OWNER))).json()["count"]

    async with _client() as c:
        device = await _device(c, name="d4424 mac 4589b")
        agent = await _with_session(c, device)
        phone_id, der = await _register(c)
        await _pair(c, device["device_token"], der)
        assert (await _post_ask(c, device, _ask(agent))).status_code == 201
        assert (await _post_ask(c, device, _terminal_ask(agent))).status_code == 201

        rows = await _rows()  # on: the ordinary one answerable, the terminal-only one not
        assert (rows[False]["answerable"], rows[False]["remote_control_off"]) == (True, False)
        assert (rows[True]["answerable"], rows[True]["remote_control_off"], rows[True]["input_hash"]) == (False, False, None)
        assert await _badge() == 1

        await _switch(False)  # off: neither answerable · both say off · no signing values · nothing on the badge
        rows = await _rows()
        for r in rows.values():
            assert (r["state"], r["answerable"], r["remote_control_off"], r["session_key"], r["input_hash"]) == ("pending", False, True, None, None)
        assert await _badge() == 0
        refused = await c.post(f"{REQS}/{rows[True]['id']}/answer", json=_answer(phone_id), headers=_person(OWNER))
        assert refused.status_code == 409 and refused.json()["error"]["code"] == "terminal_only", refused.text
        refused = await c.post(f"{REQS}/{rows[False]['id']}/answer", json=_answer(phone_id), headers=_person(OWNER))
        assert refused.status_code == 409 and refused.json()["error"]["code"] == "remote_control_off", refused.text
        assert (await _sql(fetch=f"SELECT count(*) FROM desktop_commands WHERE setup_id = '{device['setup_id']}'"))[0][0] == 0

        await _switch(True)  # on again: the ordinary one answerable again, the terminal-only one still not
        rows = await _rows()
        assert (rows[False]["answerable"], rows[True]["answerable"]) == (True, False)
        assert await _badge() == 1
