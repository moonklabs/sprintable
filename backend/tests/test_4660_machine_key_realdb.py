"""story 4660 (design 4660 · PO 결정 · 까디르 렌즈) — a new setup on the same machine closes the old «연결된 기기» lines.

Real database. The app sends `device_id` (its salted hash of the machine id) with the exchange; the server keeps an org-scoped
HMAC of it and, for the same org and key, closes the older lines with the reason replaced_by_new_setup and revokes their device
tokens (the old token is then refused by the relay). The agents and their keys stay.
"""
from __future__ import annotations

import logging
import uuid

import pytest

from app.core.config import settings
from app.services.desktop_setup import machine_key_for
from tests.test_4424_desktop_setup_realdb import (  # noqa: F401 — fixtures (autouse ones apply here too)
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


@pytest.fixture
def secret(monkeypatch):
    monkeypatch.setattr(settings, "channel_oauth_state_secret", SECRET)
    return SECRET


async def _device(c, name: str, device_id: str | None) -> dict:
    """A device set up on this org: code, confirm, exchange — with the device_id when given."""

    code, verifier = await _code(c, name)
    assert (await _confirm(c, code)).status_code == 200
    body = {"code": code, "verifier": verifier, **({"device_id": device_id} if device_id else {})}
    r = await c.post("/api/v2/desktop/setup-codes/exchange", json=body)
    assert r.status_code == 200, r.text
    return r.json()


def _tok(token: str) -> dict:
    return {"x-desktop-device-token": token}


async def _line(setup_id: str) -> tuple:
    rows = await _sql(fetch=f"SELECT revoked_at IS NOT NULL, revoked_reason, machine_key FROM desktop_setups WHERE id = '{setup_id}'")
    return tuple(rows[0])


async def test_the_same_machine_twice_closes_the_old_line_and_its_old_token_is_refused(world, secret):
    async with _client() as c:
        first = await _device(c, "d4660 mac first", SAME_MACHINE)
        # the old line is heard from once, so it has a «last heard» time to show
        assert (await c.put("/api/v2/desktop/relay/sessions", json={"report_seq": 1, "sessions": []}, headers=_tok(first["device_token"]))).status_code == 200

        second = await _device(c, "d4660 mac second", SAME_MACHINE)

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

        # the old line's agents and their keys are not stopped by the replacement (only its device token is revoked)
        live_keys = (await _sql(fetch=f"SELECT count(*) FROM agent_api_keys k WHERE k.desktop_setup_id = '{first['setup_id']}' AND k.revoked_at IS NULL"))[0][0]
        assert live_keys == len(first["agents"])


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
