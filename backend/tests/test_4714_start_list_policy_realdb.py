"""story #4714 (AC3 덧 · PO 10-20 / 10-26) — the phone's start list offers only an agent whose conversation the person can OPEN.

Before: `GET /desktop/startable` filtered by project access only, so an admin who did not make the agent saw it, pressed [Start], the Mac started the
session, and `POST /api/v2/conversations` answered 403 AGENT_MESSAGE_POLICY_DENIED («Agent's creator must be a participant») — «Couldn't open the
conversation». Now the list and the conversation endpoint decide with ONE function (`agent_message_policy.policy_denial`):
- the same state gives the same answer in both (creator_only · list with/without the person · org_wide),
- when that policy is why a computer's list is empty the computer entry says `agents_hidden: "message_policy"` (the phone then says so, not «start the first agent at the Mac»),
- a stale phone that still presses [Start] is refused (`agent_message_policy_denied`) and no command is made.
Real PG · real HTTP. Each test goes red without the line it names (mutants in the PR body).
"""
from __future__ import annotations

import uuid

import pytest

from tests.test_4424_desktop_setup_realdb import (  # noqa: F401 — fixtures (autouse ones apply here too)
    ORG,
    OWNER,
    OWNER_TM,
    PLAIN,
    PROJ,
    _addresses,
    _client,
    _dispose_global_engine_after_test,
    _person,
    _sql,
    anyio_backend,
    world,
)
from tests.test_4529_desktop_relay_realdb import _tok
from tests.test_4533_agent_permissions_realdb import _plain_member
from tests.test_4533_agent_permissions_realdb import _pair, _register  # noqa: F401
from tests.test_4714_start_realdb import PROJ3, _list, _more_projects, _post, _setup, _start, _startable  # noqa: F401
from tests.test_4534_desktop_commands_realdb import _commands, _remote_control_on  # noqa: F401 — the autouse fixture that switches remote control on

pytestmark = pytest.mark.anyio


async def _computers(c, phone) -> list[dict]:
    r = await c.get(f"/api/v2/desktop/startable?phone_key_id={phone}", headers=_person(OWNER))
    assert r.status_code == 200, r.text
    return r.json()["computers"]


async def _dm_status(c, agent, who=OWNER) -> int:
    """Can the owner open a DM with the agent? (the very endpoint the room is opened with after a start) → 201 when it can (an existing room is 200), 403 when not"""
    r = await c.post("/api/v2/conversations", json={"type": "dm", "participant_ids": [agent], "project_id": str(PROJ)}, headers=_person(who))
    assert r.status_code in (200, 201, 403), r.text
    return 201 if r.status_code in (200, 201) else 403


async def _ids(c, phone) -> list[str]:
    return [a["agent_member_id"] for a in (await _computers(c, phone))[0]["agents"]]


async def _make_not_the_creator(*agents) -> None:
    """The agents' creator is another person (the owner who made them is no longer `created_by`)."""
    rows = await _sql(fetch=f"SELECT id FROM members WHERE org_id = '{ORG}' AND user_id = '{PLAIN}'")
    other = rows[0][0] if rows else await _plain_member()
    for agent in agents:
        await _sql(f"UPDATE members SET owner_member_id = '{other}' WHERE id = '{agent}'")


async def _mode(agent, mode: str) -> None:
    await _sql(f"UPDATE members SET message_policy_mode = '{mode}' WHERE id = '{agent}'")


async def test_01_the_list_and_the_conversation_endpoint_agree_in_every_policy_state(world):
    async with _client() as c:
        device, agent, phone, _der = await _setup(c, "d4714 policy mac 1")
        await c.put("/api/v2/desktop/relay/startable", json=_startable((agent, PROJ)), headers=_tok(device["device_token"]))
        # the person made the agent (creator_only, the default): offered, and the room can be opened
        assert agent in await _ids(c, phone)
        assert await _dm_status(c, agent) == 201

        # someone else made it: an admin who did not make it is NOT offered it, and the room cannot be opened (the same 403 as before this story)
        await _make_not_the_creator(agent)
        assert agent not in await _ids(c, phone)
        assert await _dm_status(c, agent) == 403

        # a list-mode agent with the person on its allowlist: offered; off it: not (the creator's own allowlist row, made with the agent, is not this person's)
        await _sql(f"DELETE FROM agent_message_allowlist WHERE agent_member_id = '{agent}'")
        await _mode(agent, "list")
        assert agent not in await _ids(c, phone) and await _dm_status(c, agent) == 403
        await _sql(f"INSERT INTO agent_message_allowlist (id,agent_member_id,allowed_id,org_id) VALUES (gen_random_uuid(),'{agent}','{OWNER_TM}','{ORG}')")
        assert agent in await _ids(c, phone) and await _dm_status(c, agent) == 201

        # org_wide: every person of the organization
        await _sql(f"DELETE FROM agent_message_allowlist WHERE agent_member_id = '{agent}'")
        await _mode(agent, "org_wide")
        assert agent in await _ids(c, phone) and await _dm_status(c, agent) == 201


async def test_02_the_reason_is_said_only_when_the_policy_is_why_nothing_is_left(world):
    async with _client() as c:
        device, agent, phone, _der = await _setup(c, "d4714 policy mac 2")
        await c.put("/api/v2/desktop/relay/startable", json=_startable((agent, PROJ)), headers=_tok(device["device_token"]))
        everyone = await _ids(c, phone)
        assert agent in everyone
        # some agents left (the person may open them): nothing is said of the ones that were left out
        await _make_not_the_creator(agent)
        comp = (await _computers(c, phone))[0]
        assert agent not in [a["agent_member_id"] for a in comp["agents"]]
        if comp["agents"]:
            assert "agents_hidden" not in comp
        # none left, and the policy is why: the computer entry says so
        await _make_not_the_creator(*everyone)
        comp = (await _computers(c, phone))[0]
        assert comp["agents"] == [] and comp["agents_hidden"] == "message_policy"
        # a computer with no agent at all says nothing of the kind (the phone's «start the first agent at the Mac» stays true there)
        await _sql(f"UPDATE desktop_setups SET members = '[]'::jsonb WHERE id = '{device['setup_id']}'")
        comp = (await _computers(c, phone))[0]
        assert comp["agents"] == [] and "agents_hidden" not in comp


async def test_03_the_per_agent_list_does_not_offer_it_either_and_a_stale_press_is_refused_with_nothing_made(world):
    async with _client() as c:
        device, agent, phone, _der = await _setup(c, "d4714 policy mac 3")
        await c.put("/api/v2/desktop/relay/startable", json=_startable((agent, PROJ)), headers=_tok(device["device_token"]))
        before = await _sql(fetch=f"SELECT count(*) FROM desktop_commands WHERE setup_id = '{device['setup_id']}'")
        assert (await _list(c, agent, phone)).status_code == 200
        await _make_not_the_creator(agent)
        assert (await _list(c, agent, phone)).status_code == 404  # «no such agent» — nothing to start
        r = await _post(c, agent, _start(phone, device["setup_id"]))
        assert (r.status_code, r.json()["error"]["code"]) == (403, "agent_message_policy_denied"), r.text
        # the project check comes first: a project of another agent (or one the person cannot open) is the masked 404 whatever the policy says (codex review)
        masked = await _post(c, agent, _start(phone, device["setup_id"], project=PROJ3))
        assert (masked.status_code, masked.json()["error"]["code"]) == (404, "project_not_found"), masked.text
        assert await _sql(fetch=f"SELECT count(*) FROM desktop_commands WHERE setup_id = '{device['setup_id']}'") == before  # no command, so no session on the Mac
        # and again allowed once the policy lets the person in
        await _mode(agent, "org_wide")
        ok = await _post(c, agent, _start(phone, device["setup_id"]))
        assert ok.status_code in (200, 201, 202), ok.text


async def test_04_an_org_admin_is_judged_by_their_member_id_in_the_list_and_in_the_conversation_endpoint(world):
    """An org admin who did not make the agent (the fixture's PLAIN person: members.id = org_members.id, as 0075) is judged by that id in the list-mode
    allowlist, the same in the phone's list and in POST /conversations (codex review, round 1 #3). A person with an org_members row and NO members row cannot
    reach these paths at all: a phone cannot be registered for them (remote_devices.member_id → members)."""
    org_member_id = await _plain_member()
    await _sql(f"UPDATE org_members SET role = 'admin' WHERE org_id = '{ORG}' AND user_id = '{PLAIN}'")
    async with _client() as c:
        device, agent, owner_phone, owner_der = await _setup(c, "d4714 policy mac 4")
        await c.put("/api/v2/desktop/relay/startable", json=_startable((agent, PROJ)), headers=_tok(device["device_token"]))
        plain_phone, plain_der = await _register(c, PLAIN)
        await _pair(c, device["device_token"], owner_der, plain_der)
        await _sql(f"DELETE FROM agent_message_allowlist WHERE agent_member_id = '{agent}'")
        await _mode(agent, "list")

        async def plain_ids() -> list[str]:
            r = await c.get(f"/api/v2/desktop/startable?phone_key_id={plain_phone}", headers=_person(PLAIN))
            assert r.status_code == 200, r.text
            return [a["agent_member_id"] for comp in r.json()["computers"] for a in comp["agents"]]

        # not on the allowlist: not offered, and the conversation cannot be opened
        assert agent not in await plain_ids() and await _dm_status(c, agent, PLAIN) == 403
        # on it by their member id: offered, and the conversation opens
        await _sql(f"INSERT INTO agent_message_allowlist (id,agent_member_id,allowed_id,org_id) VALUES (gen_random_uuid(),'{agent}','{org_member_id}','{ORG}')")
        assert agent in await plain_ids() and await _dm_status(c, agent, PLAIN) == 201
