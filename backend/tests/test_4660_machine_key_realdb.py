"""story 4660 (design 4660 · PO 결정 · 까디르 렌즈) — a new setup on the same machine closes the old «연결된 기기» lines.

Real database. The app sends `device_id` (its salted hash of the machine id) with the exchange; the server keeps an org-scoped
HMAC of it and, for the same org and key, closes the older lines with the reason replaced_by_new_setup and revokes their device
tokens (the old token is then refused by the relay). The agents and their keys stay.

PO 10-15: a line is replaced only when the new setup is the SAME AGENTS set up again — every agent the old line carried is
among the new setup's (or the old line has no agent left). One computer holds one setup per lane, so another lane's setup on
the same computer stays open. These tests set agents up as a move (existing agents), the way a reinstall does.
"""
from __future__ import annotations

import logging
import uuid

import pytest

from app.core.config import settings
from app.services.desktop_setup import machine_key_for
from tests.test_4424_desktop_setup_realdb import (  # noqa: F401 — fixtures (autouse ones apply here too)
    EXISTING,
    ORG,
    ORG2,
    OUTSIDER,
    OWNER,
    RECIPE,
    _client,
    _code,
    _confirm,
    _dispose_global_engine_after_test,
    _person,
    _pkce,
    _sql,
    anyio_backend,
    world,
)
from tests.test_4565_attach_existing_agent_realdb import attachable  # noqa: F401 — fixture (movable builds on it)
from tests.test_4576_move_setup_realdb import EXISTING_B, _move, _move_code, movable  # noqa: F401

pytestmark = pytest.mark.anyio

SECRET = "test-desktop-machine-key-secret-value-4660"
SAME_MACHINE = "b" * 64
OTHER_MACHINE = "c" * 64


@pytest.fixture(autouse=True)
def _addresses(monkeypatch):
    """The exchange hands over the API and MCP addresses; a deployment sets them, a test sets its own (as in 4424)."""
    monkeypatch.setenv("MCP_PUBLIC_URL", "https://mcp.d4660.test/mcp")
    monkeypatch.setenv("FASTAPI_URL", "https://api.d4660.test")


@pytest.fixture(autouse=True)
async def _remote_control_on(world):
    """story #4535 — the relay refuses an org whose «원격 제어» is off; these tests are about an org that turned it on."""
    await _sql(f"UPDATE organizations SET remote_control_enabled_at = now() WHERE id = '{ORG}'")
    yield


@pytest.fixture(autouse=True)
async def _agents(movable):
    """Two existing agents (EXISTING · EXISTING_B) in the project, ready to be moved to a computer."""
    yield


@pytest.fixture
def secret(monkeypatch):
    monkeypatch.setattr(settings, "channel_oauth_state_secret", SECRET)
    return SECRET


async def _device(c, name: str, device_id: str | None, *agents: uuid.UUID) -> dict:
    """A device set up on this org as a move of existing agents (EXISTING by default): code, confirm, exchange — with the
    device_id when given. The agents' own keys rotate at the exchange (one agent, one place)."""

    code, verifier, _setup_id = await _move_code(c, name)
    assert (await _confirm(c, code, body=_move(*(agents or (EXISTING,))))).status_code == 200
    body = {"code": code, "verifier": verifier, **({"device_id": device_id} if device_id else {})}
    r = await c.post("/api/v2/desktop/setup-codes/exchange", json=body)
    assert r.status_code == 200, r.text
    return r.json()


def _tok(token: str) -> dict:
    return {"x-desktop-device-token": token}


async def _line(setup_id: str) -> tuple:
    rows = await _sql(fetch=f"SELECT revoked_at IS NOT NULL, revoked_reason, machine_key FROM desktop_setups WHERE id = '{setup_id}'")
    return tuple(rows[0])


async def test_the_same_agent_set_up_again_on_the_same_machine_closes_the_old_line_and_its_old_token_is_refused(world, secret):
    async with _client() as c:
        first = await _device(c, "d4660 mac first", SAME_MACHINE)
        # the old line is heard from once, so it has a «last heard» time to show
        assert (await c.put("/api/v2/desktop/relay/sessions", json={"report_seq": 1, "sessions": []}, headers=_tok(first["device_token"]))).status_code == 200

        second = await _device(c, "d4660 mac second", SAME_MACHINE)  # the same agent again (a reinstall)

        closed, reason, first_key = await _line(first["setup_id"])
        assert closed is True and reason == "replaced_by_new_setup"
        assert first_key == machine_key_for(ORG, SAME_MACHINE)
        open_now, _, second_key = await _line(second["setup_id"])
        assert open_now is False and second_key == first_key

        old = await c.put("/api/v2/desktop/relay/sessions", json={"report_seq": 2, "sessions": []}, headers=_tok(first["device_token"]))
        assert old.status_code == 401, old.text
        assert old.json()["error"]["code"] == "DEVICE_TOKEN_INVALID"  # the error envelope: the dict detail passes through as error
        new = await c.put("/api/v2/desktop/relay/sessions", json={"report_seq": 1, "sessions": []}, headers=_tok(second["device_token"]))
        assert new.status_code == 200, new.text

        # one agent, one place: the agent's only live key is the new setup's (the move rotated it, not the replacement)
        keys = await _sql(fetch=f"SELECT desktop_setup_id::text FROM agent_api_keys WHERE team_member_id = '{EXISTING}' AND revoked_at IS NULL")
        assert [k[0] for k in keys] == [second["setup_id"]]


async def test_another_lanes_setup_on_the_same_machine_stays_open(world, secret):
    # PO 10-15: one computer holds one setup per lane — a setup of OTHER agents closes nothing (and a mutant that closes every
    # same-machine line goes red here)
    async with _client() as c:
        lane_a = await _device(c, "d4660 lane A", SAME_MACHINE, EXISTING)
        assert (await c.put(RELAY, json={"report_seq": 1, "sessions": []}, headers=_tok(lane_a["device_token"]))).status_code == 200
        lane_b = await _device(c, "d4660 lane B", SAME_MACHINE, EXISTING_B)

        a_closed, a_reason, a_key = await _line(lane_a["setup_id"])
        assert a_closed is False and a_reason is None
        b_closed, b_reason, b_key = await _line(lane_b["setup_id"])
        assert b_closed is False and b_reason is None
        assert a_key == b_key == machine_key_for(ORG, SAME_MACHINE)  # the same computer, two live lines
        for tok in (lane_a["device_token"], lane_b["device_token"]):  # both device tokens still pass the relay
            assert (await c.put(RELAY, json={"report_seq": 2, "sessions": []}, headers=_tok(tok))).status_code == 200


async def test_a_new_setup_closes_an_old_line_only_when_it_has_all_that_lines_agents(world, secret):
    # a line of two agents: a setup of one of them takes that one out of it but does not replace it; a setup that has
    # what is left of it does — judged on what the line carried before each exchange
    async with _client() as c:
        both = await _device(c, "d4660 lane both", SAME_MACHINE, EXISTING, EXISTING_B)
        only_a = await _device(c, "d4660 lane A again", SAME_MACHINE, EXISTING)
        assert (await _line(both["setup_id"]))[:2] == (False, None), "it still carries EXISTING_B — not replaced by a setup of EXISTING"
        assert (await _line(only_a["setup_id"]))[:2] == (False, None)

        only_b = await _device(c, "d4660 lane B again", SAME_MACHINE, EXISTING_B)
        assert (await _line(both["setup_id"]))[:2] == (True, "replaced_by_new_setup"), "EXISTING_B was all that was left of it"
        assert (await _line(only_a["setup_id"]))[:2] == (False, None), "carries EXISTING, which the setup of EXISTING_B lacks"
        assert (await _line(only_b["setup_id"]))[:2] == (False, None)


async def test_a_line_whose_agents_all_moved_away_is_closed_by_the_next_setup_on_its_machine(world, secret):
    # PO 10-15 ③: the line the agents left (members 0 — the one 9fb4dd3a of the legion's list) is closed by the next setup on
    # its machine, whatever agents that setup carries; the other machine's line is not touched
    async with _client() as c:
        emptied = await _device(c, "d4660 emptied", SAME_MACHINE, EXISTING)
        elsewhere = await _device(c, "d4660 elsewhere", OTHER_MACHINE, EXISTING)  # takes EXISTING away from the first line
        assert (await _line(emptied["setup_id"]))[:2] == (False, None), "another machine: nothing closed yet"
        left = (await _sql(fetch=f"SELECT members::text FROM desktop_setups WHERE id = '{emptied['setup_id']}'"))[0][0]
        assert "member_id" not in left, "its agent moved out of it"

        later = await _device(c, "d4660 later", SAME_MACHINE, EXISTING_B)  # another agent, the same machine as the emptied line
        assert (await _line(emptied["setup_id"]))[:2] == (True, "replaced_by_new_setup")
        assert (await _line(elsewhere["setup_id"]))[:2] == (False, None)
        assert (await _line(later["setup_id"]))[:2] == (False, None)
        assert (await c.put(RELAY, json={"report_seq": 1, "sessions": []}, headers=_tok(emptied["device_token"]))).status_code == 401


async def test_a_different_machine_in_the_same_org_leaves_the_line_open(world, secret):
    async with _client() as c:
        first = await _device(c, "d4660 mac a", SAME_MACHINE)
        await _device(c, "d4660 mac b", OTHER_MACHINE)
        closed, reason, _ = await _line(first["setup_id"])
        assert closed is False and reason is None


async def test_no_secret_means_no_key_and_no_line_is_closed(world, monkeypatch):
    # PO ①·까디르 ③: the secret is empty → no key is made, nothing is closed, the new line is added as before
    monkeypatch.setattr(settings, "channel_oauth_state_secret", "")
    async with _client() as c:
        first = await _device(c, "d4660 no-secret a", SAME_MACHINE)
        second = await _device(c, "d4660 no-secret b", SAME_MACHINE)
        closed, reason, first_key = await _line(first["setup_id"])
        assert closed is False and reason is None and first_key is None
        _, _, second_key = await _line(second["setup_id"])
        assert second_key is None


async def test_an_app_that_sends_no_device_id_gets_the_old_behaviour(world, secret):
    # AC2 / PO: an older app sends no device_id → no key, no close — the same as before this story
    async with _client() as c:
        first = await _device(c, "d4660 old-app a", None)
        second = await _device(c, "d4660 old-app b", None)
        closed, reason, first_key = await _line(first["setup_id"])
        assert closed is False and reason is None and first_key is None
        _, _, second_key = await _line(second["setup_id"])
        assert second_key is None


async def test_the_list_leaves_out_the_replaced_line_and_the_row_keeps_its_reason(world, secret):
    # PO 2026-10-13: the same computer's replaced line is not shown (its own test is in test_4660_hide_replaced_realdb.py);
    # the row itself keeps the reason and the closed time
    async with _client() as c:
        first = await _device(c, "d4660 list first", SAME_MACHINE)
        assert (await c.put("/api/v2/desktop/relay/sessions", json={"report_seq": 1, "sessions": []}, headers=_tok(first["device_token"]))).status_code == 200
        second = await _device(c, "d4660 list second", SAME_MACHINE)

        r = await c.get("/api/v2/desktop/setups", headers=_person(OWNER, ORG))
        assert r.status_code == 200, r.text
        ids = [s["setup_id"] for s in r.json()["setups"]]
        assert first["setup_id"] not in ids and second["setup_id"] in ids
        row = (await _sql(fetch=f"SELECT revoked_reason, revoked_at IS NOT NULL FROM desktop_setups WHERE id = '{first['setup_id']}'"))[0]
        assert row[0] == "replaced_by_new_setup" and row[1] is True


# --- the gaps the design named (4660 design §7 · §9 ② ④): another org, the log, the setup request ---

ORG2_PROJECT = uuid.UUID("e4660000-0000-0000-0000-000000000031")
ORG2_RECIPE = uuid.UUID("e4660000-0000-0000-0000-000000000033")
EXCHANGE = "/api/v2/desktop/setup-codes/exchange"
RELAY = "/api/v2/desktop/relay/sessions"
# a value no other test in this file uses, so the log check cannot match anything else
EXCHANGE_DEVICE = "7a3c" * 16


@pytest.fixture
async def other_org(world):
    """The other org of the 4424 world (ORG2, its admin OUTSIDER) gets its own project, member and recipe to confirm into."""
    await _sql(
        f"INSERT INTO projects (id,org_id,name,slug,violation_level) VALUES ('{ORG2_PROJECT}','{ORG2}','P2','d4660-proj2','warn')",
        "INSERT INTO event_definitions (id,key,org_id,name,description,payload_schema,routing,block_template,stage_metadata,"
        "role_actor_kinds,enabled,version) SELECT "
        f"'{ORG2_RECIPE}','org.d4424-org2.desktop_recipe','{ORG2}',name,description,payload_schema,routing,block_template,"
        f"stage_metadata,role_actor_kinds,enabled,version FROM event_definitions WHERE id='{RECIPE}'",
    )
    yield


async def _other_org_device(c, name: str, device_id: str) -> dict:
    """A device set up on the other org, confirmed by its admin, exchanged with the device id."""
    code, verifier = await _code(c, name)
    body = {
        "project_id": str(ORG2_PROJECT), "recipe_id": str(ORG2_RECIPE),
        "roles": [{"role": "Writer", "runtime": "claude"}, {"role": "Reviewer", "runtime": "codex"}],
    }
    assert (await _confirm(c, code, who=OUTSIDER, org=ORG2, body=body)).status_code == 200
    r = await c.post(EXCHANGE, json={"code": code, "verifier": verifier, "device_id": device_id})
    assert r.status_code == 200, r.text
    return r.json()


async def test_the_same_machine_in_another_org_leaves_this_orgs_line_open(other_org, secret):
    # 4660 §7: the same device id under another org never matches this org's line (the key is org-scoped)
    async with _client() as c:
        mine = await _device(c, "d4660 org-a mac", SAME_MACHINE)
        assert (await c.put(RELAY, json={"report_seq": 1, "sessions": []}, headers=_tok(mine["device_token"]))).status_code == 200
        theirs = await _other_org_device(c, "d4660 org-b mac", SAME_MACHINE)

        closed, reason, mine_key = await _line(mine["setup_id"])
        assert closed is False and reason is None
        assert mine_key == machine_key_for(ORG, SAME_MACHINE)
        _, _, theirs_key = await _line(theirs["setup_id"])
        assert theirs_key == machine_key_for(ORG2, SAME_MACHINE) and theirs_key != mine_key
        # this org's device token still passes the relay
        still = await c.put(RELAY, json={"report_seq": 2, "sessions": []}, headers=_tok(mine["device_token"]))
        assert still.status_code == 200, still.text


async def test_the_device_id_is_in_no_log_and_no_record_of_the_exchange(world, secret, caplog):
    # 4660 §9 ④: the exchange body's device id never reaches the logs (a good and a refused exchange) or a recorded tool call
    caplog.set_level(logging.DEBUG)
    async with _client() as c:  # importing the app sets up logging, which clears the root handlers: put caplog back
        if caplog.handler not in logging.getLogger().handlers:
            logging.getLogger().addHandler(caplog.handler)
        code, verifier = await _code(c, "d4660 log mac")
        assert (await _confirm(c, code)).status_code == 200
        refused = await c.post(EXCHANGE, json={"code": code, "verifier": "w" * 43, "device_id": EXCHANGE_DEVICE})
        assert refused.status_code == 403, refused.text
        ok = await c.post(EXCHANGE, json={"code": code, "verifier": verifier, "device_id": EXCHANGE_DEVICE})
        assert ok.status_code == 200, ok.text
    assert EXCHANGE_DEVICE not in caplog.text
    hits = (await _sql(fetch=(
        f"SELECT count(*) FROM agent_run_tool_calls WHERE path LIKE '%{EXCHANGE_DEVICE}%' "
        f"OR input_summary::text LIKE '%{EXCHANGE_DEVICE}%'"
    )))[0][0]
    assert hits == 0


async def test_a_device_id_on_the_setup_request_is_ignored(world, secret):
    # 4660 §7: only the exchange carries the device id; the setup request's copy never reaches a line
    async with _client() as c:
        verifier, challenge = _pkce()
        r = await c.post(
            "/api/v2/desktop/setup-codes",
            json={"challenge": challenge, "device_name": "d4660 ignored", "device_id": SAME_MACHINE},
        )
        assert r.status_code == 201, r.text
        code, setup_id = r.json()["code"], r.json()["setup_id"]
        assert (await _line(setup_id))[2] is None
        assert (await _confirm(c, code)).status_code == 200
        assert (await _line(setup_id))[2] is None
        ok = await c.post(EXCHANGE, json={"code": code, "verifier": verifier})
        assert ok.status_code == 200, ok.text
        assert (await _line(setup_id))[2] is None
