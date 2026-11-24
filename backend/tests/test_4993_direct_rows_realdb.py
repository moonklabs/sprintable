"""story 4993 (web PR 5a) — the ROW the web builds for the same-network direct road must be what the server makes the Mac's payload of, for the same press. The server's `create_command` builds the payload from the web's post body; the direct row has to carry the same
payload (`contracts/direct-rows.json` says which body fields make it) or a command that goes the direct road would reach the Mac in another shape than one that goes by the server — a drift the web's own test cannot see. The web's test (apps/web/src/lib/phone-direct.test.ts)
reads the same file and builds the row from the same bodies. The server's code is not changed by this: it is only asked, for each case, what it makes.
"""
from __future__ import annotations

import json
import uuid
from pathlib import Path

import pytest

from tests.test_4424_desktop_setup_realdb import (  # noqa: F401 — fixtures (autouse ones apply here too)
    _addresses,
    _client,
    _dispose_global_engine_after_test,
    _person,
    _sql,
    anyio_backend,
    world,
)
from tests.test_4534_desktop_commands_realdb import _cmd, _post, _remote_control_on, _world  # noqa: F401
from tests.test_4535_org_remote_control_realdb import _switch as _remote_control_switch  # noqa: F401
from tests.test_4976_sealed_prompt_realdb import _sealed_cmd, _setup_id
from tests.test_4714_start_realdb import (  # noqa: F401 — the start's own helpers (+ its autouse project fixture: the setup it makes names a second project)
    _more_projects,
    _post as _start_post,
    _setup as _start_setup,
    _start,
    _startable,
)
from tests.test_4733_clock_realdb import _post as _clock_post, _press, _setup as _clock_setup
from tests.test_4424_desktop_setup_realdb import OWNER, PROJ  # noqa: F401
from tests.test_4529_desktop_relay_realdb import _device, _tok
from tests.test_4533_agent_permissions_realdb import (  # noqa: F401 — the permission-request helpers (its autouse fixture too)
    REQS,
    _answer,
    _ask,
    _pair,
    _post_ask,
    _register,
    _with_session,
)
from tests.test_4580_agent_allowed_hosts_realdb import _confirm, _later, _network_ask, _set_runtime

pytestmark = pytest.mark.anyio
_ROWS = json.loads((Path(__file__).resolve().parents[2] / "contracts" / "direct-rows.json").read_text(encoding="utf-8"))


async def _payload(cid):
    return (await _sql(fetch=f"SELECT payload FROM desktop_commands WHERE id = '{cid}'"))[0][0]


async def test_the_server_makes_the_payload_the_direct_row_carries_for_the_same_body(world):
    async with _client() as c:
        device, agent, phone, _der, conv = await _world(c, "d4993 rows a")
        sid = await _setup_id("d4993 rows a")
        for case in _ROWS["cases"]:
            if case["sealed"]:
                body = _sealed_cmd(sid, phone, conv)
            else:
                body = _cmd(case["kind"], phone, conv=None if case["kind"] != "send_prompt" else conv)
            assert body["kind"] == case["kind"], case["name"]
            r = await _post(c, agent, body)
            assert r.status_code == 201, (case["name"], r.text)
            made = await _payload(r.json()["command_id"])
            want = {k: body[k] for k in case["payload_from_body"]}
            assert made == want, (case["name"], "the server's payload is not what the direct row carries for the same body")
            assert list(want) == case["payload_from_body"], "the file's own order is the row's order"
            assert "phone_key_id" not in made and "idempotency_key" not in made, "the key and the key id stay beside the command, never in its payload"


async def test_a_plain_instruction_is_not_a_direct_case_and_the_server_still_makes_its_plain_payload(world):
    async with _client() as c:
        device, agent, phone, _der, conv = await _world(c, "d4993 rows b")
        for case in _ROWS["never_direct"]:
            assert case["kind"] == "send_prompt" and case["sealed"] is False
        r = await _post(c, agent, _cmd("send_prompt", phone, conv=conv))
        assert r.status_code == 201, r.text
        # the plain shape keeps its words in the payload — which is exactly why it never rides the direct road
        assert set(await _payload(r.json()["command_id"])) == {"session_key", "text", "conversation_id", "signed"}


async def _row(cid):
    return (await _sql(fetch=f"SELECT kind, session_key, payload FROM desktop_commands WHERE id = '{cid}'"))[0]


async def test_a_start_and_a_clock_press_make_the_payload_and_the_empty_session_the_direct_rows_carry(world):
    """story 4993 (5b-1): `other_routes` of contracts/direct-rows.json — a signed START and a signed CLOCK press ride the road with the payload the server makes for the same press and NO session; the press of the whole computer and an edit never do."""
    cases = {c["verb"] + ":" + ",".join(c["payload_keys"]): c for c in _ROWS["other_routes"] if c["verb"] in ("start", "clock")}
    assert len(cases) == 3
    async with _client() as c:
        # a START
        device, agent, phone, _der = await _start_setup(c, "d4993 rows start")
        sid = device["setup_id"]
        await c.put("/api/v2/desktop/relay/startable", json=_startable((agent, PROJ)), headers=_tok(device["device_token"]))
        r = await _start_post(c, agent, _start(phone, sid))
        assert r.status_code == 201, r.text
        kind, session_key, payload = await _row(r.json()["command_id"])
        case = cases["start:agent_member_id,project_id,signed"]
        assert (kind, session_key) == (case["kind"], case["session_key"])
        assert list(payload) == case["payload_keys"] or set(payload) == set(case["payload_keys"]), "the server's payload keys are the row's"
        assert payload == {"agent_member_id": agent, "project_id": str(PROJ), "signed": "eyJ2IjoxfQ.signed-by-the-phone"}, "the agent is the URL's agent (the web puts the press's agent there)"
        assert "phone_key_id" not in payload and "idempotency_key" not in payload and "setup_id" not in payload
    async with _client() as c:
        # a CLOCK press of one agent, and of the computer's setup (no agent named)
        device, agent, phone, _der = await _clock_setup(c, "d4993 rows clock")
        sid = device["setup_id"]
        one = await _clock_post(c, sid, _press(phone, "out_open", agent_member_id=agent))
        assert one.status_code == 201, one.text
        kind, session_key, payload = await _row(one.json()["command_id"])
        case = cases["clock:action,signed,agent_member_id"]
        assert (kind, session_key) == (case["kind"], case["session_key"])
        assert payload == {"action": "out_open", "signed": "eyJ2IjoxfQ.signed-by-the-phone", "agent_member_id": agent}
        assert set(payload) == set(case["payload_keys"])
        whole_setup = await _clock_post(c, sid, _press(phone, "out_cancel"))
        assert whole_setup.status_code == 201, whole_setup.text
        kind, session_key, payload = await _row(whole_setup.json()["command_id"])
        case = cases["clock:action,signed"]
        assert (kind, session_key) == (case["kind"], case["session_key"])
        assert payload == {"action": "out_cancel", "signed": "eyJ2IjoxfQ.signed-by-the-phone"} and set(payload) == set(case["payload_keys"])
        for never in _ROWS["never_direct_other"]:  # (the whole-computer press gets a `scope` the SERVER computes from its own data — tests 4734 — and an edit carries a draft's fields: neither is a payload the web can write, so neither rides the road)
            assert never["verb"] == "clock" and ("computer" in never["body_extra"] or "edit" in never["body_extra"])


async def test_an_answer_to_a_permission_request_makes_the_payload_and_the_session_the_direct_row_carries(world):
    """story 4993 (5b-2): `other_routes` verb `approval` — the server fills session_key and request_id from the ROW (the web's values are the row's own: the list carries them), so the payload and the command's own session are what the direct row sends for the same press; the confirm stage of the network question adds {stage, host}."""
    cases = {c["name"]: c for c in _ROWS["other_routes"] if c["verb"] == "approval"}
    assert len(cases) == 2
    ask_case = next(c for c in cases.values() if "body_extra" not in c)
    confirm_case = next(c for c in cases.values() if "body_extra" in c)
    async with _client() as c:
        device = await _device(c, name="d4993 rows approval")
        token, sid = device["device_token"], device["setup_id"]
        agent = await _with_session(c, device)
        await _set_runtime(agent, "claude-code")
        phone, der = await _register(c)
        await _pair(c, token, der)
        # the first stage: a plain tool request
        body = _ask(agent); made = await _post_ask(c, device, body)
        assert made.status_code == 201, made.text
        [view] = [v for v in (await c.get(REQS, headers=_person(OWNER))).json()["requests"] if v["request_id"] == body["request_id"]]
        assert view["session_key"] == body["session_key"], "the list carries the session the web puts in the row"
        blob = "eyJ2IjoxfQ.signed-by-the-phone-A"
        ok = await c.post(f"{REQS}/{made.json()['id']}/answer", json=_answer(phone, "deny", signed=blob), headers=_person(OWNER))
        assert ok.status_code == 200, ok.text
        [(payload, session_key)] = [(p, k) for p, k in await _sql(fetch=f"SELECT payload, session_key FROM desktop_commands WHERE setup_id = '{sid}' AND idempotency_key = 'perm:{body['request_id']}'")]
        assert payload == {"session_key": body["session_key"], "request_id": body["request_id"], "decision": "deny", "signed": blob}
        assert set(payload) == set(ask_case["payload_keys"]), "the file's keys are the row's keys (their ORDER is the web test's: a stored JSON object does not keep one)"
        assert session_key == body["session_key"], "the command's own session is the request's"
        # the second stage: the network question's confirm answer carries the host the person saw
        rid, pk = await _network_ask(c, device, agent)
        assert (await c.post(f"{REQS}/{pk}/answer", json=_answer(phone), headers=_person(OWNER))).status_code == 200
        assert (await c.post(_confirm(rid), json={"host": "gitlab.com", "expires_at": _later()}, headers=_tok(token))).status_code == 200
        second = "eyJ2IjoxfQ.second-answer"
        assert (await c.post(f"{REQS}/{pk}/answer", json=_answer(phone, signed=second), headers=_person(OWNER))).status_code == 200
        [(payload2, session_key2)] = [(p, k) for p, k in await _sql(fetch=f"SELECT payload, session_key FROM desktop_commands WHERE setup_id = '{sid}' AND idempotency_key = 'perm:{rid}:confirm'")]
        assert payload2 == {"session_key": "s-1", "request_id": rid, "decision": "allow", "signed": second, "stage": "confirm", "host": confirm_case["body_extra"]["host"]}
        assert set(payload2) == set(confirm_case["payload_keys"]) and session_key2 == "s-1"
