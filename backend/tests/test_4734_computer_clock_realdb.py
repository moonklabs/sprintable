"""story #4734 (B) — the phone's «모두 종료» as ONE press of the COMPUTER: the request's `computer` mark, the scope the server collects (only the setups the person may press one
setup at a time), «N개 중 K개», and what a computer-wide flow's report and the phone's read keep. The authority of this press is never wider than the sum of one-setup presses: the
server collects (the sole place of that judgement), the daemon filters again to its own profiles, the signature covers the mark (the daemon's side lives in the mobile repo).
Each test goes red without the line it names (mutants in the PR body).
"""
from __future__ import annotations

import uuid

import pytest

from tests.test_4424_desktop_setup_realdb import (  # noqa: F401 — fixtures (autouse ones apply here too)
    ORG,
    ORG2,
    OWNER,
    _addresses,
    _client,
    _person,
    _dispose_global_engine_after_test,
    _sql,
    anyio_backend,
    world,
)
from tests.test_4529_desktop_relay_realdb import _device, _tok
from tests.test_4533_agent_permissions_realdb import _pair, _register
from tests.test_4534_desktop_commands_realdb import _commands, _remote_control_on, _state  # noqa: F401
from tests.test_4733_clock_realdb import _panel, _post, _press, _put, _read, _report, _row, _views

pytestmark = pytest.mark.anyio


@pytest.fixture(autouse=True)
async def _clean_onboarding_events(world):
    """the shared cleanup removes the onboarding events of the `d4424…` setups only; the computers these tests make are named `d4734…`"""
    yield
    await _sql("DELETE FROM onboarding_events WHERE session_id IN (SELECT id FROM desktop_setups WHERE device_name LIKE 'd4734%')")

NAME = "d4734 mac clock"


async def _computer(c, n, name=NAME, says_press=True):
    """`n` setups of ONE computer (the same device name · the same person), one agent each, each heard from, the one phone paired with every one of them. Each says (with its startable list) that
    its app takes the press of the whole computer — `says_press=False`: an app from before, which says nothing."""
    phone, der = await _register(c)
    out = []
    for _ in range(n):
        device = await _device(c, name=name)
        if says_press:
            put = await c.put("/api/v2/desktop/relay/startable", json={"startable": [], "computer_press": True}, headers=_tok(device["device_token"]))
            assert put.status_code == 200, put.text
        agent = device["agents"][0]["member_id"]
        await _state(c, device, agent, "idle", 1)
        await _pair(c, device["device_token"], der)
        out.append((device, agent))
    return phone, out


def _mark(phone, action="out_open", key=None, **extra):
    return _press(phone, action, key=key, computer=True, **extra)


def _ids(device):
    """every agent a setup holds (the exchange makes more than one per setup): a one-setup press reaches all of them"""
    return sorted(a["member_id"] for a in device["agents"])


async def _payloads(sid):
    return [p for _k, p, _by, _key, _st in await _commands(sid)]


async def test_01_a_marked_press_carries_the_scope_of_every_setup_of_the_computer_and_says_n_of_k(world):
    async with _client() as c:
        phone, devs = await _computer(c, 3)
        sid = devs[0][0]["setup_id"]
        agents = sorted(i for d, _a in devs for i in _ids(d))
        k = len(agents)  # (3 setups · every agent each holds)
        r = await _post(c, sid, _mark(phone, key="k-all"))
        assert (r.status_code, r.json()["state"]) == (201, "queued"), r.text
        assert r.json()["agents"] == {"total": k, "pressable": k}
        [payload] = await _payloads(sid)
        assert payload == {"action": "out_open", "signed": "eyJ2IjoxfQ.signed-by-the-phone", "computer": True, "scope": agents, "scope_total": k}
        # a press WITHOUT the mark on the same computer is exactly what it was (two keys, no scope, no `agents` in the answer)
        r2 = await _post(c, sid, _press(phone, "out_open", key="k-one-setup"))
        assert (r2.status_code, "agents" in r2.json()) == (201, False)
        assert (await _payloads(sid))[1] == {"action": "out_open", "signed": "eyJ2IjoxfQ.signed-by-the-phone"}
        # the same marked press again (the same key) gets its own command back
        again = await _post(c, sid, _mark(phone, key="k-all"))
        assert (again.json()["command_id"], again.json()["agents"]) == (r.json()["command_id"], {"total": k, "pressable": k})


async def test_02_only_what_a_press_of_that_setup_could_do_counts_a_disconnected_a_silent_and_an_unpaired_setup_are_left_out(world):
    async with _client() as c:
        phone, devs = await _computer(c, 4)
        (d0, a0), (d1, a1), (d2, a2), (d3, a3) = devs
        sid = d0["setup_id"]
        await _sql(f"UPDATE desktop_setups SET revoked_at = now(), revoked_reason = 'disconnected' WHERE id = '{d1['setup_id']}'")  # disconnected on the web
        await _sql(f"UPDATE desktop_device_tokens SET last_used_at = now() - interval '3 days' WHERE setup_id = '{d2['setup_id']}'")  # not heard from
        await _sql(f"UPDATE remote_device_pairings SET removed_at = now() WHERE setup_id = '{d3['setup_id']}'")  # this phone is not paired with it (any more)
        r = await _post(c, sid, _mark(phone, key="k-some"))
        assert r.status_code == 201, r.text
        # N = what the computer's live setups that are HEARD from hold (the disconnected one is not live; the silent one is not heard — an agent no one can press is not counted); the unpaired one is
        # heard, so it counts in N but not in K; K = what a one-setup press of each could reach — here only the pressed setup's own
        per = len(_ids(d0))
        assert r.json()["agents"] == {"total": 2 * per, "pressable": per}
        [payload] = await _payloads(sid)
        assert payload["scope"] == _ids(d0) and payload["scope_total"] == 2 * per
        assert not set(_ids(d1)) & set(payload["scope"])


async def test_03_the_person_may_press_a_setup_only_through_can_clock_not_through_the_computer(world, monkeypatch):
    from app.services import desktop_clock

    async with _client() as c:
        phone, devs = await _computer(c, 2)
        (d0, a0), (d1, a1) = devs
        real = desktop_clock.can_clock
        monkeypatch.setattr(desktop_clock, "can_clock", lambda *, member_role, user_id, setup: False if str(setup.id) == d1["setup_id"] else real(member_role=member_role, user_id=user_id, setup=setup))
        # the pressed setup is judged first, as in every press (it passes); the other is left out when the person could not press IT
        r = await _post(c, d0["setup_id"], _mark(phone, key="k-can"))
        per = len(_ids(d0))
        assert (r.status_code, r.json()["agents"]) == (201, {"total": 2 * per, "pressable": per})
        [payload] = await _payloads(d0["setup_id"])
        assert payload["scope"] == _ids(d0)


async def test_04_another_persons_and_another_organizations_setups_of_the_same_name_are_not_this_computer(world):
    async with _client() as c:
        phone, devs = await _computer(c, 2)
        (d0, a0), (d1, a1) = devs
        # the second setup now belongs to ANOTHER organization · a third (made on the same name) to ANOTHER person: neither is this computer
        await _sql(f"UPDATE desktop_setups SET org_id = '{ORG2}' WHERE id = '{d1['setup_id']}'")
        other = await _device(c, name=NAME)
        await _sql(f"UPDATE desktop_setups SET confirmed_by = '{uuid.uuid4()}' WHERE id = '{other['setup_id']}'")
        r = await _post(c, d0["setup_id"], _mark(phone, key="k-other"))
        per = len(_ids(d0))
        assert (r.status_code, r.json()["agents"]) == (201, {"total": per, "pressable": per})
        [payload] = await _payloads(d0["setup_id"])
        assert payload["scope"] == _ids(d0)


async def test_04b_a_machine_key_shared_with_another_confirmer_is_another_computer_and_a_setup_not_yet_exchanged_is_not_pressed(world):
    async with _client() as c:
        phone, devs = await _computer(c, 3)
        (d0, a0), (d1, a1), (d2, a2) = devs
        for d in (d0, d1, d2):
            await _sql(f"UPDATE desktop_setups SET machine_key = 'mk-4734-b' WHERE id = '{d['setup_id']}'")  # the same Mac in this organization
        await _sql(f"UPDATE desktop_setups SET confirmed_by = '{uuid.uuid4()}' WHERE id = '{d1['setup_id']}'")  # …but ANOTHER person confirmed this setup: another computer (4618)
        await _sql(f"UPDATE desktop_setups SET exchanged_at = NULL WHERE id = '{d2['setup_id']}'")  # handed over to nobody yet
        r = await _post(c, d0["setup_id"], _mark(phone, key="k-mk"))
        per = len(_ids(d0))
        assert (r.status_code, r.json()["agents"]) == (201, {"total": per, "pressable": per}), r.text
        [payload] = await _payloads(d0["setup_id"])
        assert payload["scope"] == _ids(d0)


async def test_04c_the_press_locks_every_live_setup_of_the_computer_in_the_one_order_before_it_reads_them_and_a_press_without_the_mark_locks_no_sibling(world, monkeypatch):
    from app.services import desktop_setup

    async with _client() as c:
        phone, devs = await _computer(c, 3)
        calls: list[set[str]] = []
        real = desktop_setup._lock_in_order

        async def spy(db, *, member_ids, setup_ids):
            calls.append({str(i) for i in setup_ids})
            return await real(db, member_ids=member_ids, setup_ids=setup_ids)

        monkeypatch.setattr(desktop_setup, "_lock_in_order", spy)
        sid = devs[0][0]["setup_id"]
        assert (await _post(c, sid, _mark(phone, key="k-lock"))).status_code == 201
        assert calls == [{d["setup_id"] for d, _a in devs}]
        calls.clear()
        assert (await _post(c, sid, _press(phone, "out_open", key="k-plain"))).status_code == 201
        assert calls == []


async def test_04d_a_computer_that_changed_between_the_first_read_and_the_locks_queues_nothing(world, monkeypatch):
    from app.services import desktop_clock

    async with _client() as c:
        phone, devs = await _computer(c, 2)
        sid = devs[0][0]["setup_id"]
        real = desktop_clock._lock_computer

        async def stale(db, *, org_id, setup):  # the set that was locked is not the computer any more (a setup joined it meanwhile)
            return (await real(db, org_id=org_id, setup=setup)) - {uuid.UUID(devs[1][0]["setup_id"])}

        monkeypatch.setattr(desktop_clock, "_lock_computer", stale)
        r = await _post(c, sid, _mark(phone, key="k-changing"))
        assert (r.status_code, r.json()["error"]["code"]) == (409, "computer_changing"), r.text
        assert await _commands(sid) == []


async def test_05_the_mark_is_for_the_whole_computer_actions_only_and_never_with_an_agent_or_an_edit(world):
    async with _client() as c:
        phone, devs = await _computer(c, 1)
        (d0, a0) = devs[0]
        sid = d0["setup_id"]
        bad = [
            _mark(phone, "out_open", agent_member_id=a0),
            _mark(phone, "out_edit", agent_member_id=a0, edit={"base_rev": 1, "done": "x"}),
            _press(phone, "out_open", computer=False),
            _press(phone, "out_open", computer="yes"),
        ]
        for i, body in enumerate(bad):
            body["idempotency_key"] = f"bad-{i}"
            r = await _post(c, sid, body)
            assert r.status_code == 422, (i, r.text)
        assert await _commands(sid) == []
        for action in ("out_open", "out_submit", "out_cancel", "in"):
            assert (await _post(c, sid, _mark(phone, action, key=f"ok-{action}"))).status_code == 201


async def test_06_a_grouping_too_large_to_read_in_full_is_refused_not_pressed_in_part(world, monkeypatch):
    from app.services import desktop_computers

    async with _client() as c:
        phone, devs = await _computer(c, 3)
        monkeypatch.setattr(desktop_computers, "GROUP_ROWS_MAX", 1)
        r = await _post(c, devs[0][0]["setup_id"], _mark(phone, key="k-big"))
        assert (r.status_code, r.json()["error"]["code"]) == (409, "computer_too_large"), r.text
        assert await _commands(devs[0][0]["setup_id"]) == []


async def test_06c_the_phones_read_of_a_grouping_too_large_is_refused_too_not_counted_in_part(world, monkeypatch):
    from app.services import desktop_computers

    async with _client() as c:
        phone, devs = await _computer(c, 3)
        monkeypatch.setattr(desktop_computers, "GROUP_ROWS_MAX", 1)
        r = await c.get(f"/api/v2/desktop/setups/{devs[0][0]['setup_id']}/clock", params={"phone_key_id": phone, "computer": "true"}, headers=_person(OWNER))
        assert (r.status_code, r.json()["error"]["code"]) == (409, "computer_too_large"), r.text


def test_06d_the_relay_payload_holds_the_marks_three_keys_together_and_nothing_else_with_them():
    """the stored payload's own shape (a second layer behind the request's): checked without the router"""
    import pytest as _pytest
    from pydantic import ValidationError

    from app.services.desktop_relay import ClockPayload

    a, b = str(uuid.uuid4()), str(uuid.uuid4())
    ok = {"action": "out_open", "signed": "x", "computer": True, "scope": [a, b], "scope_total": 2}
    assert ClockPayload(**ok).scope_total == 2
    assert ClockPayload(action="out_open", signed="x").computer is None  # (a press without the mark)
    for bad in (
        {**ok, "agent_member_id": a},  # a mark names no agent
        {**ok, "scope": [a, a]},  # a scope has no repeats
        {**ok, "scope_total": 1},  # …and is no larger than its total
        {k: v for k, v in ok.items() if k != "scope"},  # the three come together
        {k: v for k, v in ok.items() if k != "scope_total"},
        {**ok, "computer": None},
    ):
        with _pytest.raises(ValidationError):
            ClockPayload(**bad)
    with _pytest.raises(ValidationError):
        ClockPayload(action="out_edit", signed="x", agent_member_id=a, edit={"base_rev": 1, "done": "x"}, computer=True, scope=[a], scope_total=1)


async def test_06e_the_phones_read_does_not_count_the_pressed_setup_when_it_is_silent_a_press_of_it_would_be_refused(world):
    async with _client() as c:
        phone, devs = await _computer(c, 3)
        (d0, a0), (d1, a1), (d2, a2) = devs
        await _sql(f"UPDATE desktop_device_tokens SET last_used_at = now() - interval '3 days' WHERE setup_id = '{d0['setup_id']}'")  # the PRESSED setup is not heard from
        r = await c.get(f"/api/v2/desktop/setups/{d0['setup_id']}/clock", params={"phone_key_id": phone, "computer": "true"}, headers=_person(OWNER))
        per = len(_ids(d0))
        assert (r.status_code, r.json()["computer"]) == (200, {"agents": {"total": 3 * per, "pressable": 2 * per}}), r.text


async def test_06b_the_phones_read_says_n_of_k_before_it_signs_counts_only_and_only_when_asked(world):
    async with _client() as c:
        phone, devs = await _computer(c, 3)
        (d0, a0), (d1, a1), (d2, a2) = devs
        await _sql(f"UPDATE desktop_device_tokens SET last_used_at = now() - interval '3 days' WHERE setup_id = '{d2['setup_id']}'")  # not heard from: not pressable now
        plain = await _read(c, d0["setup_id"], phone)
        assert plain.status_code == 200 and "computer" not in plain.json()
        r = await c.get(f"/api/v2/desktop/setups/{d0['setup_id']}/clock", params={"phone_key_id": phone, "computer": "true"}, headers=_person(OWNER))
        per = len(_ids(d0))
        assert (r.status_code, r.json()["computer"]) == (200, {"agents": {"total": 2 * per, "pressable": 2 * per}}), r.text
        assert not any(i in r.text for d in (d0, d1, d2) for i in _ids(d)), "counts only: no id of what was left out (nor of what was kept)"


async def test_07b_the_one_agent_end_at_the_mac_never_widens_to_the_computers_other_setups(world):
    async with _client() as c:
        phone, devs = await _computer(c, 2)
        (d0, a0), (d1, a1) = devs
        # a panel of ONE agent (scope «one») names exactly its own single agent: a row of a sibling's agent in it is dropped, as before this story
        rep = await _put(c, d0, _report(1, "panel", scope="one", opened_from="phone", count={"ready": 1, "needs_you": 0, "drafting": 0}, rows=[_row(a1, first_line="not mine")]))
        assert rep.status_code == 200, rep.text
        assert (rep.json()["applied"], rep.json()["dropped_rows"]) == (True, 1)
        assert (await _views(d0["setup_id"]))[0][1]["rows"] == []


async def test_07_a_computer_wide_report_keeps_the_rows_of_the_computers_other_setups_and_the_read_gives_each_person_only_what_they_may_press(world, monkeypatch):
    from app.services import desktop_clock

    async with _client() as c:
        phone, devs = await _computer(c, 2)
        (d0, a0), (d1, a1) = devs
        stranger = await _device(c, name="d4734 other mac")  # another computer: its agent is nobody's row here
        a_x = stranger["agents"][0]["member_id"]
        rep = await _put(c, d0, _panel(1, a0, rows=[_row(a0, first_line="one"), _row(a1, first_line="two"), _row(a_x)]))
        assert rep.status_code == 200, rep.text
        assert (rep.json()["applied"], rep.json()["dropped_rows"]) == (True, 1), "the sibling's row is kept; the other computer's agent is dropped"
        stored = [r["agent_member_id"] for r in (await _views(d0["setup_id"]))[0][1]["rows"]]
        assert sorted(stored) == sorted([a0, a1])
        got = await _read(c, d0["setup_id"], phone)
        assert sorted(r["agent_member_id"] for r in got.json()["view"]["rows"]) == sorted([a0, a1])
        # the person could not press the second setup → its row is not given to the phone (kept on the server, never read out)
        real = desktop_clock.can_clock
        monkeypatch.setattr(desktop_clock, "can_clock", lambda *, member_role, user_id, setup: False if str(setup.id) == d1["setup_id"] else real(member_role=member_role, user_id=user_id, setup=setup))
        got2 = await _read(c, d0["setup_id"], phone)
        assert [r["agent_member_id"] for r in got2.json()["view"]["rows"]] == [a0]


async def _silent_old_setups(c, name, n):
    """`n` OLD setups of the same computer: connected once, never disconnected, not heard from for days (what an app installed again and again leaves behind) — none says `computer_press`, each holds agents"""
    old = []
    for _ in range(n):
        device = await _device(c, name=name)
        await _sql(f"UPDATE desktop_device_tokens SET last_used_at = now() - interval '3 days' WHERE setup_id = '{device['setup_id']}'")
        old.append(device)
    return old


async def test_08_old_setups_that_are_never_heard_from_again_do_not_swell_n_nor_widen_the_scope(world):
    async with _client() as c:
        phone, devs = await _computer(c, 1)
        (d0, a0) = devs[0]
        old = await _silent_old_setups(c, NAME, 4)
        per = len(_ids(d0))
        sid = d0["setup_id"]
        r = await c.get(f"/api/v2/desktop/setups/{sid}/clock", params={"phone_key_id": phone, "computer": "true"}, headers=_person(OWNER))
        assert (r.status_code, r.json()["computer"]) == (200, {"agents": {"total": per, "pressable": per}}), r.text  # N = the heard setup's agents only — not (1 + 4) * per
        p = await _post(c, sid, _mark(phone, key="k-old"))
        assert (p.status_code, p.json()["agents"]) == (201, {"total": per, "pressable": per}), p.text
        [payload] = await _payloads(sid)
        assert payload["scope"] == _ids(d0) and payload["scope_total"] == per
        assert not set(payload["scope"]) & {i for o in old for i in _ids(o)}
