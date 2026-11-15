"""story #4951 (①c-0) — the agent's session view tells the web whether THIS person may look at the changed-file list: `can_read_changes`.
True only for the person who paired the computer, while remote control is on, the computer is heard and the session has not ended; false for everyone else (an org admin who did not pair
it · a plain member who can open the agent), for an ended session, for remote control off, for a computer not heard from, and before any session exists. The same rule as the ask itself
(`desktop_changes.may_read`) — the button is a convenience; the server judges the ask again. Each test goes red without the line it names (mutants in the PR body)."""
from __future__ import annotations

import pytest

from tests.test_4424_desktop_setup_realdb import (  # noqa: F401 — fixtures (autouse ones apply here too)
    ORG,
    OWNER,
    PLAIN,
    _addresses,
    _client,
    _dispose_global_engine_after_test,
    _person,
    _sql,
    anyio_backend,
    world,
)
from tests.test_4529_desktop_relay_realdb import _device
from tests.test_4533_agent_permissions_realdb import _plain_member
from tests.test_4534_desktop_commands_realdb import _grant, _remote_control_on, _state  # noqa: F401

pytestmark = pytest.mark.anyio


def _view(c, agent, who=OWNER):
    return c.get(f"/api/v2/agents/{agent}/desktop-session", headers=_person(who))


async def test_01_only_the_pairing_person_may_read_while_the_line_is_up_and_the_session_lives(world):
    plain_tm = await _plain_member()
    await _grant(plain_tm)
    async with _client() as c:
        device = await _device(c, name="d4424 mac 4951c0a")
        agent = device["agents"][0]["member_id"]
        before = (await _view(c, agent)).json()
        assert before["can_read_changes"] is False  # no session reported yet
        await _state(c, device, agent, "idle", 1)
        assert (await _view(c, agent)).json()["can_read_changes"] is True  # the person who paired the computer
        assert (await _view(c, agent, PLAIN)).json()["can_read_changes"] is False  # a member who can open the agent, did not pair it
        await _sql(f"UPDATE org_members SET role = 'admin' WHERE org_id = '{ORG}' AND user_id = '{PLAIN}'")
        assert (await _view(c, agent, PLAIN)).json()["can_read_changes"] is False  # …nor an org admin


async def test_02_no_button_without_a_live_session_a_heard_computer_or_remote_control(world):
    async with _client() as c:
        device = await _device(c, name="d4424 mac 4951c0b")
        agent = device["agents"][0]["member_id"]
        sid = device["setup_id"]
        await _state(c, device, agent, "idle", 1)
        assert (await _view(c, agent)).json()["can_read_changes"] is True
        await _state(c, device, agent, "stopped", 2)  # the session ended: its folder is not read any more
        assert (await _view(c, agent)).json()["can_read_changes"] is False
        await _state(c, device, agent, "idle", 3)
        assert (await _view(c, agent)).json()["can_read_changes"] is True
        await _sql(f"UPDATE desktop_device_tokens SET last_used_at = now() - interval '1 hour' WHERE setup_id = '{sid}'")  # the computer is not heard from
        assert (await _view(c, agent)).json()["can_read_changes"] is False
        await _sql(f"UPDATE desktop_device_tokens SET last_used_at = now() WHERE setup_id = '{sid}'")
        assert (await _view(c, agent)).json()["can_read_changes"] is True
        await _sql(f"UPDATE organizations SET remote_control_enabled_at = NULL WHERE id = '{ORG}'")
        assert (await _view(c, agent)).json()["can_read_changes"] is False
        await _sql(f"UPDATE organizations SET remote_control_enabled_at = now() WHERE id = '{ORG}'")
        await _sql(f"UPDATE desktop_setups SET confirmed_by = '{PLAIN}' WHERE id = '{sid}'")  # re-paired to someone else
        assert (await _view(c, agent)).json()["can_read_changes"] is False
