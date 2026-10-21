"""story #4733 (E-DESKTOP-2 · S2 · design 4733-phone-clock-design-1020.md) — a phone clocks a whole computer out and in: the `clock` command word, the
server's checks, the closed clock view the computer reports and the paired phone reads. The server opens no signature and judges no flow state (the daemon's
ClockFlow does); it checks who may press, the computer, the pairing, the closed shapes, the numbering and what it may keep.
Each test goes red without the line it names (mutants in the PR body).
"""
from __future__ import annotations

import logging
import uuid
from datetime import datetime, timedelta, timezone

import pytest

from tests.test_4424_desktop_setup_realdb import (  # noqa: F401 — fixtures (autouse ones apply here too)
    ORG,
    ORG2,
    OUTSIDER,
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
from tests.test_4529_desktop_relay_realdb import _device, _tok
from tests.test_4533_agent_permissions_realdb import _pair, _plain_member, _register
from tests.test_4534_desktop_commands_realdb import _commands, _remote_control_on, _state  # noqa: F401

pytestmark = pytest.mark.anyio

def _iso(minutes_ago: int = 0) -> str:
    """A time relative to now — a fixed wall-clock literal rots (lint_no_hardcoded_iso_timestamp)."""
    return (datetime.now(timezone.utc) - timedelta(minutes=minutes_ago)).isoformat()


LINE = "배포 스크립트 고치다가 멈춘 곳까지 정리함"  # a draft's first line (the kind of text that must not leak into logs)


async def _setup(c, name):
    """A device of the owner's (one agent reported idle) with the owner's phone paired."""
    device = await _device(c, name=name)
    agent = device["agents"][0]["member_id"]
    await _state(c, device, agent, "idle", 1)
    phone, der = await _register(c)
    await _pair(c, device["device_token"], der)
    return device, agent, phone, der


def _press(phone, action="out_open", key=None, **extra):
    return {"action": action, "idempotency_key": key if key is not None else str(uuid.uuid4()), "signed": "eyJ2IjoxfQ.signed-by-the-phone", "phone_key_id": phone, **extra}


def _post(c, sid, body, who=OWNER, headers=None):
    return c.post(f"/api/v2/desktop/setups/{sid}/clock", json=body, headers=headers or _person(who))


def _read(c, sid, phone, who=OWNER):
    return c.get(f"/api/v2/desktop/setups/{sid}/clock", params={"phone_key_id": phone}, headers=_person(who))


def _report(seq, mode="none", **extra):
    return {"seq": seq, "mode": mode, **extra}


def _row(agent, state="ready", **extra):
    return {"agent_member_id": agent, "state": state, **extra}


def _panel(seq, agent, rows=None, **extra):
    return _report(seq, "panel", scope="computer", opened_from="phone", count={"ready": 1, "needs_you": 0, "drafting": 0},
                   rows=rows if rows is not None else [_row(agent, first_line=LINE)], **extra)


def _put(c, device, body):
    return c.put("/api/v2/desktop/relay/clock-view", json=body, headers=_tok(device["device_token"]))


async def _views(sid):
    return await _sql(fetch=f"SELECT mode, view, expires_at - reported_at FROM desktop_clock_views WHERE setup_id = '{sid}'")


async def _seq(sid):
    return (await _sql(fetch=f"SELECT clock_view_seq, clock_seen_at FROM desktop_setups WHERE id = '{sid}'"))[0]


async def _result(c, device, command_id, state, code=None):
    body = {"state": state, **({"result_code": code} if code is not None else {})}
    return await c.post(f"/api/v2/desktop/relay/commands/{command_id}/result", json=body, headers=_tok(device["device_token"]))


async def test_01_a_press_queues_one_clock_command_whose_payload_is_exactly_the_action_and_the_signature(world):
    async with _client() as c:
        device, _agent, phone, _der = await _setup(c, "d4424 mac 4733a")
        sid = device["setup_id"]
        made = {}
        for action in ("out_open", "out_submit", "out_cancel", "in"):
            r = await _post(c, sid, _press(phone, action, key=f"k-{action}"))
            assert (r.status_code, r.json()["state"]) == (201, "queued"), (action, r.text)
            made[action] = r.json()["command_id"]
        rows = await _commands(sid)
        assert [(k, p, key) for k, p, _by, key, _st in rows] == [
            ("clock", {"action": a, "signed": "eyJ2IjoxfQ.signed-by-the-phone"}, f"b5:{OWNER_TM}:k-{a}")
            for a in ("out_open", "out_submit", "out_cancel", "in")
        ]  # the payload has two keys and no more: no session, agent, text or path
        # the same press again (the same key) gets its own command back — not a second one
        again = await _post(c, sid, _press(phone, "out_open", key="k-out_open"))
        assert (again.status_code, again.json()["command_id"]) == (201, made["out_open"])
        assert len(await _commands(sid)) == 4


async def test_02_the_press_forbids_everything_but_its_five_fields_and_four_actions(world):
    async with _client() as c:
        device, _agent, phone, _der = await _setup(c, "d4424 mac 4733b")
        sid = device["setup_id"]
        bad = [
            {**_press(phone), "text": "rm -rf ~"}, {**_press(phone), "session_key": "s-1"},
            {**_press(phone), "path": "/Users/x"}, _press(phone, "out_edit"), _press(phone, "out_open", signed=""),
            {k: v for k, v in _press(phone).items() if k != "phone_key_id"}, {k: v for k, v in _press(phone).items() if k != "signed"},
            _press(phone, key=""), _press(phone, key="k" * 101), _press(phone, signed="s" * 16385),
            {**_press(phone), "agent_member_id": "not-a-uuid"}, {**_press(phone), "agent_member_id": ""},
        ]
        for body in bad:
            r = await _post(c, sid, body)
            assert r.status_code == 422, str(body)[-160:]
        assert await _commands(sid) == []


async def test_03_who_may_press_the_computer_level_two_legs_and_nobody_else(world):
    plain_tm = await _plain_member()
    async with _client() as c:
        device, agent, owner_phone, owner_der = await _setup(c, "d4424 mac 4733c")
        sid = device["setup_id"]
        plain_phone, plain_der = await _register(c, PLAIN)
        await _pair(c, device["device_token"], owner_der, plain_der)
        # a plain member: no
        r = await _post(c, sid, _press(plain_phone), who=PLAIN)
        assert (r.status_code, r.json()["error"]["code"]) == (403, "not_allowed_to_command")
        # the agent's owner is NOT enough (that leg is per agent and has no meaning for a whole computer)
        await _sql(f"UPDATE members SET owner_member_id = '{plain_tm}' WHERE id = '{agent}'")
        r = await _post(c, sid, _press(plain_phone), who=PLAIN)
        assert (r.status_code, r.json()["error"]["code"]) == (403, "not_allowed_to_command")
        # a project admin who is an org member is NOT enough (the org role, never a project role)
        await _sql(f"UPDATE members SET owner_member_id = NULL WHERE id = '{agent}'",
                   f"INSERT INTO project_access (id,project_id,member_id,permission,role) VALUES (gen_random_uuid(),'{PROJ}','{plain_tm}','granted','admin')")
        r = await _post(c, sid, _press(plain_phone), who=PLAIN)
        assert (r.status_code, r.json()["error"]["code"]) == (403, "not_allowed_to_command")
        assert await _commands(sid) == []
        # whoever confirmed the device: yes
        await _sql(f"UPDATE desktop_setups SET confirmed_by = '{PLAIN}' WHERE id = '{sid}'")
        assert (await _post(c, sid, _press(plain_phone), who=PLAIN)).status_code == 201
        await _sql(f"UPDATE desktop_setups SET confirmed_by = '{OWNER}' WHERE id = '{sid}'")
        # an org admin: yes
        await _sql(f"UPDATE org_members SET role = 'admin' WHERE org_id = '{ORG}' AND user_id = '{PLAIN}'")
        assert (await _post(c, sid, _press(plain_phone), who=PLAIN)).status_code == 201
        # the other person's phone through the owner's session: not paired to that person
        borrowed = await _post(c, sid, _press(plain_phone))
        assert (borrowed.status_code, borrowed.json()["error"]["code"]) == (409, "phone_not_paired")
        assert len(await _commands(sid)) == 2


async def test_04_a_key_is_no_person_another_organizations_or_a_disconnected_computer_is_no_computer(world):
    from app.core.database import async_session_factory
    from app.repositories.human_api_key import HumanApiKeyRepository

    async with _client() as c:
        device, _agent, phone, _der = await _setup(c, "d4424 mac 4733d")
        sid = device["setup_id"]
        async with async_session_factory() as s:
            _k, plaintext = await HumanApiKeyRepository(s).create(member_id=OWNER_TM, name="d4733 script", expires_at=None)
            await s.commit()
        try:
            for headers in ({"Authorization": f"Bearer {plaintext}", "X-Org-Id": str(ORG)},
                            {"Authorization": f"Bearer {device['agents'][0]['api_key']}", "X-Org-Id": str(ORG)}):
                r = await _post(c, sid, _press(phone), headers=headers)
                assert (r.status_code, r.json()["error"]["code"]) == (403, "person_session_required")
                r = await c.get(f"/api/v2/desktop/setups/{sid}/clock", params={"phone_key_id": phone}, headers=headers)
                assert (r.status_code, r.json()["error"]["code"]) == (403, "person_session_required")
        finally:
            await _sql(f"DELETE FROM human_api_keys WHERE member_id = '{OWNER_TM}'")
        # an admin of ANOTHER organization, in their own organization: no such computer (the same answer as none)
        r = await _post(c, sid, _press(phone), headers=_person(OUTSIDER, ORG2))
        assert (r.status_code, r.json()["error"]["code"]) == (404, "computer_not_found")
        assert (await _post(c, str(uuid.uuid4()), _press(phone))).status_code == 404
        # the device token is no person
        assert (await _post(c, sid, _press(phone), headers=_tok(device["device_token"]))).status_code in (401, 403)
        assert await _commands(sid) == []
        # a disconnected computer
        await _sql(f"UPDATE desktop_setups SET revoked_at = now() WHERE id = '{sid}'")
        r = await _post(c, sid, _press(phone))
        assert (r.status_code, r.json()["error"]["code"]) == (404, "computer_not_found")


async def test_05_remote_control_the_computer_heard_and_the_pairing_are_asked_in_that_order(world):
    async with _client() as c:
        device, agent, phone, _der = await _setup(c, "d4424 mac 4733e")
        sid = device["setup_id"]
        unpaired, _ = await _register(c, label="old phone")
        r = await _post(c, sid, _press(unpaired))
        assert (r.status_code, r.json()["error"]["code"]) == (409, "phone_not_paired")
        # a computer not heard from for a while: unreachable
        await _sql(f"UPDATE desktop_device_tokens SET last_used_at = now() - interval '1 hour' WHERE setup_id = '{sid}'")
        r = await _post(c, sid, _press(phone))
        assert (r.status_code, r.json()["error"]["code"]) == (409, "device_unreachable")
        await _state(c, device, agent, "idle", 2)  # heard again
        assert (await _post(c, sid, _press(phone))).status_code == 201
        first = (await _commands(sid))
        assert len(first) == 1
        # the organization's remote control off: no press — and it is asked BEFORE the computer's hearing (off AND silent → the switch's word)
        await _sql(f"UPDATE organizations SET remote_control_enabled_at = NULL WHERE id = '{ORG}'",
                   f"UPDATE desktop_device_tokens SET last_used_at = now() - interval '1 hour' WHERE setup_id = '{sid}'")
        r = await _post(c, sid, _press(phone))
        assert (r.status_code, r.json()["error"]["code"]) == (409, "remote_control_off")
        # …but the SAME press again (its own key) is still its own command, whatever the switch and the hearing say now
        again = await _post(c, sid, _press(phone, key=first[0][3].split(":", 2)[2]))
        assert (again.status_code, len(await _commands(sid))) == (201, 1)


async def test_06_the_daemons_finished_clock_command_ends_in_one_of_nine_words_and_the_presser_reads_it(world):
    async with _client() as c:
        device, _agent, phone, _der = await _setup(c, "d4424 mac 4733f")
        sid = device["setup_id"]
        made = (await _post(c, sid, _press(phone, "out_open"))).json()["command_id"]
        assert (await _result(c, device, made, "acked")).status_code == 200
        # a done result without a word · with a word of someone else's · with a made-up one → refused, the command stays acked
        for code in (None, "done", "terminated_clock", "needs_hand", "failed", "ok_"):
            r = await _result(c, device, made, "done", code)
            assert (r.status_code, r.json()["error"]["code"]) == (422, "invalid_result_code"), code
        for code in ("OK", "ok ", "ok-"):  # not even the ordinary word shape
            assert (await _result(c, device, made, "done", code)).status_code == 422, code
        assert (await _commands(sid))[0][4] == "acked"
        read = await c.get(f"/api/v2/desktop/setups/{sid}/clock/commands/{made}", headers=_person(OWNER))
        assert (read.status_code, read.json()) == (200, {"command_id": made, "kind": "clock", "action": "out_open", "state": "acked", "result_code": None})
        assert (await _result(c, device, made, "done", "ok")).status_code == 200
        read = await c.get(f"/api/v2/desktop/setups/{sid}/clock/commands/{made}", headers=_person(OWNER))
        assert read.json()["state"] == "done" and read.json()["result_code"] == "ok"
        # each of the nine is accepted on its own command
        for i, code in enumerate(("already", "nothing_running", "not_open", "not_ready", "needs_hands", "not_clocked_out", "unknown_agent", "already_running")):
            cid = (await _post(c, sid, _press(phone, "in", key=f"k{i}"))).json()["command_id"]
            assert (await _result(c, device, cid, "done", code)).status_code == 200, code
        # a failed or rejected one keeps the ordinary pattern (the daemon refused the signature, the command was too old…)
        cid = (await _post(c, sid, _press(phone, "in", key="kf"))).json()["command_id"]
        assert (await _result(c, device, cid, "rejected", "signature_invalid")).status_code == 200
        # only the person who pressed reads it — and not through another computer
        other = await c.get(f"/api/v2/desktop/setups/{sid}/clock/commands/{made}", headers=_person(PLAIN))
        assert other.status_code in (403, 404)
        wrong = await c.get(f"/api/v2/desktop/setups/{uuid.uuid4()}/clock/commands/{made}", headers=_person(OWNER))
        assert (wrong.status_code, wrong.json()["error"]["code"]) == (404, "command_not_found")


async def test_07_the_report_is_closed_a_field_that_does_not_fit_its_mode_is_refused(world):
    async with _client() as c:
        device, agent, _phone, _der = await _setup(c, "d4424 mac 4733g")
        sid = device["setup_id"]
        ok_out = {"at": datetime.now(timezone.utc).isoformat(), "came": 0, "warn": "none", "still_working": [], "left": ["Writer"]}
        refused = [
            _report(1, "none", rows=[_row(agent)]),                                   # none carries nothing
            _report(1, "none", opened_from="mac"),
            _report(1, "out", scope="computer", out=ok_out),                           # scope belongs to a panel
            _report(1, "out", rows=[_row(agent)], out=ok_out),                         # an out is names, not rows
            _report(1, "in", count={"ready": 1, "needs_you": 0, "drafting": 0}),      # count belongs to a panel
            _report(1, "panel", out=ok_out),                                           # out belongs to mode out
            _report(1, "panel", **{"in": {}}),                                         # in belongs to mode in
            _report(1, "panel", rows=[_row(agent, "saved", first_line="x")]),          # a saved row has no first line
            _report(1, "panel", rows=[_row(agent, "ended", first_line="x")]),
            _report(1, "panel", rows=[_row(agent, "not_ended", first_line="x")]),
            _report(1, "panel", rows=[_row(agent, first_line="x" * 61)]),              # 61
            _report(1, "panel", rows=[_row(agent, first_line="a\nb")]),                # one line
            _report(1, "panel", rows=[_row(agent, first_line="")]),
            _report(1, "panel", rows=[_row(agent, idle=True, first_line="x")]),        # an idle row has no draft
            _report(1, "panel", rows=[_row(agent, idle=True, missing=["done"])]),
            _report(1, "panel", rows=[_row(agent, "weird")]),                          # state: eight words
            _report(1, "panel", rows=[_row(agent, missing=["done", "done"])]),
            _report(1, "panel", rows=[_row(agent, missing=["notes"])]),
            _report(1, "panel", rows=[_row(agent), _row(agent)]),                      # an agent is one row
            _report(1, "panel", rows=[_row(str(uuid.uuid4())) for _ in range(65)]),   # 64 at most
            _report(1, "panel", opened_from="tablet"),                                 # three words and null
            _report(1, "tomorrow"), _report(0, "none"), _report(2**62 + 1, "none"), _report(True, "none"),
            {"mode": "none"}, {**_report(1, "none"), "extra": 1},
            _report(1, "panel", rows=[{**_row(agent), "name": "Writer"}]),             # the name is the board's, not the computer's
            _report(1, "out", out={**ok_out, "warn": "loud"}),
            _report(1, "out", out={**ok_out, "left": ["a"] * 65}),
            _report(1, "out", out={**ok_out, "left": ["a" * 81]}),
            _report(1, "out", out={**ok_out, "left": ["a\nb"]}),
            _report(1, "out", out={**ok_out, "path": "/x"}),
            _report(1, "out", out={**ok_out, "alone": -1}), _report(1, "out", out={**ok_out, "alone": 1.5}),
            _report(1, "none", outs=[{"agent_member_id": agent, "at": _iso(0)}] * 2),         # an agent is one entry
            _report(1, "none", outs=[{"agent_member_id": str(uuid.uuid4()), "at": _iso(0)} for _ in range(65)]),
            _report(1, "none", outs=[{"agent_member_id": agent}]), _report(1, "none", outs=[{"agent_member_id": agent, "at": "yesterday"}]),
            _report(1, "none", outs=[{"agent_member_id": agent, "at": _iso(0), "name": "Writer"}]),
            _report(1, "in", **{"in": {"failed": [{"name": "W", "code": "No Folder"}]}}),
            _report(1, "in", **{"in": {"failed": [{"name": "W", "code": "no_folder", "path": "/x"}]}}),
            _report(1, "in", **{"in": {"starting": {"k": 1}}}),
        ]
        for body in refused:
            r = await _put(c, device, body)
            assert r.status_code == 422, body
        assert await _views(sid) == [] and (await _seq(sid))[0] is None  # nothing stored, no number taken
        # the accepted shapes: panel (with an idle row) · out · in · none
        assert (await _put(c, device, _report(1, "panel", scope="one", opened_from="mac", rows=[_row(agent, "ready", idle=True)]))).status_code == 200
        assert (await _put(c, device, _report(2, "out", opened_from=None, out=ok_out))).status_code == 200
        full_in = {"at": None, "starting": {"k": 1, "n": 2}, "handing": {"k": 0, "m": 1}, "came": {"total": 3, "task": 1, "message": 1, "recipe": 1, "event": 0},
                   "failed": [{"name": "Writer", "code": "no_folder", "limit": 3}], "unread": ["Reviewer"]}
        assert (await _put(c, device, _report(3, "in", **{"in": full_in}))).status_code == 200
        assert (await _put(c, device, _report(4, "none"))).status_code == 200
        assert (await _put(c, device, _report(5, "none", outs=[{"agent_member_id": agent, "at": _iso(0)}]))).status_code == 200
        assert (await _put(c, device, _report(6, "out", out={**ok_out, "alone": 1}, outs=[{"agent_member_id": agent, "at": _iso(0)}]))).status_code == 200


async def test_08_the_numbering_a_late_lower_number_neither_covers_nor_brings_back(world):
    async with _client() as c:
        device, agent, _phone, _der = await _setup(c, "d4424 mac 4733h")
        sid = device["setup_id"]
        assert (await _put(c, device, _panel(5, agent))).json() == {"applied": True, "clock_view_seq": 5, "dropped_rows": 0}
        # same number · lower number: ignored, nothing changes, the number held is told
        for seq in (5, 3):
            r = await _put(c, device, _panel(seq, agent, rows=[_row(agent, "needs_you", missing=["plan"])]))
            assert (r.status_code, r.json()) == (200, {"applied": False, "clock_view_seq": 5, "dropped_rows": 0})
        assert (await _views(sid))[0][1]["rows"][0]["state"] == "ready"
        # a higher number covers
        assert (await _put(c, device, _panel(6, agent, rows=[_row(agent, "needs_you", missing=["plan"])]))).json()["applied"] is True
        assert (await _views(sid))[0][1]["rows"][0]["state"] == "needs_you"
        # none deletes the row — and a late lower-numbered panel cannot bring it back
        assert (await _put(c, device, _report(7, "none"))).json() == {"applied": True, "clock_view_seq": 7, "dropped_rows": 0}
        assert await _views(sid) == []
        assert (await _put(c, device, _panel(6, agent))).json() == {"applied": False, "clock_view_seq": 7, "dropped_rows": 0}
        assert await _views(sid) == []
        assert (await _seq(sid))[0] == 7
        # the device token is the only way in: a person is no device
        assert (await c.put("/api/v2/desktop/relay/clock-view", json=_report(8), headers=_person(OWNER))).status_code == 401
        # remote control off: the whole device line is off (409), a number is not taken
        await _sql(f"UPDATE organizations SET remote_control_enabled_at = NULL WHERE id = '{ORG}'")
        assert (await _put(c, device, _report(9))).status_code == 409
        assert (await _seq(sid))[0] == 7


async def test_09_rows_of_an_agent_this_computer_was_not_set_up_with_are_dropped_and_counted(world):
    async with _client() as c:
        device, agent, _phone, _der = await _setup(c, "d4424 mac 4733i")
        sid = device["setup_id"]
        stranger = str(uuid.uuid4())
        r = await _put(c, device, _panel(1, agent, rows=[_row(agent, first_line=LINE), _row(stranger, first_line="secret of someone else's agent")]))
        assert (r.status_code, r.json()) == (200, {"applied": True, "clock_view_seq": 1, "dropped_rows": 1})
        stored = (await _views(sid))[0][1]
        assert [x["agent_member_id"] for x in stored["rows"]] == [agent] and "secret" not in str(stored)


async def test_10_the_paired_phone_of_a_person_who_may_command_reads_it_names_are_the_boards_and_the_first_line_needs_the_agent(world):
    plain_tm = await _plain_member()
    async with _client() as c:
        device, agent, phone, owner_der = await _setup(c, "d4424 mac 4733j")
        sid = device["setup_id"]
        # an older app that never spoke of the clock: not supported, no view
        none = (await _read(c, sid, phone)).json()
        assert none == {"remote_control": True, "reachable": True, "supported": False, "view": None}
        # it speaks (an idle report): supported, still no view
        assert (await _put(c, device, _report(1))).status_code == 200
        assert (await _read(c, sid, phone)).json()["supported"] is True and (await _read(c, sid, phone)).json()["view"] is None
        await _put(c, device, _panel(2, agent))
        view = (await _read(c, sid, phone)).json()["view"]
        name = (await _sql(fetch=f"SELECT name FROM members WHERE id = '{agent}'"))[0][0]
        assert view["mode"] == "panel" and view["scope"] == "computer" and view["opened_from"] == "phone"
        assert view["rows"] == [{"agent_member_id": agent, "state": "ready", "missing": [], "first_line": LINE, "idle": False, "rev": 0, "edited": False, "name": name}]
        assert view["count"] == {"ready": 1, "needs_you": 0, "drafting": 0} and view["reported_at"]
        # another person who may command (the device's confirmer) but has NO access to that agent: the row, not the line
        plain_phone, plain_der = await _register(c, PLAIN)
        await _pair(c, device["device_token"], owner_der, plain_der)
        await _sql(f"UPDATE desktop_setups SET confirmed_by = '{PLAIN}' WHERE id = '{sid}'")
        seen = (await _read(c, sid, plain_phone, PLAIN)).json()["view"]
        assert seen["rows"][0]["state"] == "ready" and seen["rows"][0]["first_line"] is None and seen["rows"][0]["name"] == name
        # …and with access to the agent's project: the line
        await _sql(f"INSERT INTO project_access (id,project_id,member_id,permission) VALUES (gen_random_uuid(),'{PROJ}','{plain_tm}','granted')",
                   f"INSERT INTO agent_project_profiles (id,member_id,project_id) VALUES (gen_random_uuid(),'{agent}','{PROJ}') ON CONFLICT DO NOTHING")
        assert (await _read(c, sid, plain_phone, PLAIN)).json()["view"]["rows"][0]["first_line"] == LINE
        # who may not read: a plain member (not the confirmer) · someone else's phone · a phone not paired
        await _sql(f"UPDATE desktop_setups SET confirmed_by = '{OWNER}' WHERE id = '{sid}'")
        r = await _read(c, sid, plain_phone, PLAIN)
        assert (r.status_code, r.json()["error"]["code"]) == (403, "not_allowed_to_command")
        r = await _read(c, sid, plain_phone, OWNER)
        assert (r.status_code, r.json()["error"]["code"]) == (409, "phone_not_paired")
        unpaired, _ = await _register(c, label="old phone")
        assert (await _read(c, sid, unpaired)).status_code == 409
        # an agent that is gone is not a row
        await _sql(f"UPDATE members SET deleted_at = now() WHERE id = '{agent}'")
        assert (await _read(c, sid, phone)).json()["view"]["rows"] == []
        # remote control off: the line is off — no view (and the rows are deleted, see test 12)
        await _sql(f"UPDATE organizations SET remote_control_enabled_at = NULL WHERE id = '{ORG}'")
        off = (await _read(c, sid, phone)).json()
        assert off["remote_control"] is False and off["view"] is None


async def test_11_expiry_a_moving_flow_half_an_hour_the_nights_out_thirty_six_hours_and_the_read_deletes_the_expired(world):
    async with _client() as c:
        device, agent, phone, _der = await _setup(c, "d4424 mac 4733k")
        sid = device["setup_id"]
        out = {"at": datetime.now(timezone.utc).isoformat(), "came": 2, "warn": "none", "still_working": [], "left": ["Writer"]}
        await _put(c, device, _panel(1, agent))
        assert (await _views(sid))[0][2] == timedelta(minutes=30)
        await _put(c, device, _report(2, "in", **{"in": {"starting": {"k": 1, "n": 2}}}))
        assert (await _views(sid))[0][2] == timedelta(minutes=30)
        await _put(c, device, _report(3, "out", opened_from=None, out=out))
        assert (await _views(sid))[0][2] == timedelta(hours=36)
        # the read does not give an expired view and deletes it
        await _sql(f"UPDATE desktop_clock_views SET expires_at = now() - interval '1 second' WHERE setup_id = '{sid}'")
        assert (await _read(c, sid, phone)).json()["view"] is None
        assert await _views(sid) == []
        # the numbering survives the expiry: a late lower number still does not bring it back
        assert (await _put(c, device, _report(2, "in", **{"in": {}}))).json()["applied"] is False
        assert await _views(sid) == []


async def test_12_a_submitted_or_cancelled_clock_out_takes_the_draft_lines_off_at_once_and_nothing_else_does(world):
    async with _client() as c:
        device, agent, phone, _der = await _setup(c, "d4424 mac 4733l")
        sid = device["setup_id"]

        async def stored_line():
            return (await _views(sid))[0][1]["rows"][0]["first_line"]

        for action, code in (("out_submit", "ok"), ("out_cancel", "ok")):
            await _put(c, device, _panel((await _seq(sid))[0] + 1 if (await _seq(sid))[0] else 1, agent))
            assert await stored_line() == LINE
            made = (await _post(c, sid, _press(phone, action))).json()["command_id"]
            # not done yet (acked), refused (done without a word), failed, another action done: the line stays
            assert (await _result(c, device, made, "acked")).status_code == 200
            assert await stored_line() == LINE
            assert (await _result(c, device, made, "done", "made_up")).status_code == 422
            assert await stored_line() == LINE
            other = (await _post(c, sid, _press(phone, "out_open", key=f"o-{action}"))).json()["command_id"]
            assert (await _result(c, device, other, "done", "ok")).status_code == 200
            assert await stored_line() == LINE
            # done: gone at once, the row (its state) stays for the phone until the computer's next report
            assert (await _result(c, device, made, "done", "ok")).status_code == 200
            assert await stored_line() is None and (await _views(sid))[0][1]["rows"][0]["state"] == "ready"
        # a submit that FAILED leaves the draft where it is (the flow is still open)
        await _put(c, device, _panel((await _seq(sid))[0] + 1, agent))
        failed = (await _post(c, sid, _press(phone, "out_submit", key="kfail"))).json()["command_id"]
        assert (await _result(c, device, failed, "failed", "save_failed")).status_code == 200
        assert await stored_line() == LINE


async def test_13_a_disconnect_and_remote_control_off_take_the_view_off_the_server(world):
    async with _client() as c:
        device, agent, _phone, _der = await _setup(c, "d4424 mac 4733m")
        sid = device["setup_id"]
        await _put(c, device, _panel(1, agent))
        assert len(await _views(sid)) == 1
        # remote control off (the owner's switch): every view of the organization goes with the rest of the line
        r = await c.put(f"/api/v2/organizations/{ORG}/remote-control", json={"enabled": False}, headers=_person(OWNER))
        assert r.status_code == 200, r.text
        assert await _views(sid) == []
        await _sql(f"UPDATE organizations SET remote_control_enabled_at = now() WHERE id = '{ORG}'")
        await _put(c, device, _panel(2, agent))
        assert len(await _views(sid)) == 1
        # the computer is disconnected (the web's [연결 끊기]): its view goes
        r = await c.delete(f"/api/v2/desktop/setups/{sid}", headers=_person(OWNER))
        assert r.status_code == 200, r.text
        assert await _views(sid) == []


async def test_14_no_log_line_carries_a_draft_line_or_a_name_on_any_clock_road(world, caplog):
    from app.main import app  # noqa: F401 — importing the app configures logging and clears the root handlers (caplog's included): attach it again
    logging.getLogger().addHandler(caplog.handler)
    caplog.set_level(logging.DEBUG)
    async with _client() as c:
        device, agent, phone, _der = await _setup(c, "d4424 mac 4733n")
        sid = device["setup_id"]
        name = "Leaky Name"
        await _sql(f"UPDATE members SET name = '{name}' WHERE id = '{agent}'")
        await _put(c, device, _panel(1, agent))
        await _read(c, sid, phone)
        made = (await _post(c, sid, _press(phone, "out_submit"))).json()["command_id"]
        await _result(c, device, made, "done", "ok")
        refused = await _put(c, device, _report(2, "panel", rows=[_row(agent, "saved", first_line=LINE)]))  # a refused one is not logged either
        assert refused.status_code == 422
        await _put(c, device, _report(3))
    text = "\n".join(f"{r.getMessage()} {r.args}" for r in caplog.records)
    assert len(caplog.records) > 5, "the capture really sees the app's log lines (the requests are logged)"
    assert LINE not in text and name not in text and "signed-by-the-phone" not in text


async def test_15_the_database_holds_the_same_lists_as_the_code(world):
    from app.models.desktop_relay import CLOCK_VIEW_MODES, COMMAND_KINDS

    assert "clock" in COMMAND_KINDS
    defs = {n: d for n, d in await _sql(fetch=(
        "SELECT conname, pg_get_constraintdef(oid) FROM pg_constraint WHERE conname IN ('ck_desktop_commands_kind','ck_desktop_clock_views_mode')"))}
    import re

    assert set(re.findall(r"'([a-z_]+)'", defs["ck_desktop_commands_kind"])) == set(COMMAND_KINDS)
    assert set(re.findall(r"'([a-z_]+)'", defs["ck_desktop_clock_views_mode"])) == set(CLOCK_VIEW_MODES) == {"none", "panel", "out", "in"}
    # a row of a made-up mode cannot be stored even by hand
    async with _client() as c:
        device, _agent, _phone, _der = await _setup(c, "d4424 mac 4733o")
        sid = device["setup_id"]
        with pytest.raises(Exception):  # noqa: B017 — the CHECK
            await _sql(f"INSERT INTO desktop_clock_views (setup_id, mode, view, expires_at) VALUES ('{sid}','tomorrow','{{}}', now())")
        await _sql(f"INSERT INTO desktop_clock_views (setup_id, mode, view, expires_at) VALUES ('{sid}','out','{{}}', now())")
        # the view goes with its computer (ON DELETE CASCADE)
        await _sql(f"DELETE FROM desktop_setups WHERE id = '{sid}'")
        assert await _views(sid) == []


# ── the lifecycle edges (codex read of the first head): races, rotation, the other ways a computer is cut off ────────────────────────


async def test_16_a_press_holds_its_pairing_and_phone_key_until_it_commits(world):
    from sqlalchemy import text
    from sqlalchemy.ext.asyncio import create_async_engine
    from sqlalchemy.pool import NullPool

    from app.core.database import async_session_factory
    from app.services import desktop_clock
    from tests.test_4424_desktop_setup_realdb import _ASYNC

    async with _client() as c:
        device, _agent, phone, _der = await _setup(c, "d4424 mac 4733p")
    sid = uuid.UUID(device["setup_id"])
    async with async_session_factory() as s:
        cmd, state = await desktop_clock.create_clock(
            s, member_id=OWNER_TM, user_id=OWNER, org_id=ORG, setup_id=sid, body=desktop_clock.ClockRequest(**_press(phone)),
        )
        assert state == "queued"  # not committed yet

        async def other(sql):
            eng = create_async_engine(_ASYNC, poolclass=NullPool)
            try:
                async with eng.begin() as conn:
                    await conn.execute(text("SET LOCAL lock_timeout = '300ms'"))
                    await conn.execute(text(sql))
            finally:
                await eng.dispose()

        # an [빼기] and a key revocation that come now WAIT for the press (here: give up after 300 ms) — they cannot slip in behind the check
        with pytest.raises(Exception, match="lock"):
            await other(f"UPDATE remote_device_pairings SET removed_at = now() WHERE setup_id = '{sid}'")
        with pytest.raises(Exception, match="lock"):
            await other(f"UPDATE remote_devices SET revoked_at = now() WHERE id = '{phone}'")
        await s.rollback()
    await other(f"UPDATE remote_device_pairings SET removed_at = now() WHERE setup_id = '{sid}'")  # nothing holds them any more


async def test_17_a_report_that_waited_for_the_lock_sees_a_disconnect_or_remote_control_off_and_writes_nothing(world):
    from app.core.database import async_session_factory
    from app.models.desktop_setup import DesktopSetup
    from app.services import desktop_clock
    from app.services.desktop_relay import DesktopRelayError

    async with _client() as c:
        device, agent, _phone, _der = await _setup(c, "d4424 mac 4733q")
        other_device, _a2, _p2, _d2 = await _setup(c, "d4424 mac 4733q2")
    sid = uuid.UUID(device["setup_id"])
    assert other_device["setup_id"] != device["setup_id"]
    report = desktop_clock.ClockViewReport.model_validate(_panel(1, agent))
    async with async_session_factory() as s:
        setup = await s.get(DesktopSetup, sid)  # loaded before what follows commits
        await _sql(f"UPDATE organizations SET remote_control_enabled_at = NULL WHERE id = '{ORG}'")
        with pytest.raises(DesktopRelayError) as exc:
            await desktop_clock.apply_clock_view(s, setup, report)
        assert exc.value.code == "remote_control_off"
        await s.rollback()
    await _sql(f"UPDATE organizations SET remote_control_enabled_at = now() WHERE id = '{ORG}'", f"UPDATE desktop_setups SET revoked_at = now() WHERE id = '{sid}'")
    async with async_session_factory() as s:
        setup = await s.get(DesktopSetup, sid)
        with pytest.raises(DesktopRelayError) as exc:
            await desktop_clock.apply_clock_view(s, setup, report)
        assert exc.value.code == "device_disconnected"
        await s.rollback()
    assert await _views(str(sid)) == [] and (await _seq(str(sid)))[0] is None
    # a view that ran out of time goes with the next report of ANY computer (a disconnected computer's included)
    await _sql(f"INSERT INTO desktop_clock_views (setup_id, mode, view, expires_at) VALUES ('{sid}','out','{{}}', now() - interval '1 minute')")
    assert len(await _views(str(sid))) == 1
    async with _client() as c:
        assert (await _put(c, other_device, _report(1))).status_code == 200
    assert await _views(str(sid)) == []


async def test_18_a_new_device_token_starts_the_clock_numbering_over_and_drops_the_old_view_and_an_ignored_report_still_counts_as_spoken(world):
    from app.core.database import async_session_factory
    from app.services import desktop_relay

    async with _client() as c:
        device, agent, _phone, _der = await _setup(c, "d4424 mac 4733r")
        sid = device["setup_id"]
        await _put(c, device, _panel(50, agent))
        assert (await _seq(sid))[0] == 50 and len(await _views(sid)) == 1
        # an ignored (lower) report still marks that the computer speaks of the clock
        await _sql(f"UPDATE desktop_setups SET clock_seen_at = NULL WHERE id = '{sid}'")
        assert (await _put(c, device, _report(10))).json()["applied"] is False
        assert (await _seq(sid))[1] is not None
        # a reinstall: the exchange issues a new token
        async with async_session_factory() as s:
            token = await desktop_relay.issue_device_token(s, uuid.UUID(sid))
            await s.commit()
        assert (await _seq(sid)) == (None, None) and await _views(sid) == []
        assert (await _put(c, {**device, "device_token": token}, _panel(1, agent))).json() == {"applied": True, "clock_view_seq": 1, "dropped_rows": 0}


async def test_19_a_submitted_clock_out_raises_the_numbering_floor_so_a_report_already_in_flight_cannot_bring_the_lines_back(world):
    async with _client() as c:
        device, agent, phone, _der = await _setup(c, "d4424 mac 4733s")
        sid = device["setup_id"]
        await _put(c, device, _panel(5, agent))
        made = (await _post(c, sid, _press(phone, "out_submit"))).json()["command_id"]
        assert (await _result(c, device, made, "done", "ok")).status_code == 200
        assert (await _views(sid))[0][1]["rows"][0]["first_line"] is None and (await _seq(sid))[0] == 1005
        # the panel report the computer had already sent (number just above what was applied) arrives now: ignored, told where to go on from
        late = await _put(c, device, _panel(6, agent))
        assert (late.status_code, late.json()) == (200, {"applied": False, "clock_view_seq": 1005, "dropped_rows": 0})
        assert (await _views(sid))[0][1]["rows"][0]["first_line"] is None
        # the computer goes on from the number it was told: applied
        assert (await _put(c, device, _report(1006, "out", out={"at": datetime.now(timezone.utc).isoformat(), "came": 0, "warn": "none", "left": ["Writer"]}))).json()["applied"] is True
        # a cancel does the same, and a computer that never reported (no number) is not given one
        await _put(c, device, _panel(1007, agent))
        cid = (await _post(c, sid, _press(phone, "out_cancel", key="kc"))).json()["command_id"]
        assert (await _result(c, device, cid, "done", "ok")).status_code == 200
        assert (await _seq(sid))[0] == 2007
        await _sql(f"UPDATE desktop_setups SET clock_view_seq = NULL WHERE id = '{sid}'")
        cid = (await _post(c, sid, _press(phone, "out_cancel", key="kc2"))).json()["command_id"]
        assert (await _result(c, device, cid, "done", "ok")).status_code == 200
        assert (await _seq(sid))[0] is None


async def test_20_the_other_ways_a_computer_is_cut_off_take_its_view_too(world):
    from app.core.database import async_session_factory
    from app.models.desktop_setup import DesktopSetup
    from app.models.user import User
    from app.routers.auth import _reclaim_unproved_account
    from app.services.desktop_setup import _retire_same_machine

    async with _client() as c:
        device, agent, _phone, _der = await _setup(c, "d4424 mac 4733t")
        sid = device["setup_id"]
        await _put(c, device, _panel(1, agent))
        assert len(await _views(sid)) == 1
        # a new setup on the same machine replaces this line
        await _sql(f"UPDATE desktop_setups SET machine_key = 'mk-4733' WHERE id = '{sid}'")
        async with async_session_factory() as s:
            setup = await s.get(DesktopSetup, uuid.UUID(sid))
            agents = frozenset(uuid.UUID(str(m["member_id"])) for m in (setup.members or []) if m.get("kind") == "agent")
            assert await _retire_same_machine(s, machine_key="mk-4733", others=[setup], now=datetime.now(timezone.utc), new_agents=agents,
                                              before={setup.id: agents}) == 1
            await s.commit()
        assert await _views(sid) == []
        assert (await _sql(fetch=f"SELECT revoked_reason FROM desktop_setups WHERE id = '{sid}'"))[0][0] == "replaced_by_new_setup"
        # an unproved account is reclaimed: the computers it confirmed are cut off
        device2, agent2, _phone2, _der2 = await _setup(c, "d4424 mac 4733t2")
        sid2 = device2["setup_id"]
        await _put(c, device2, _panel(1, agent2))
        await _sql(f"UPDATE users SET email_verified = false WHERE id = '{PLAIN}'", f"UPDATE desktop_setups SET confirmed_by = '{PLAIN}' WHERE id = '{sid2}'")
        assert len(await _views(sid2)) == 1
        async with async_session_factory() as s:
            user = await s.get(User, PLAIN)
            assert await _reclaim_unproved_account(s, user, why="test 4733") is not None
            await s.commit()
        assert (await _sql(fetch=f"SELECT revoked_reason FROM desktop_setups WHERE id = '{sid2}'"))[0][0] == "account_reclaimed"
        assert await _views(sid2) == []


# ── PO 10-20 00:23Z (AC1b): one agent of the computer ─────────────────────────────────────────────────────────────────────────────


async def test_21_a_press_may_name_one_agent_of_that_computer_and_only_one_the_computer_was_set_up_with(world):
    await _plain_member()
    async with _client() as c:
        device, agent, phone, _der = await _setup(c, "d4424 mac 4733u")
        sid = device["setup_id"]
        other_agent = device["agents"][1]["member_id"]
        # the whole computer: exactly {action, signed}; one agent: the agent's id rides in the payload too (the signature covers it — the daemon checks)
        whole = await _post(c, sid, _press(phone, "out_open", key="w"))
        one = await _post(c, sid, _press(phone, "out_open", key="o", agent_member_id=agent))
        assert (whole.status_code, one.status_code) == (201, 201)
        rows = await _commands(sid)
        assert [p for _k, p, _by, _key, _st in rows] == [
            {"action": "out_open", "signed": "eyJ2IjoxfQ.signed-by-the-phone"},
            {"action": "out_open", "signed": "eyJ2IjoxfQ.signed-by-the-phone", "agent_member_id": agent},
        ]
        assert (await _post(c, sid, _press(phone, "in", key="i", agent_member_id=other_agent))).status_code == 201
        # an agent this computer was not set up with — a stranger id, an agent of another computer, a person, another organization's member — is no target; nothing queued
        stranger = str(uuid.uuid4())
        for target in (stranger, str(OWNER_TM)):
            r = await _post(c, sid, _press(phone, "out_open", key=f"x-{target}", agent_member_id=target))
            assert (r.status_code, r.json()["error"]["code"]) == (422, "agent_not_on_device"), target
        device2, agent2, _p2, _d2 = await _setup(c, "d4424 mac 4733u2")
        r = await _post(c, sid, _press(phone, "out_open", key="x-other-computer", agent_member_id=agent2))
        assert (r.status_code, r.json()["error"]["code"]) == (422, "agent_not_on_device")
        assert len(await _commands(sid)) == 3 and len(await _commands(device2["setup_id"])) == 0
        # who may press does not change with the target: a plain member's press for an agent is refused like the whole computer's
        plain_phone, plain_der = await _register(c, PLAIN)
        await _pair(c, device["device_token"], _der, plain_der)
        r = await _post(c, sid, _press(plain_phone, "out_open", key="p", agent_member_id=agent), who=PLAIN)
        assert (r.status_code, r.json()["error"]["code"]) == (403, "not_allowed_to_command")


async def test_22_a_panel_of_one_agent_is_one_scope_with_that_one_row(world):
    async with _client() as c:
        device, agent, phone, _der = await _setup(c, "d4424 mac 4733v")
        other = device["agents"][1]["member_id"]
        sid = device["setup_id"]
        for rows in ([], [_row(agent), _row(other)]):
            r = await _put(c, device, _report(1, "panel", scope="one", opened_from="phone", rows=rows))
            assert r.status_code == 422, rows
        assert (await _put(c, device, _report(1, "panel", scope="one", opened_from="phone", rows=[_row(agent, first_line=LINE)]))).json()["applied"] is True
        view = (await _read(c, sid, phone)).json()["view"]
        assert view["scope"] == "one" and [r["agent_member_id"] for r in view["rows"]] == [agent]
        # the whole computer's panel may hold any number of rows
        assert (await _put(c, device, _report(2, "panel", scope="computer", rows=[_row(agent), _row(other)]))).status_code == 200


# ── PO 10-20 00:26Z (4735): the agents that clocked out one by one — `outs` in every mode, `out.alone` ──────────────────────────────────


async def test_23_agents_clocked_out_one_by_one_are_kept_in_every_mode_even_when_no_flow_is_open(world):
    async with _client() as c:
        device, agent, phone, _der = await _setup(c, "d4424 mac 4733w")
        sid = device["setup_id"]
        other = device["agents"][1]["member_id"]
        gone = str(uuid.uuid4())
        outs = [{"agent_member_id": agent, "at": _iso(10)}, {"agent_member_id": gone, "at": _iso(11)}]
        # mode none with nothing deletes; mode none WITH one-by-one agents keeps a row (the phone draws their [출근] with no flow open) — a stranger agent is dropped
        assert (await _put(c, device, _report(1, "none"))).json()["dropped_rows"] == 0 and await _views(sid) == []
        r = await _put(c, device, _report(2, "none", outs=outs))
        assert (r.status_code, r.json()) == (200, {"applied": True, "clock_view_seq": 2, "dropped_rows": 1})
        mode, view, term = (await _views(sid))[0]
        assert mode == "none" and view["outs"] == [{"agent_member_id": agent, "at": view["outs"][0]["at"]}] and term == timedelta(hours=36)  # the night's term
        # the phone reads them with the board's names; an agent that is gone from the board is not listed
        name = (await _sql(fetch=f"SELECT name FROM members WHERE id = '{agent}'"))[0][0]
        read = (await _read(c, sid, phone)).json()["view"]
        assert read["mode"] == "none" and read["outs"] == [{"agent_member_id": agent, "at": read["outs"][0]["at"], "name": name}] and read["rows"] == []
        # in every other mode too, beside the flow's own fields
        assert (await _put(c, device, _panel(3, agent, rows=[_row(other)], outs=[{"agent_member_id": agent, "at": _iso(10)}]))).json()["applied"] is True
        assert (await _views(sid))[0][1]["outs"][0]["agent_member_id"] == agent and (await _views(sid))[0][2] == timedelta(minutes=30)
        ok_out = {"at": _iso(20), "came": 2, "warn": "none", "still_working": [], "left": ["Writer"], "alone": 1}
        assert (await _put(c, device, _report(4, "out", out=ok_out, outs=[{"agent_member_id": agent, "at": _iso(10)}]))).json()["applied"] is True
        assert (await _read(c, sid, phone)).json()["view"]["out"]["alone"] == 1
        # the agents' clock-in empties it: an empty none deletes the row
        assert (await _put(c, device, _report(5, "none"))).json()["applied"] is True and await _views(sid) == []
        # an agent that is deleted from the board is not listed
        await _put(c, device, _report(6, "none", outs=[{"agent_member_id": agent, "at": _iso(10)}]))
        await _sql(f"UPDATE members SET deleted_at = now() WHERE id = '{agent}'")
        assert (await _read(c, sid, phone)).json()["view"]["outs"] == []


# ── codex read of the second head ─────────────────────────────────────────────────────────────────────────────────────────────────


async def test_24_a_press_for_one_agent_takes_that_agents_line_only(world):
    async with _client() as c:
        device, agent, phone, _der = await _setup(c, "d4424 mac 4733x")
        sid = device["setup_id"]
        other = device["agents"][1]["member_id"]
        await _put(c, device, _panel(1, agent, rows=[_row(agent, first_line=LINE), _row(other, first_line="다른 에이전트의 초안")]))
        made = (await _post(c, sid, _press(phone, "out_submit", agent_member_id=agent))).json()["command_id"]
        assert (await _result(c, device, made, "done", "ok")).status_code == 200
        lines = {r["agent_member_id"]: r["first_line"] for r in (await _views(sid))[0][1]["rows"]}
        assert lines == {agent: None, other: "다른 에이전트의 초안"}
        # the whole computer's submit takes every line
        made = (await _post(c, sid, _press(phone, "out_cancel", key="whole"))).json()["command_id"]
        assert (await _result(c, device, made, "done", "ok")).status_code == 200
        assert {r["first_line"] for r in (await _views(sid))[0][1]["rows"]} == {None}


async def test_25_an_account_reclaim_waits_for_the_report_in_flight_and_then_leaves_no_view(world):
    import asyncio

    from app.core.database import async_session_factory
    from app.models.desktop_setup import DesktopSetup
    from app.models.user import User
    from app.routers.auth import _reclaim_unproved_account
    from app.services import desktop_clock

    async with _client() as c:
        device, agent, _phone, _der = await _setup(c, "d4424 mac 4733y")
    sid = uuid.UUID(device["setup_id"])
    await _sql(f"UPDATE users SET email_verified = false WHERE id = '{PLAIN}'", f"UPDATE desktop_setups SET confirmed_by = '{PLAIN}' WHERE id = '{sid}'")
    report = desktop_clock.ClockViewReport.model_validate(_panel(1, agent))

    async def reclaim():
        async with async_session_factory() as s:
            user = await s.get(User, PLAIN)
            await _reclaim_unproved_account(s, user, why="test 4733 race")
            await s.commit()

    async with async_session_factory() as inflight:
        setup = await inflight.get(DesktopSetup, sid)
        await desktop_clock.apply_clock_view(inflight, setup, report)  # holds the computer's row lock, not committed
        task = asyncio.create_task(reclaim())
        await asyncio.sleep(1.0)
        assert not task.done(), "the reclaim waits for the report in flight (the computer's row is locked by it)"
        await inflight.commit()
    await asyncio.wait_for(task, 20)
    assert await _views(str(sid)) == []  # the report's view was written first and taken off after
    assert (await _sql(fetch=f"SELECT revoked_reason FROM desktop_setups WHERE id = '{sid}'"))[0][0] == "account_reclaimed"


# ── PO 10-20 05:3xZ: `forget(lock=False)` is for the paths that already hold the computers' rows in the service's one lock order — and only those ────────────────────────


_LOCKED_FORGET_SITES = {
    # (file, enclosing function): both are inside desktop_setup's exchange / disconnect, which take the setup rows through `_lock_in_order` before they get here
    ("app/services/desktop_setup.py", "_retire_same_machine"),
    ("app/services/desktop_setup.py", "revoke_setup"),
}


def _forget_pointers_that_are_not_calls(root) -> set[tuple[str, int]]:
    """Every place under backend/app that POINTS at `forget` without calling it — `alias = desktop_clock.forget`, `from app.services.desktop_clock import forget`, a callback
    list `[desktop_clock.forget]`. A call through such an alias would carry `lock=False` where the call-site scan above cannot see it, so the only pointers allowed are none:
    a caller calls `desktop_clock.forget(...)` by its name (the definition itself is a `def`, not a pointer)."""
    import ast
    from pathlib import Path

    found: set[tuple[str, int]] = set()
    for path in sorted(Path(root).rglob("*.py")):
        tree = ast.parse(path.read_text(encoding="utf-8"))
        called = {id(n.func) for n in ast.walk(tree) if isinstance(n, ast.Call)}
        rel = str(path.relative_to(Path(root).parent))
        for n in ast.walk(tree):
            if isinstance(n, ast.Attribute) and n.attr == "forget" and isinstance(n.value, ast.Name) and n.value.id == "desktop_clock" and id(n) not in called:
                found.add((rel, n.lineno))
            elif isinstance(n, ast.ImportFrom) and any(a.name == "forget" for a in n.names) and (n.module or "").endswith("desktop_clock"):
                found.add((rel, n.lineno))
            elif isinstance(n, ast.Name) and n.id == "forget" and isinstance(n.ctx, ast.Load) and id(n) not in called and rel != "app/services/desktop_clock.py":
                found.add((rel, n.lineno))
    return found


def _forget_without_lock_sites(root) -> set[tuple[str, str]]:
    """Every call of `forget(..., lock=False)` under backend/app (the file relative to backend/, the function it sits in)."""
    import ast
    from pathlib import Path

    found: set[tuple[str, str]] = set()
    for path in sorted(Path(root).rglob("*.py")):
        tree = ast.parse(path.read_text(encoding="utf-8"))
        for fn in (n for n in ast.walk(tree) if isinstance(n, (ast.FunctionDef, ast.AsyncFunctionDef))):
            for call in (n for n in ast.walk(fn) if isinstance(n, ast.Call)):
                name = call.func.attr if isinstance(call.func, ast.Attribute) else getattr(call.func, "id", "")
                if name == "forget" and any(k.arg == "lock" and not (isinstance(k.value, ast.Constant) and k.value.value is True) for k in call.keywords):
                    found.add((str(path.relative_to(Path(root).parent)), fn.name))
    return found


def test_26_forget_without_its_own_lock_is_called_only_where_the_rows_are_already_held_in_order(tmp_path):
    from pathlib import Path

    app = Path(__file__).resolve().parent.parent / "app"
    assert _forget_without_lock_sites(app) == _LOCKED_FORGET_SITES, (
        "a call of desktop_clock.forget(lock=False) outside the two paths that hold the setup rows through _lock_in_order would delete a view without waiting for a "
        "report in flight — take the rows first (the default) or add the path here with the reason it already holds them"
    )
    assert _forget_pointers_that_are_not_calls(app) == set(), (
        "desktop_clock.forget is pointed at without being called (an alias, an import of the bare name, a callback): a call through it would carry lock=False unseen by this scan — "
        "call it as desktop_clock.forget(...)"
    )
    # the scan sees a new call, a dynamic value, and does not mistake a locked one for it
    pkg = tmp_path / "app"
    pkg.mkdir()
    (pkg / "x.py").write_text(
        "async def a(db, ids):\n    await desktop_clock.forget(db, ids, lock=False)\n"
        "async def b(db, ids, flag):\n    await desktop_clock.forget(db, ids, lock=flag)\n"
        "async def c(db, ids):\n    await desktop_clock.forget(db, ids, lock=True)\n"
        "async def d(db, ids):\n    await desktop_clock.forget(db, ids)\n"
    )
    assert _forget_without_lock_sites(pkg) == {("app/x.py", "a"), ("app/x.py", "b")}
    # …and the pointer scan sees an alias, a bare import and a callback list, and ignores the ordinary calls
    (pkg / "y.py").write_text(
        "from app.services.desktop_clock import forget\n"
        "async def e(db, ids):\n    alias = desktop_clock.forget\n    await alias(db, ids, lock=False)\n"
        "def f():\n    return [desktop_clock.forget]\n"
        "async def g(db, ids):\n    await desktop_clock.forget(db, ids)\n"
    )
    assert _forget_pointers_that_are_not_calls(pkg) == {("app/y.py", 1), ("app/y.py", 3), ("app/y.py", 6)}


# ── Kadir lens (PO 05:5xZ): a control character in free text must be a 422, never a database error whose log line carries the draft ─────────────────────────────────


async def test_27_a_control_character_in_any_free_text_is_refused_and_nothing_of_it_is_logged(world, caplog):
    from app.main import app  # noqa: F401 — importing the app configures logging and clears the root handlers: attach caplog's again

    logging.getLogger().addHandler(caplog.handler)
    caplog.set_level(logging.DEBUG)
    secret = "초안-본문-비밀"
    async with _client() as c:
        device, agent, _phone, _der = await _setup(c, "d4424 mac 4733z")
        sid = device["setup_id"]
        ok_out = {"at": _iso(), "came": 0, "warn": "none", "still_working": [], "left": ["Writer"]}
        for bad in ("\x00", "\x01", "\x08", "\x1b", "\x7f", "\u0085", " ", " "):
            bodies = [
                _panel(1, agent, rows=[_row(agent, first_line=f"{secret}{bad}x")]),                                      # the draft's first line
                _report(1, "out", out={**ok_out, "left": [f"{secret}{bad}"]}),                                           # names inside out / in
                _report(1, "out", out={**ok_out, "still_working": [f"{secret}{bad}"]}),
                _report(1, "in", **{"in": {"unread": [f"{secret}{bad}"]}}),
                _report(1, "in", **{"in": {"failed": [{"name": f"{secret}{bad}", "code": "no_folder"}]}}),
            ]
            for body in bodies:
                r = await _put(c, device, body)
                assert r.status_code == 422, (repr(bad), str(body)[:120], r.status_code)
        assert await _views(sid) == [] and (await _seq(sid))[0] is None
        # an ordinary tab and Korean text stay fine
        assert (await _put(c, device, _panel(1, agent, rows=[_row(agent, first_line=f"{secret}\t다음 줄 없음")]))).status_code == 200
    leaked = [(r.name, r.levelname) for r in caplog.records if secret in r.getMessage() or secret in str(r.args)]
    assert leaked == [], leaked


# ── Kadir pin (PR 5172): forget() waits for the lock — fixed by behaviour, not by reading ──────────────────────────────────────────────────────────────────────────────────


async def _hold_report_open(sid, agent):
    """A clock-view report in flight: it holds its computer's row (the lock `apply_clock_view` takes) and has written its view, but has not committed."""
    from app.core.database import async_session_factory
    from app.models.desktop_setup import DesktopSetup
    from app.services import desktop_clock

    s = async_session_factory()
    session = await s.__aenter__()
    setup = await session.get(DesktopSetup, uuid.UUID(sid))
    await desktop_clock.apply_clock_view(session, setup, desktop_clock.ClockViewReport.model_validate(_panel(1, agent)))
    return s, session


async def test_28_forget_waits_for_the_report_in_flight_then_deletes_what_it_wrote_and_two_forgets_in_opposite_order_do_not_deadlock(world):
    import asyncio

    from app.core.database import async_session_factory
    from app.services import desktop_clock

    async with _client() as c:
        d1, a1, _p1, _x1 = await _setup(c, "d4424 mac 4733-28a")
        d2, a2, _p2, _x2 = await _setup(c, "d4424 mac 4733-28b")
    first, second = sorted([(d1["setup_id"], a1), (d2["setup_id"], a2)])
    (sid_a, agent_a), (sid_b, _agent_b) = first, second  # sid_a sorts before sid_b: the order every lock taker uses
    ctx, inflight = await _hold_report_open(sid_a, agent_a)

    async def forget(ids):
        async with async_session_factory() as s:
            await desktop_clock.forget(s, [uuid.UUID(i) for i in ids])
            await s.commit()

    tasks = []
    try:
        # two cut-offs that name the same two computers in opposite order — both must queue behind the report and then finish, neither may deadlock the other
        tasks = [asyncio.create_task(forget([sid_a, sid_b])), asyncio.create_task(forget([sid_b, sid_a]))]
        await asyncio.sleep(1.0)
        assert not any(t.done() for t in tasks), "forget waits for the report in flight (its computer's row is locked by it)"
        await inflight.commit()
    finally:
        await ctx.__aexit__(None, None, None)  # releases the lock when an assertion above failed, so a red run ends instead of hanging the cleanup
    await asyncio.wait_for(asyncio.gather(*tasks), 20)
    assert await _views(sid_a) == [], "what the report wrote is deleted after it, not before"


async def test_29_the_organizations_remote_control_off_waits_for_the_report_in_flight_and_leaves_no_view(world):
    import asyncio

    async with _client() as c:
        device, agent, _phone, _der = await _setup(c, "d4424 mac 4733-29")
        sid = device["setup_id"]
        ctx, inflight = await _hold_report_open(sid, agent)
        off = asyncio.create_task(c.put(f"/api/v2/organizations/{ORG}/remote-control", json={"enabled": False}, headers=_person(OWNER)))
        try:
            await asyncio.sleep(1.0)
            assert not off.done(), "turning remote control off waits for the report in flight"
            await inflight.commit()
        finally:
            await ctx.__aexit__(None, None, None)  # releases the lock when the assertion failed, so a red run ends instead of hanging the cleanup
        r = await asyncio.wait_for(off, 20)
        assert r.status_code == 200, r.text
        assert await _views(sid) == []


async def test_30_forget_takes_the_computers_rows_in_id_order_in_one_statement(world):
    """The one lock order of the service (rows by id, one statement) — watched at the SQL, like the 4565 lock-order test: an unordered lock statement lets two cut-offs
    that name the same computers in opposite order deadlock; no timing can show that reliably, the statement can."""
    from sqlalchemy import event

    from app.core.database import async_session_factory, engine
    from app.services import desktop_clock

    async with _client() as c:
        d1, _a1, _p1, _x1 = await _setup(c, "d4424 mac 4733-30a")
        d2, _a2, _p2, _x2 = await _setup(c, "d4424 mac 4733-30b")
    ids = [uuid.UUID(d2["setup_id"]), uuid.UUID(d1["setup_id"])]
    seen: list[str] = []

    def watch(conn, cursor, statement, parameters, context, executemany):
        if "FOR UPDATE" in statement:
            seen.append(statement)

    event.listen(engine.sync_engine, "before_cursor_execute", watch)
    try:
        async with async_session_factory() as s:
            await desktop_clock.forget(s, ids)
            await s.commit()
            await desktop_clock.forget(s, ids, lock=False)
            await s.commit()
    finally:
        event.remove(engine.sync_engine, "before_cursor_execute", watch)
    assert len(seen) == 1, seen  # the locking forget: one statement; lock=False: none
    assert "FROM desktop_setups" in seen[0] and "ORDER BY desktop_setups.id" in seen[0] and "FOR UPDATE" in seen[0], seen[0]


# ── S5 · P2 (story 4733): a phone edits ONE agent's clock-out draft ─────────────────────────────────────────────────────────────────────────────────────────────────────
SIGNED = "eyJ2IjoxfQ.signed-by-the-phone"
TYPED = "손으로 친 다음 할 일 — 비밀스러운 문장"  # what a person typed on the phone (the kind of text that must not outlive its command or reach a log)


def _edit(phone, agent, *, key=None, base_rev=0, **fields):
    """A phone's edit press: only the fields the person touched ride in `edit`."""
    return _press(phone, "out_edit", key=key, agent_member_id=agent, edit={"base_rev": base_rev, **fields})


async def test_31_an_edit_press_stores_the_agent_the_revision_and_only_the_fields_the_person_touched(world):
    async with _client() as c:
        device, agent, phone, _der = await _setup(c, "d4424 mac 4733s31")
        sid = device["setup_id"]
        r = await _post(c, sid, _edit(phone, agent, key="e1", base_rev=3, plan="내일 이어서 함"))
        assert (r.status_code, r.json()["state"]) == (201, "queued"), r.text
        r = await _post(c, sid, _edit(phone, agent, key="e2", base_rev=3, done="한 줄\n둘째 줄", plan="", blockers="막힌 곳 없음"))
        assert r.status_code == 201, r.text
        r = await _post(c, sid, _edit(phone, agent, key="e3", base_rev=0, done="x" * 2000))  # the Mac's own limit is the edge
        assert r.status_code == 201, r.text
        rows = await _commands(sid)
        assert [p for _k, p, _by, _key, _st in rows] == [
            {"action": "out_edit", "signed": SIGNED, "agent_member_id": agent, "edit": {"base_rev": 3, "plan": "내일 이어서 함"}},  # the untouched fields are absent, never null
            {"action": "out_edit", "signed": SIGNED, "agent_member_id": agent, "edit": {"base_rev": 3, "done": "한 줄\n둘째 줄", "plan": "", "blockers": "막힌 곳 없음"}},
            {"action": "out_edit", "signed": SIGNED, "agent_member_id": agent, "edit": {"base_rev": 0, "done": "x" * 2000}},
        ]
        # every other press keeps exactly its old bytes: no `edit` key rides with it
        other = await _post(c, sid, _press(phone, "out_open", key="o1", agent_member_id=agent))
        assert other.status_code == 201
        assert (await _commands(sid))[-1][1] == {"action": "out_open", "signed": SIGNED, "agent_member_id": agent}


async def test_32_an_edit_is_closed_one_agent_one_revision_one_to_three_plain_fields_and_nothing_else(world):
    async with _client() as c:
        device, agent, phone, _der = await _setup(c, "d4424 mac 4733s32")
        sid = device["setup_id"]
        ok = {"base_rev": 0, "plan": "x"}
        bad = [
            _press(phone, "out_edit"), _press(phone, "out_edit", agent_member_id=agent),                      # no edit
            _press(phone, "out_edit", edit=ok),                                                               # no agent (an edit is always one agent's)
            _press(phone, "out_open", agent_member_id=agent, edit=ok), _press(phone, "in", agent_member_id=agent, edit=ok),  # an edit rides with out_edit only
            _press(phone, "out_submit", edit=ok),
            _edit(phone, agent), _edit(phone, agent, plan=None), _edit(phone, agent, done=None, plan=None, blockers=None),  # touches nothing
            _press(phone, "out_edit", agent_member_id=agent, edit={**ok, "session_key": "s-1"}),              # no field but the three
            _press(phone, "out_edit", agent_member_id=agent, edit={**ok, "no_blockers": True}),
            _press(phone, "out_edit", agent_member_id=agent, edit={"plan": "x"}),                             # no revision
            _press(phone, "out_edit", agent_member_id=agent, edit="plan"), _press(phone, "out_edit", agent_member_id=agent, edit=[ok]),
            _edit(phone, agent, plan="x" * 2001),
            _edit(phone, agent, plan=5), _edit(phone, agent, plan=["a"]), _edit(phone, agent, plan=True),
        ]
        for rev in (-1, 1.5, True, 2**31, "1", None):
            bad.append(_edit(phone, agent, base_rev=rev, plan="x"))
        for ch in ("\x00", "\x01", "\x08", "\t", "\x0b", "\x0c", "\r", "\x1b", "\x7f", "\u0085", "\u009f", " ", " "):
            bad += [_edit(phone, agent, done=f"a{ch}b"), _edit(phone, agent, plan=f"a{ch}"), _edit(phone, agent, blockers=f"{ch}a")]
        for body in bad:
            r = await _post(c, sid, body)
            assert r.status_code == 422, str(body)[-170:]
        assert await _commands(sid) == []
        # …and the ordinary text people type is fine: Korean, a line break, an emoji
        for i, t in enumerate(("한글", "줄\n바꿈", "이모지 🙂")):
            assert (await _post(c, sid, _edit(phone, agent, key=f"g{i}", plan=t))).status_code == 201, t


async def test_33_an_edit_is_for_an_agent_of_that_computer_and_a_person_who_can_open_it(world):
    plain_tm = await _plain_member()
    async with _client() as c:
        device, agent, phone, owner_der = await _setup(c, "d4424 mac 4733s33")
        sid = device["setup_id"]
        # an agent this computer was not set up with is no target (nothing queued)
        device2, agent2, _p2, _d2 = await _setup(c, "d4424 mac 4733s33b")
        for target in (str(uuid.uuid4()), str(OWNER_TM), agent2):
            r = await _post(c, sid, _edit(phone, target, key=f"t-{target}", plan="x"))
            assert (r.status_code, r.json()["error"]["code"]) == (422, "agent_not_on_device"), target
        assert await _commands(sid) == []
        # the device's confirmer may press the computer, but with NO access to the agent may not write into its draft (the phone shows him no line either)
        plain_phone, plain_der = await _register(c, PLAIN)
        await _pair(c, device["device_token"], owner_der, plain_der)
        await _sql(f"UPDATE desktop_setups SET confirmed_by = '{PLAIN}' WHERE id = '{sid}'")
        assert (await _post(c, sid, _press(plain_phone, "out_open", key="p-open"), who=PLAIN)).status_code == 201  # the whole computer: unchanged
        r = await _post(c, sid, _edit(plain_phone, agent, key="p-edit", plan="x"), who=PLAIN)
        assert (r.status_code, r.json()["error"]["code"]) == (403, "not_allowed_to_command")
        assert [k for _k, _p, _by, k, _st in await _commands(sid)] == [f"b5:{plain_tm}:p-open"]
        # …with access to the agent's project: the edit is queued
        await _sql(f"INSERT INTO project_access (id,project_id,member_id,permission) VALUES (gen_random_uuid(),'{PROJ}','{plain_tm}','granted')",
                   f"INSERT INTO agent_project_profiles (id,member_id,project_id) VALUES (gen_random_uuid(),'{agent}','{PROJ}') ON CONFLICT DO NOTHING")
        r = await _post(c, sid, _edit(plain_phone, agent, key="p-edit2", plan="x"), who=PLAIN)
        assert r.status_code == 201, r.text


async def test_34_the_daemons_two_edit_words_are_taken_and_a_third_is_not(world):
    async with _client() as c:
        device, agent, phone, _der = await _setup(c, "d4424 mac 4733s34")
        sid = device["setup_id"]
        for i, code in enumerate(("ok", "stale", "not_editable", "not_open", "unknown_agent")):
            cid = (await _post(c, sid, _edit(phone, agent, key=f"w{i}", plan="x"))).json()["command_id"]
            assert (await _result(c, device, cid, "done", code)).status_code == 200, code
            read = await c.get(f"/api/v2/desktop/setups/{sid}/clock/commands/{cid}", headers=_person(OWNER))
            assert (read.json()["action"], read.json()["state"], read.json()["result_code"]) == ("out_edit", "done", code)
        cid = (await _post(c, sid, _edit(phone, agent, key="w-bad", plan="x"))).json()["command_id"]
        for code in (None, "edited", "stale_", "row_busy", "bad_edit"):
            r = await _result(c, device, cid, "done", code)
            assert (r.status_code, r.json()["error"]["code"]) == (422, "invalid_result_code"), code
        assert (await _result(c, device, cid, "done", "Stale")).status_code == 422  # not even the ordinary word shape


async def test_35_the_typed_text_leaves_the_stored_command_when_it_ends_and_never_outlives_its_minutes(world):
    async with _client() as c:
        device, agent, phone, _der = await _setup(c, "d4424 mac 4733s35")
        sid = device["setup_id"]
        gone = {"action": "out_edit", "signed": SIGNED, "agent_member_id": agent, "edit": {"base_rev": 4}}  # only the revision stays

        async def stored(key):
            return {k: p for _k, p, _by, k, _st in await _commands(sid)}[f"b5:{OWNER_TM}:{key}"]

        full = {**gone, "edit": {"base_rev": 4, "plan": TYPED, "done": TYPED}}
        # while it is open (queued · delivered · acked — the daemon is working on it) the text is there
        cid = (await _post(c, sid, _edit(phone, agent, key="a", base_rev=4, plan=TYPED, done=TYPED))).json()["command_id"]
        assert await stored("a") == full
        assert (await _result(c, device, cid, "acked")).status_code == 200
        assert await stored("a") == full
        # it ends done → gone; failed → gone; rejected → gone
        assert (await _result(c, device, cid, "done", "ok")).status_code == 200
        assert await stored("a") == gone
        for key, state, code in (("f", "failed", "signature_invalid"), ("r", "rejected", "schema_rejected")):
            cid = (await _post(c, sid, _edit(phone, agent, key=key, base_rev=4, plan=TYPED, done=TYPED))).json()["command_id"]
            assert await stored(key) == full
            assert (await _result(c, device, cid, state, code)).status_code == 200
            assert await stored(key) == gone, key
        # another command ending does not touch a still-open edit of the same computer
        open_cid = (await _post(c, sid, _edit(phone, agent, key="open", base_rev=4, plan=TYPED, done=TYPED))).json()["command_id"]
        other = (await _post(c, sid, _press(phone, "out_open", key="o"))).json()["command_id"]
        assert (await _result(c, device, other, "done", "ok")).status_code == 200
        assert await stored("open") == full
        # an edit nobody answered: its minutes are up (10) → the next press of that computer takes the text out (the command itself stays as it was)
        await _sql(f"UPDATE desktop_commands SET created_at = now() - interval '11 minutes' WHERE id = '{open_cid}'")
        assert (await _post(c, sid, _press(phone, "out_cancel", key="c"))).status_code == 201
        assert await stored("open") == gone
        assert dict((str(r[0]), r[1]) for r in await _sql(fetch=f"SELECT id, state FROM desktop_commands WHERE id = '{open_cid}'"))[open_cid] in ("queued", "delivered")
        # an open edit the organization's remote control switch cuts off ends rejected — and takes its text with it
        cid3 = (await _post(c, sid, _edit(phone, agent, key="rc", base_rev=4, plan=TYPED))).json()["command_id"]
        assert (await c.put(f"/api/v2/organizations/{ORG}/remote-control", json={"enabled": False}, headers=_person(OWNER))).status_code == 200
        assert await stored("rc") == gone
        assert (await _sql(fetch=f"SELECT state FROM desktop_commands WHERE id = '{cid3}'"))[0][0] == "rejected"
        # no other command's payload was changed by any of this
        assert (await stored("o")) == {"action": "out_open", "signed": SIGNED}


async def test_36_a_row_carries_its_revision_in_the_report_and_the_phones_read(world):
    async with _client() as c:
        device, agent, phone, _der = await _setup(c, "d4424 mac 4733s36")
        sid = device["setup_id"]
        assert (await _put(c, device, _panel(1, agent, rows=[_row(agent, first_line=LINE, rev=7)]))).status_code == 200
        assert (await _read(c, sid, phone)).json()["view"]["rows"][0]["rev"] == 7
        # an older computer sends none → 0 (the phone then edits with base_rev 0 and the daemon, which has no revision either, refuses nothing it does not know)
        assert (await _put(c, device, _panel(2, agent))).status_code == 200
        assert (await _read(c, sid, phone)).json()["view"]["rows"][0]["rev"] == 0
        for rev in (-1, 1.5, True, 2**31, "3", None):
            r = await _put(c, device, _panel(3, agent, rows=[_row(agent, first_line=LINE, rev=rev)]))
            assert r.status_code == 422, rev
        assert (await _read(c, sid, phone)).json()["view"]["rows"][0]["rev"] == 0  # nothing of the refused ones was applied
        # the mark of a person's hand: a closed boolean, said of a draft row only (a saved or ended row carries no draft, so no mark and no line)
        assert (await _put(c, device, _panel(4, agent, rows=[_row(agent, first_line=LINE, rev=2, edited=True)]))).status_code == 200
        assert (await _read(c, sid, phone)).json()["view"]["rows"][0]["edited"] is True
        for edited in ("yes", 1, None):
            assert (await _put(c, device, _panel(5, agent, rows=[_row(agent, first_line=LINE, edited=edited)]))).status_code == 422, edited
        assert (await _put(c, device, _panel(6, agent, rows=[_row(agent, "saved", edited=True)]))).status_code == 422  # not a draft: no mark


async def test_37_no_log_line_carries_what_a_person_typed_on_any_edit_road(world, caplog):
    from app.main import app  # noqa: F401 — importing the app configures logging and clears the root handlers (caplog's included): attach it again

    logging.getLogger().addHandler(caplog.handler)
    caplog.set_level(logging.DEBUG)
    async with _client() as c:
        device, agent, phone, _der = await _setup(c, "d4424 mac 4733s37")
        sid = device["setup_id"]
        await _put(c, device, _panel(1, agent, rows=[_row(agent, first_line=LINE, rev=1)]))
        made = (await _post(c, sid, _edit(phone, agent, key="l1", base_rev=1, plan=TYPED, done=TYPED, blockers=TYPED))).json()["command_id"]
        await _result(c, device, made, "acked")
        await _result(c, device, made, "done", "ok")
        refused = await _post(c, sid, _edit(phone, agent, key="l2", base_rev=1, plan=f"{TYPED}\x00"))  # a refused one is not logged either
        assert refused.status_code == 422
        too_long = await _post(c, sid, _edit(phone, agent, key="l3", base_rev=1, plan=TYPED * 400))
        assert too_long.status_code == 422
        await _read(c, sid, phone)
    text = "\n".join(f"{r.getMessage()} {r.args}" for r in caplog.records)
    assert len(caplog.records) > 5, "the capture really sees the app's log lines (the requests are logged)"
    assert TYPED not in text and "비밀스러운" not in text and SIGNED not in text


async def test_39_a_refused_press_on_the_clock_road_is_answered_without_the_words_that_were_typed(world):
    """FastAPI's default 422 echoes each error's `input` — for an error in the edit that is the person's own text, and for an error elsewhere in the body (a missing action, a bad key) it is the WHOLE body,
    edit included. On the clock road no error carries it; any other road's refusal is unchanged."""
    async with _client() as c:
        device, agent, phone, _der = await _setup(c, "d4424 mac 4733s39")
        sid = device["setup_id"]
        typed = {"base_rev": 1, "plan": TYPED}
        bodies = [
            _edit(phone, agent, key="e1", plan=TYPED * 400), _edit(phone, agent, key="e2", done=f"{TYPED}\x00"), _edit(phone, agent, key="e3", blockers=5),   # an error in the edit
            {k: v for k, v in _press(phone, "out_edit", agent_member_id=agent, edit=typed).items() if k != "action"},                                          # …a missing action
            _press(phone, "out_open", agent_member_id=agent, edit=typed),                                                                                      # …an edit on another action
            _press(phone, "out_edit", agent_member_id=agent, edit=typed, phone_key_id=12),                                                                     # …a bad key beside a good edit
        ]
        for body in bodies:
            r = await _post(c, sid, body)
            assert r.status_code == 422, str(body)[-120:]
            assert "비밀스러운" not in r.text and TYPED not in r.text, r.text[:300]
            assert r.json()["detail"], "the refusal still says which field and why"
        # another road keeps the default answer, `input` and all (no change of shape for anything else)
        other = await _put(c, device, {"seq": "not a number"})
        assert other.status_code == 422 and "input" in other.text


def test_38_each_of_the_two_schemas_refuses_an_edit_that_does_not_fit_its_action_on_its_own():
    """The press request (what the web posts) and the stored payload (what the daemon is handed) both close the edit's shape — either would catch what the other missed,
    so each is pinned by itself (the HTTP road alone cannot tell which of the two refused)."""
    from pydantic import ValidationError

    from app.services.desktop_clock import ClockRequest
    from app.services.desktop_relay import ClockPayload

    agent = str(uuid.uuid4())
    edit = {"base_rev": 1, "plan": "x"}
    req = {"idempotency_key": "k", "signed": "s", "phone_key_id": str(uuid.uuid4())}
    pay = {"signed": "s"}
    for schema, base in ((ClockRequest, req), (ClockPayload, pay)):
        assert schema.model_validate({**base, "action": "out_edit", "agent_member_id": agent, "edit": edit}).edit is not None
        for bad in (
            {"action": "out_edit", "agent_member_id": agent},                       # an edit without its fields
            {"action": "out_edit", "edit": edit},                                    # …without its agent
            {"action": "out_open", "agent_member_id": agent, "edit": edit},          # fields on another action
            {"action": "in", "edit": edit}, {"action": "out_submit", "edit": edit}, {"action": "out_cancel", "agent_member_id": agent, "edit": edit},
            {"action": "out_edit", "agent_member_id": agent, "edit": {"base_rev": 1}},  # touching nothing
        ):
            with pytest.raises(ValidationError):
                schema.model_validate({**base, **bad})
