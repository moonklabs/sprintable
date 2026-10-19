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


async def test_02_the_press_forbids_everything_but_its_four_fields_and_four_actions(world):
    async with _client() as c:
        device, agent, phone, _der = await _setup(c, "d4424 mac 4733b")
        sid = device["setup_id"]
        bad = [
            {**_press(phone), "agent_member_id": agent}, {**_press(phone), "text": "rm -rf ~"}, {**_press(phone), "session_key": "s-1"},
            {**_press(phone), "path": "/Users/x"}, _press(phone, "out_edit"), _press(phone, "out_open", signed=""),
            {k: v for k, v in _press(phone).items() if k != "phone_key_id"}, {k: v for k, v in _press(phone).items() if k != "signed"},
            _press(phone, key=""), _press(phone, key="k" * 101), _press(phone, signed="s" * 16385),
        ]
        for body in bad:
            r = await _post(c, sid, body)
            assert r.status_code == 422, body
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


async def test_06_the_daemons_finished_clock_command_ends_in_one_of_seven_words_and_the_presser_reads_it(world):
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
        # each of the seven is accepted on its own command
        for i, code in enumerate(("already", "nothing_running", "not_open", "not_ready", "needs_hands", "not_clocked_out")):
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
        assert view["rows"] == [{"agent_member_id": agent, "state": "ready", "missing": [], "first_line": LINE, "idle": False, "name": name}]
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
    assert set(re.findall(r"'([a-z_]+)'", defs["ck_desktop_clock_views_mode"])) == set(CLOCK_VIEW_MODES) and "none" not in CLOCK_VIEW_MODES
    # a row of mode none cannot be stored even by hand; a clock command row is a legal row
    async with _client() as c:
        device, _agent, _phone, _der = await _setup(c, "d4424 mac 4733o")
        sid = device["setup_id"]
        with pytest.raises(Exception):  # noqa: B017 — the CHECK
            await _sql(f"INSERT INTO desktop_clock_views (setup_id, mode, view, expires_at) VALUES ('{sid}','none','{{}}', now())")
        await _sql(f"INSERT INTO desktop_clock_views (setup_id, mode, view, expires_at) VALUES ('{sid}','out','{{}}', now())")
        # the view goes with its computer (ON DELETE CASCADE)
        await _sql(f"DELETE FROM desktop_setups WHERE id = '{sid}'")
        assert await _views(sid) == []
