"""story 4993 (P2 · same-network direct, the server's part) — a paired phone's SEALED ask for a short-lived direct door on its own computer, and the computer's SEALED answer: the `direct_open` command word, the short-lived ask row, who may ask and
read, the header rules, the limits, and what goes with a disconnect. The server holds envelopes only — never an address, a port or a ticket. It is the files road of 4983 with the project taken out, so these tests are that road's, ported, plus the
rules that are the direct road's own (a 30-second ask, a 60-second answer, one waiting ask per person). Each test goes red without the line it names.
"""
from __future__ import annotations

import logging
import uuid
from datetime import timedelta

import pytest

from tests.test_4424_desktop_setup_realdb import (  # noqa: F401 — fixtures (autouse ones apply here too)
    OUTSIDER,
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
from tests.test_4529_desktop_relay_realdb import _tok
from tests.test_4534_desktop_commands_realdb import _commands, _remote_control_on, _world  # noqa: F401
from tests.test_4535_org_remote_control_realdb import _switch as _remote_control_switch  # noqa: F401
from tests.test_4976_sealed_prompt_realdb import b64, now_ms, sealed_env

pytestmark = pytest.mark.anyio

MARK = "ZQ9-DIRECT-LEAK-MARKER"  # what must never reach a log line or an error


async def _setup(c, name):
    """A computer of the owner's with the owner's phone paired and one agent; → (device, agent, phone, setup id)."""
    device, agent, phone, _der, _conv = await _world(c, name)
    sid = (await _sql(fetch=f"SELECT id FROM desktop_setups WHERE device_name = '{name}'"))[0][0]
    return device, agent, phone, sid


def _env(sid, key, *, kind="direct_open", **over):
    over.setdefault("session_key", "direct")
    over.setdefault("ct", b64(240))  # (a short canonical text padded to 256 bytes, plus the 16-byte tag)
    return sealed_env(sid, key, kind=kind, **over)


def _body(sid, phone, key=None, **env_over):
    key = key or str(uuid.uuid4())
    return {"idempotency_key": key, "phone_key_id": phone, "envelope": _env(sid, key, **env_over)}


def _ask(c, sid, body, who=OWNER, headers=None):
    return c.post(f"/api/v2/desktop/computers/{sid}/direct", json=body, headers=headers or _person(who))


def _get(c, sid, command_id, who=OWNER):
    return c.get(f"/api/v2/desktop/computers/{sid}/direct/{command_id}", headers=_person(who))


def _answer_env(sid, key, **over):
    return _env(sid, key, kind="direct_offer", **{"from": "host-1", "to": ["phone-1"], "wraps": [{"to": "phone-1", "enc": b64(32), "ek": b64(48)}], "ct": b64(496), **over})


def _put(c, device, command_id, envelope=None, raw=None, headers=None):
    kw = {"content": raw} if raw is not None else {"json": {"envelope": envelope}}
    h = {**_tok(device["device_token"]), **({"content-type": "application/json"} if raw is not None else {})}
    return c.put(f"/api/v2/desktop/relay/direct/{command_id}", headers=headers or h, **kw)


async def _delivered(command_id):
    await _sql(f"UPDATE desktop_commands SET state = 'delivered' WHERE id = '{command_id}'")


async def _rows(sid):
    return await _sql(fetch=f"SELECT command_id, viewer_id, press_key, payload, written_at, expires_at - created_at FROM desktop_direct_asks WHERE setup_id = '{sid}'")


async def _age(sid):
    """Let the pause and the poll gap pass without waiting."""
    await _sql(f"UPDATE desktop_commands SET created_at = created_at - interval '10 seconds' WHERE setup_id = '{sid}' AND kind = 'direct_open'")
    await _sql(f"UPDATE desktop_direct_asks SET polled_at = NULL, created_at = created_at - interval '10 seconds' WHERE setup_id = '{sid}'")


async def _close(sid):
    await _age(sid)
    await _sql(f"UPDATE desktop_commands SET state = 'done' WHERE setup_id = '{sid}' AND kind = 'direct_open'")


async def _asked(c, device, sid, phone, **kw):
    body = _body(sid, phone, **kw)
    r = await _ask(c, sid, body)
    assert r.status_code == 201, r.text
    cid = r.json()["command_id"]
    await _delivered(cid)
    return cid, body["idempotency_key"]


async def _org(sid):
    return (await _sql(fetch=f"SELECT org_id FROM desktop_setups WHERE id = '{sid}'"))[0][0]


async def test_01_an_ask_queues_one_direct_open_command_whose_payload_is_only_the_envelope_and_makes_a_sixty_second_row(world):
    async with _client() as c:
        _d, _agent, phone, sid = await _setup(c, "d4993 mac a")
        body = _body(sid, phone)
        r = await _ask(c, sid, body)
        assert r.status_code == 201, r.text
        assert r.headers["cache-control"] == "no-store"
        cid = r.json()["command_id"]
        cmds = [x for x in await _commands(sid) if x[0] == "direct_open"]
        assert [(k, set(p), st) for k, p, _by, _key, st in cmds] == [("direct_open", {"envelope"}, "queued")]  # no session, no address, nothing readable
        assert cmds[0][1]["envelope"] == body["envelope"]
        rows = await _rows(sid)
        assert [(str(a), str(b), key, pl, w) for a, b, key, pl, w, _ttl in rows] == [(cid, str(OWNER), body["idempotency_key"], None, None)]
        assert timedelta(seconds=60) <= rows[0][5] < timedelta(seconds=61)


async def test_02_the_envelope_header_must_be_this_presses_own_and_the_ask_is_as_fresh_as_thirty_seconds(world):
    async with _client() as c:
        _d, _a, phone, sid = await _setup(c, "d4993 mac b")
        key = str(uuid.uuid4())
        old, future = now_ms() - 3_600_000, now_ms() + 3_600_000
        for over in ({"setup_id": str(uuid.uuid4())}, {"session_key": "file:" + str(uuid.uuid4())}, {"session_key": "s-1"}, {"session_key": ""}, {"command_id": str(uuid.uuid4())}, {"ts": old, "expires_at": old + 120_000},
                     {"ts": future, "expires_at": future + 120_000}, {"expires_at": now_ms() - 5_000}, {"expires_at": now_ms() + 3_600_000},
                     {"ts": now_ms() - 31_000, "expires_at": now_ms() + 60_000}, {"ts": now_ms() + 31_000, "expires_at": now_ms() + 90_000}):
            body = {"idempotency_key": key, "phone_key_id": phone, "envelope": _env(sid, key, **over)}
            r = await _ask(c, sid, body)
            assert r.status_code == 422 and r.json()["error"]["code"] == "envelope_header_mismatch", (over, r.text)
        assert [x for x in await _commands(sid) if x[0] == "direct_open"] == []  # none of them was kept
        ok = {"idempotency_key": key, "phone_key_id": phone, "envelope": _env(sid, key, ts=now_ms() - 25_000, expires_at=now_ms() + 60_000)}
        assert (await _ask(c, sid, ok)).status_code == 201, "an ask 25 seconds old passes: the door is asked for NOW, not for a time long gone"


async def test_03_what_is_not_a_direct_ask_is_refused_by_shape_and_never_echoed(world):
    async with _client() as c:
        _d, _a, phone, sid = await _setup(c, "d4993 mac c")
        good = _body(sid, phone)
        bad_bodies = [
            {**good, "envelope": {**good["envelope"], "kind": "send_prompt"}},            # another kind of envelope
            {**good, "envelope": {**good["envelope"], "kind": "file_list"}},
            {**good, "envelope": {**good["envelope"], "kind": "direct_offer"}},            # an answer is not an ask
            {**good, "envelope": {**good["envelope"], "extra": MARK}},                       # not the agreed shape
            {**good, "envelope": {**good["envelope"], "ct": b64(1024 + 17)}},                # past the size class of an ask
            {**good, "address": f"10.0.0.1:{MARK}"},                                       # an address rides along beside the envelope
            {**good, "project_id": str(uuid.uuid4())},                                     # (a files field)
            {k: v for k, v in good.items() if k != "envelope"},
            {**good, "phone_key_id": "not-a-uuid"},
        ]
        for bad in bad_bodies:
            r = await _ask(c, sid, bad)
            assert r.status_code == 422, (list(bad), r.text)
            assert MARK not in r.text
        assert [x for x in await _commands(sid) if x[0] == "direct_open"] == []


async def test_04_who_may_ask_the_computers_pairing_person_with_a_phone_paired_to_it(world):
    async with _client() as c:
        _d, _a, phone, sid = await _setup(c, "d4993 mac d")
        r = await _ask(c, sid, _body(sid, phone), who=PLAIN)
        assert (r.status_code, r.json()["error"]["code"]) == (403, "not_allowed_to_open_direct"), r.text  # an org member who is not the pairing person: the same answer as «no such computer»
        assert (await _ask(c, sid, _body(sid, phone), who=OUTSIDER)).status_code in (403, 404)
        r = await _ask(c, uuid.uuid4(), _body(sid, phone))
        assert r.status_code == 403 and r.json()["error"]["code"] == "not_allowed_to_open_direct", "a computer that is no one's looks like a computer that is not yours"
        r = await _ask(c, sid, _body(sid, str(uuid.uuid4())))
        assert r.status_code == 409 and r.json()["error"]["code"] == "phone_not_paired"
        assert [x for x in await _commands(sid) if x[0] == "direct_open"] == []
        assert (await _ask(c, sid, _body(sid, phone))).status_code == 201


async def test_05_the_same_press_key_gives_back_the_first_command_not_a_second(world):
    async with _client() as c:
        _d, _a, phone, sid = await _setup(c, "d4993 mac e")
        body = _body(sid, phone)
        first = await _ask(c, sid, body)
        again = await _ask(c, sid, body)
        assert first.status_code == 201 and again.status_code == 201 and first.json() == again.json()
        assert len([x for x in await _commands(sid) if x[0] == "direct_open"]) == 1


async def test_06_limits_one_ask_a_second_per_person_and_one_waiting_ask_per_person(world):
    async with _client() as c:
        _d, _a, phone, sid = await _setup(c, "d4993 mac f")
        assert (await _ask(c, sid, _body(sid, phone))).status_code == 201
        r = await _ask(c, sid, _body(sid, phone))
        assert r.status_code == 429 and r.json()["error"]["code"] == "direct_too_fast"
        await _age(sid)
        r = await _ask(c, sid, _body(sid, phone))
        assert r.status_code == 409 and r.json()["error"]["code"] == "direct_busy", "the first is still waiting"
        await _close(sid)
        assert (await _ask(c, sid, _body(sid, phone))).status_code == 201


async def test_07_the_computer_answers_once_and_only_to_this_ask(world):
    async with _client() as c:
        device, _a, phone, sid = await _setup(c, "d4993 mac g")
        r = await _ask(c, sid, _body(sid, phone))
        cid, key = r.json()["command_id"], (await _rows(sid))[0][2]
        ans = _answer_env(sid, key)
        r = await _put(c, device, cid, ans)
        assert (r.status_code, r.json()["error"]["code"]) == (409, "direct_command_closed"), "the command is still queued: not open"
        await _delivered(cid)
        for over in ({"setup_id": str(uuid.uuid4())}, {"session_key": "file:x"}, {"session_key": "s-1"}, {"command_id": str(uuid.uuid4())}, {"expires_at": now_ms() - 5_000}):
            r = await _put(c, device, cid, _answer_env(sid, key, **over))
            assert r.status_code == 422 and r.json()["error"]["code"] == "envelope_header_mismatch", over
        assert (await _rows(sid))[0][3] is None, "none of them was kept"
        assert (await _put(c, device, cid, _env(sid, key, kind="approval_card"))).status_code == 422, "the kind of an answer is direct_offer"
        assert (await _put(c, device, cid, _env(sid, key, kind="file_result"))).status_code == 422, "a files answer is not a direct answer"
        assert (await _put(c, device, cid, _env(sid, key, kind="direct_open"))).status_code == 422, "an ask is not an answer"
        ok = await _put(c, device, cid, ans)
        assert ok.status_code == 200 and ok.json()["bytes"] > 0, ok.text
        r = await _put(c, device, cid, _answer_env(sid, key))
        assert (r.status_code, r.json()["error"]["code"]) == (409, "direct_already_answered"), "written ONCE"
        rows = await _rows(sid)
        assert rows[0][3] == {"envelope": ans} and rows[0][4] is not None


async def test_08_an_answer_from_another_computer_or_for_a_command_that_is_not_an_ask_is_not_found_and_too_large_is_refused_unparsed(world):
    async with _client() as c:
        device, _a, phone, sid = await _setup(c, "d4993 mac h")
        other, _a2, _p2, _sid2 = await _setup(c, "d4993 mac h2")
        cid, key = await _asked(c, device, sid, phone)
        r = await _put(c, other, cid, _answer_env(sid, key))
        assert r.status_code == 404 and r.json()["error"]["code"] == "direct_ask_not_found"
        assert (await _put(c, device, uuid.uuid4(), _answer_env(sid, key))).status_code == 404
        r = await _put(c, device, cid, raw=b"x" * (8 * 1024 + 1))
        assert r.status_code == 413 and r.json()["error"]["code"] == "direct_too_large"
        r = await _put(c, device, cid, raw=('{"envelope": "' + MARK + '"}').encode())
        assert r.status_code == 422 and MARK not in r.text
        r = await _put(c, device, cid, raw=('{"envelope": {}, "extra": "' + MARK + '"}').encode())
        assert r.status_code == 422 and MARK not in r.text


async def test_09_the_person_reads_the_sealed_answer_once_and_nobody_else_ever(world):
    async with _client() as c:
        device, _a, phone, sid = await _setup(c, "d4993 mac i")
        cid, key = await _asked(c, device, sid, phone)
        r = await _get(c, sid, cid)
        assert r.status_code == 200 and r.json() == {"state": "delivered", "code": None, "envelope": None}, "asked, not answered yet"
        ans = _answer_env(sid, key)
        assert (await _put(c, device, cid, ans)).status_code == 200
        await _age(sid)
        assert (await _get(c, sid, cid, who=PLAIN)).status_code in (403, 404)
        assert (await _get(c, uuid.uuid4(), cid)).status_code == 404, "another computer's id"
        got = await _get(c, sid, cid)
        assert got.status_code == 200 and got.headers["cache-control"] == "no-store"
        assert got.json() == {"state": "done", "code": None, "envelope": ans}
        assert (await _get(c, sid, cid)).status_code == 404, "read ONCE: reading deletes it"
        assert await _rows(sid) == []


async def test_10_a_computer_that_ended_without_an_answer_is_the_answer_and_nothing_is_held(world):
    async with _client() as c:
        device, _a, phone, sid = await _setup(c, "d4993 mac j")
        cid, _key = await _asked(c, device, sid, phone)
        await _sql(f"UPDATE desktop_commands SET state = 'rejected', result_code = 'envelope_replay' WHERE id = '{cid}'")
        await _age(sid)
        r = await _get(c, sid, cid)
        assert r.status_code == 200 and r.json() == {"state": "rejected", "code": "envelope_replay", "envelope": None}
        assert await _rows(sid) == []


async def test_11_a_row_past_its_end_is_gone_and_a_tight_poll_costs_a_429(world):
    async with _client() as c:
        device, _a, phone, sid = await _setup(c, "d4993 mac k")
        cid, _key = await _asked(c, device, sid, phone)
        assert (await _get(c, sid, cid)).status_code == 200
        r = await _get(c, sid, cid)
        assert r.status_code == 429 and r.json()["error"]["code"] == "direct_polled_too_fast"
        await _sql(f"UPDATE desktop_direct_asks SET expires_at = now() - interval '1 second' WHERE command_id = '{cid}'")
        assert (await _get(c, sid, cid)).status_code == 404
        assert await _rows(sid) == []


async def test_12_the_answer_waits_sixty_seconds_and_not_a_moment_more(world):
    async with _client() as c:
        device, _a, phone, sid = await _setup(c, "d4993 mac l")
        cid, key = await _asked(c, device, sid, phone)
        assert (await _put(c, device, cid, _answer_env(sid, key))).status_code == 200
        await _sql(f"UPDATE desktop_direct_asks SET created_at = now() - interval '59 seconds', expires_at = now() + interval '1 second', polled_at = NULL WHERE command_id = '{cid}'")
        got = await _get(c, sid, cid)
        assert got.status_code == 200 and got.json()["envelope"] is not None, "at 59 seconds it is still given"
    await _sql("UPDATE desktop_commands SET created_at = created_at - interval '10 seconds' WHERE kind = 'direct_open'")  # (the person's one-ask-a-second pause reads their last ask of ANY computer)
    async with _client() as c:
        device, _a, phone, sid = await _setup(c, "d4993 mac l2")
        cid, key = await _asked(c, device, sid, phone)
        assert (await _put(c, device, cid, _answer_env(sid, key))).status_code == 200
        await _sql(f"UPDATE desktop_direct_asks SET expires_at = now() - interval '1 millisecond' WHERE command_id = '{cid}'")
        assert (await _get(c, sid, cid)).status_code == 404, "past 60 seconds it is gone"
        assert await _rows(sid) == []


async def test_13_remote_control_turned_off_takes_the_waiting_answers_with_it(world):
    async with _client() as c:
        device, _a, phone, sid = await _setup(c, "d4993 mac m")
        cid, key = await _asked(c, device, sid, phone)
        assert (await _put(c, device, cid, _answer_env(sid, key))).status_code == 200
        await _remote_control_switch(c, False)
        assert await _rows(sid) == [], "no answer stays for a computer that cannot be reached"


async def test_14_an_ask_that_waited_past_thirty_seconds_is_never_delivered(world):
    async with _client() as c:
        device, _a, phone, sid = await _setup(c, "d4993 mac n")
        from app.core.database import async_session_factory
        from app.services.desktop_relay import commands_to_send

        r = await _ask(c, sid, _body(sid, phone))
        cid = r.json()["command_id"]
        await _sql(f"UPDATE desktop_commands SET created_at = now() - interval '31 seconds' WHERE id = '{cid}'")
        async with async_session_factory() as s:
            sent = await commands_to_send(s, uuid.UUID(str(sid)), 0)
            await s.commit()
        assert [x.kind for x in sent if x.kind == "direct_open"] == []
        state = (await _sql(fetch=f"SELECT state, result_code FROM desktop_commands WHERE id = '{cid}'"))[0]
        assert tuple(state) == ("rejected", "expired")


async def test_15_a_fresh_ask_is_delivered_to_the_computer_with_exactly_the_envelope(world):
    async with _client() as c:
        device, _a, phone, sid = await _setup(c, "d4993 mac o")
        from app.core.database import async_session_factory
        from app.services.desktop_relay import commands_to_send

        body = _body(sid, phone)
        assert (await _ask(c, sid, body)).status_code == 201
        async with async_session_factory() as s:
            sent = await commands_to_send(s, uuid.UUID(str(sid)), 0)
            await s.commit()
        rows = [x for x in sent if x.kind == "direct_open"]
        assert len(rows) == 1 and rows[0].payload == {"envelope": body["envelope"]} and rows[0].session_key is None


async def test_16_no_envelope_or_address_reaches_a_log_line(world, caplog):
    caplog.set_level(logging.DEBUG)
    async with _client() as c:
        device, _a, phone, sid = await _setup(c, "d4993 mac p")
        body = _body(sid, phone)
        body["envelope"]["ct"] = b64(200) + "AAAA"
        await _ask(c, sid, body)
        await _ask(c, sid, {**body, "address": MARK})
        await _close(sid)  # (the first ask above was a legal one: it is ended, and the pause has passed)
        cid, key = await _asked(c, device, sid, phone)
        ans = _answer_env(sid, key)
        await _put(c, device, cid, ans)
        await _get(c, sid, cid)
        assert MARK not in caplog.text and body["envelope"]["ct"] not in caplog.text and ans["ct"] not in caplog.text


async def test_17_a_persons_own_session_only_an_agent_key_is_refused_on_both_roads(world):
    async with _client() as c:
        device, _a, phone, sid = await _setup(c, "d4993 mac q")
        cid, key = await _asked(c, device, sid, phone)
        agent_key = {"Authorization": f"Bearer {device['agents'][0]['api_key']}", "X-Org-Id": str(await _org(sid))}
        assert (await _ask(c, sid, _body(sid, phone), headers=agent_key)).status_code in (401, 403)
        assert (await c.get(f"/api/v2/desktop/computers/{sid}/direct/{cid}", headers=agent_key)).status_code in (401, 403)
        assert (await c.delete(f"/api/v2/desktop/computers/{sid}/direct/{cid}", headers=agent_key)).status_code in (401, 403)
        assert len([x for x in await _commands(sid) if x[0] == "direct_open"]) == 1, "only the person's own ask exists"


async def test_18_a_persons_api_key_is_refused_on_both_roads_like_an_agents(world):
    from app.core.security import create_access_token

    async with _client() as c:
        device, _a, phone, sid = await _setup(c, "d4993 mac r")
        cid, _key = await _asked(c, device, sid, phone)
        tok = create_access_token(user_id=str(OWNER), app_metadata={"human_api_key_id": str(uuid.uuid4())})
        keyed = {"Authorization": f"Bearer {tok}", "X-Org-Id": str(await _org(sid))}
        r = await _ask(c, sid, _body(sid, phone), headers=keyed)
        assert r.status_code == 403 and "person_session_required" in r.text, r.text
        r = await c.get(f"/api/v2/desktop/computers/{sid}/direct/{cid}", headers=keyed)
        assert r.status_code == 403 and "person_session_required" in r.text, r.text


async def test_19_the_person_gives_the_ask_up_and_only_their_own_row_goes(world):
    async with _client() as c:
        device, _a, phone, sid = await _setup(c, "d4993 mac s")
        cid, key = await _asked(c, device, sid, phone)
        assert (await _put(c, device, cid, _answer_env(sid, key))).status_code == 200
        r = await c.delete(f"/api/v2/desktop/computers/{sid}/direct/{cid}", headers=_person(PLAIN))
        assert r.status_code in (200, 403, 404) and (r.status_code != 200 or r.json() == {"deleted": False})
        assert len(await _rows(sid)) == 1, "another person's delete deletes nothing"
        r = await c.delete(f"/api/v2/desktop/computers/{sid}/direct/{uuid.uuid4()}", headers=_person(OWNER))
        assert r.status_code == 200 and r.json() == {"deleted": False}
        r = await c.delete(f"/api/v2/desktop/computers/{sid}/direct/{cid}", headers=_person(OWNER))
        assert r.status_code == 200 and r.json() == {"deleted": True} and r.headers["cache-control"] == "no-store"
        assert await _rows(sid) == []


async def test_20_a_read_whose_pairing_or_line_is_gone_is_not_readable_and_leaves_nothing(world):
    async with _client() as c:
        device, _a, phone, sid = await _setup(c, "d4993 mac t")
        cid, key = await _asked(c, device, sid, phone)
        assert (await _put(c, device, cid, _answer_env(sid, key))).status_code == 200
        await _sql(f"UPDATE desktop_setups SET confirmed_by = '{PLAIN}' WHERE id = '{sid}'")  # re-paired: the old viewer gets nothing, and the row goes
        await _age(sid)
        assert (await _get(c, sid, cid)).status_code == 404
        assert await _rows(sid) == []
        await _sql(f"UPDATE desktop_setups SET confirmed_by = '{OWNER}' WHERE id = '{sid}'")
        await _close(sid)
        cid, key = await _asked(c, device, sid, phone)
        assert (await _put(c, device, cid, _answer_env(sid, key))).status_code == 200
        r = await c.delete(f"/api/v2/desktop/setups/{sid}", headers=_person(OWNER))  # the computer is disconnected: its answers go and no new ask is taken
        assert r.status_code == 200, r.text
        assert await _rows(sid) == []
        assert (await _get(c, sid, cid)).status_code == 404
        assert (await _ask(c, sid, _body(sid, phone))).status_code in (403, 404, 409)
        assert await _rows(sid) == []


async def test_21_a_replaced_line_and_a_reclaimed_account_take_their_answers_too(world):
    from datetime import datetime, timezone

    from app.core.database import async_session_factory
    from app.models.desktop_setup import DesktopSetup
    from app.models.user import User
    from app.routers.auth import _reclaim_unproved_account
    from app.services.desktop_setup import _retire_same_machine

    async with _client() as c:
        device, _a, phone, sid = await _setup(c, "d4993 mac u")
        cid, key = await _asked(c, device, sid, phone)
        assert (await _put(c, device, cid, _answer_env(sid, key))).status_code == 200
        await _sql(f"UPDATE desktop_setups SET machine_key = 'mk-4993' WHERE id = '{sid}'")
        async with async_session_factory() as s:
            setup = await s.get(DesktopSetup, uuid.UUID(str(sid)))
            agents = frozenset(uuid.UUID(str(m["member_id"])) for m in (setup.members or []) if m.get("kind") == "agent")
            assert await _retire_same_machine(s, machine_key="mk-4993", others=[setup], now=datetime.now(timezone.utc), new_agents=agents, before={setup.id: agents}) == 1
            await s.commit()
        assert await _rows(sid) == []
        await _age(sid)  # the person's pause reads their last ask of any computer
        device2, _a2, phone2, sid2 = await _setup(c, "d4993 mac u2")
        cid2, key2 = await _asked(c, device2, sid2, phone2)
        assert (await _put(c, device2, cid2, _answer_env(sid2, key2))).status_code == 200
        await _sql(f"UPDATE users SET email_verified = false WHERE id = '{PLAIN}'", f"UPDATE desktop_setups SET confirmed_by = '{PLAIN}' WHERE id = '{sid2}'")
        assert len(await _rows(sid2)) == 1
        async with async_session_factory() as s:
            user = await s.get(User, PLAIN)
            assert await _reclaim_unproved_account(s, user, why="test 4993") is not None
            await s.commit()
        assert await _rows(sid2) == []


async def test_22_the_minute_sweep_takes_a_row_past_its_end(world):
    from app.core.database import async_session_factory
    from app.services.desktop_direct import purge_expired

    async with _client() as c:
        device, _a, phone, sid = await _setup(c, "d4993 mac v")
        await _asked(c, device, sid, phone)
        await _sql(f"UPDATE desktop_direct_asks SET expires_at = now() - interval '1 second' WHERE setup_id = '{sid}'")
        async with async_session_factory() as s:
            assert await purge_expired(s) == 1
            await s.commit()
        assert await _rows(sid) == []


async def test_23_remote_control_off_a_computer_not_heard_from_and_a_seat_that_ended_each_stop_the_ask(world):
    from app.core.database import async_session_factory
    from app.services import desktop_direct

    async with _client() as c:
        device, _a, phone, sid = await _setup(c, "d4993 mac w")
        await _sql(f"UPDATE organizations SET remote_control_enabled_at = NULL WHERE id = '{await _org(sid)}'")
        r = await _ask(c, sid, _body(sid, phone))
        assert (r.status_code, r.json()["error"]["code"]) == (409, "remote_control_off"), "the switch is judged by the ask itself, not by a layer behind it"
        await _sql(f"UPDATE organizations SET remote_control_enabled_at = now() WHERE id = '{await _org(sid)}'")
        await _sql(f"UPDATE desktop_device_tokens SET last_used_at = now() - interval '1 hour' WHERE setup_id = '{sid}'")
        r = await _ask(c, sid, _body(sid, phone))
        assert (r.status_code, r.json()["error"]["code"]) == (409, "device_unreachable")
        await _sql(f"UPDATE desktop_device_tokens SET last_used_at = now() WHERE setup_id = '{sid}'")
        # the seat of the pairing person in the organization ended: judged in the service itself (the sign-in layer in front would also refuse it)
        await _sql(f"UPDATE org_members SET deleted_at = now() WHERE user_id = '{OWNER}'")
        async with async_session_factory() as db:
            with pytest.raises(desktop_direct.DesktopRelayError) as ei:
                await desktop_direct.create_ask(db, member_id=uuid.uuid4(), user_id=OWNER, org_id=await _org(sid), setup_id=uuid.UUID(str(sid)), body=desktop_direct.OpenRequest(**_body(sid, phone)))
        assert ei.value.status == 403 and ei.value.code == "not_allowed_to_open_direct"
        await _sql(f"UPDATE org_members SET deleted_at = NULL WHERE user_id = '{OWNER}'")
        assert [x for x in await _commands(sid) if x[0] == "direct_open"] == []


async def test_24_an_answer_is_refused_and_its_row_goes_when_the_asker_no_longer_pairs_the_computer_or_the_row_is_past_its_end(world):
    async with _client() as c:
        device, _a, phone, sid = await _setup(c, "d4993 mac x")
        cid, key = await _asked(c, device, sid, phone)
        await _sql(f"UPDATE desktop_setups SET confirmed_by = '{PLAIN}' WHERE id = '{sid}'")
        r = await _put(c, device, cid, _answer_env(sid, key))
        assert (r.status_code, r.json()["error"]["code"]) == (409, "direct_viewer_gone")
        assert await _rows(sid) == [], "the refusal's own deletion stays (it is committed)"
        await _sql(f"UPDATE desktop_setups SET confirmed_by = '{OWNER}' WHERE id = '{sid}'")
        await _close(sid)
        cid, key = await _asked(c, device, sid, phone)
        await _sql(f"UPDATE desktop_direct_asks SET expires_at = now() - interval '1 second' WHERE command_id = '{cid}'")
        assert (await _put(c, device, cid, _answer_env(sid, key))).status_code == 404
        assert await _rows(sid) == [], "a refused write past the end deletes the row, and that stays"


async def test_25_a_read_whose_remote_control_is_off_or_whose_command_ended_after_the_answer_is_not_given_and_leaves_nothing(world):
    async with _client() as c:
        device, _a, phone, sid = await _setup(c, "d4993 mac y")
        cid, key = await _asked(c, device, sid, phone)
        assert (await _put(c, device, cid, _answer_env(sid, key))).status_code == 200
        await _sql(f"UPDATE organizations SET remote_control_enabled_at = NULL WHERE id = '{await _org(sid)}'")
        await _age(sid)
        assert (await _get(c, sid, cid)).status_code == 404
        assert await _rows(sid) == []
        await _sql(f"UPDATE organizations SET remote_control_enabled_at = now() WHERE id = '{await _org(sid)}'")
        await _close(sid)
        cid, key = await _asked(c, device, sid, phone)
        assert (await _put(c, device, cid, _answer_env(sid, key))).status_code == 200
        await _sql(f"UPDATE desktop_commands SET state = 'failed', result_code = 'error' WHERE id = '{cid}'")
        await _age(sid)
        r = await _get(c, sid, cid)
        assert r.status_code == 200 and r.json() == {"state": "failed", "code": "error", "envelope": None}, "the command ended after the answer: the answer is not given"
        assert await _rows(sid) == []


async def test_26_the_minute_job_sweeps_the_direct_rows_too(world, monkeypatch):
    from httpx import ASGITransport, AsyncClient

    from app.main import app
    from app.routers import cron as cron_module

    monkeypatch.setattr(cron_module, "CRON_SECRET", "test-cron-secret")
    async with _client() as c:
        device, _a, phone, sid = await _setup(c, "d4993 mac z")
        await _asked(c, device, sid, phone)
        await _sql(f"UPDATE desktop_direct_asks SET expires_at = now() - interval '1 second' WHERE setup_id = '{sid}'")
    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as client:
        r = await client.post("/api/v2/internal/cron/changes-purge", headers={"Authorization": "Bearer test-cron-secret"})
    assert r.status_code == 200 and r.json()["data"]["direct_purged"] == 1, r.text
    assert await _rows(sid) == []


async def test_27_an_ask_is_judged_by_size_before_it_is_parsed_whatever_the_header_said(world):
    async with _client() as c:
        _d, _a, phone, sid = await _setup(c, "d4993 mac ab")
        big = {**_body(sid, phone), "padding": "x" * (8 * 1024)}
        r = await _ask(c, sid, big)
        assert r.status_code == 413 and r.json()["error"]["code"] == "direct_request_too_large"

        async def chunks():  # no content-length: the stream itself is bounded
            yield b'{"padding": "'
            for _ in range(10):
                yield b"x" * 1024
            yield b'"}'

        r = await c.post(f"/api/v2/desktop/computers/{sid}/direct", content=chunks(), headers={**_person(OWNER), "content-type": "application/json"})
        assert r.status_code == 413 and r.json()["error"]["code"] == "direct_request_too_large"
        assert [x for x in await _commands(sid) if x[0] == "direct_open"] == []


async def test_28_an_answer_must_be_fresh_a_stale_future_or_long_lived_envelope_is_refused(world):
    async with _client() as c:
        device, _a, phone, sid = await _setup(c, "d4993 mac ac")
        cid, key = await _asked(c, device, sid, phone)
        old, future = now_ms() - 3_600_000, now_ms() + 3_600_000
        for over in ({"ts": old, "expires_at": now_ms() + 60_000}, {"ts": future, "expires_at": future + 60_000}, {"expires_at": now_ms() + 3_600_000},
                     {"ts": now_ms() + 60_000, "expires_at": now_ms() + 30_000}, {"ts": now_ms() - 120_000, "expires_at": now_ms() - 60_000}):
            r = await _put(c, device, cid, _answer_env(sid, key, **over))
            assert r.status_code == 422 and r.json()["error"]["code"] == "envelope_header_mismatch", over
        assert (await _rows(sid))[0][3] is None
        assert (await _put(c, device, cid, _answer_env(sid, key, expires_at=now_ms() + 60_000))).status_code == 200, "the minute the host gives an answer passes"


async def test_29_a_full_size_legal_answer_is_taken_and_one_past_the_size_class_is_not(world):
    async with _client() as c:
        device, _a, phone, sid = await _setup(c, "d4993 mac ae")
        cid, key = await _asked(c, device, sid, phone)
        ok = await _put(c, device, cid, _answer_env(sid, key, ct=b64(1024 + 16)))
        assert ok.status_code == 200, ok.text[:200]
        await _close(sid)
        cid, key = await _asked(c, device, sid, phone)
        r = await _put(c, device, cid, _answer_env(sid, key, ct=b64(1024 + 17)))
        assert r.status_code == 422
        await _close(sid)
        r = await _ask(c, sid, _body(sid, phone, ct=b64(1024 + 16)))
        assert r.status_code == 201, "a full-size legal ask is taken"
        await _close(sid)
        r = await _ask(c, sid, _body(sid, phone, ct=b64(1024 + 17)))
        assert r.status_code == 422


async def test_30_two_looks_that_arrive_together_cannot_both_pass_the_poll_gap(world):
    import asyncio

    async with _client() as c:
        device, _a, phone, sid = await _setup(c, "d4993 mac ad")
        cid, _key = await _asked(c, device, sid, phone)
        rs = await asyncio.gather(*(_get(c, sid, cid) for _ in range(4)))
        assert sorted(r.status_code for r in rs).count(200) == 1, [r.status_code for r in rs]


async def test_31_two_asks_at_once_never_both_pass(world):
    import asyncio

    async with _client() as c:
        _d, _a, phone, sid = await _setup(c, "d4993 mac af")
        rs = await asyncio.gather(*(_ask(c, sid, _body(sid, phone)) for _ in range(4)))
        assert sorted(r.status_code for r in rs).count(201) == 1, [(r.status_code, r.text[:80]) for r in rs]
        assert len([x for x in await _commands(sid) if x[0] == "direct_open"]) == 1


async def test_32_the_limits_are_counted_under_the_advisory_locks_of_the_shared_helper_for_the_direct_road(world, monkeypatch):
    from app.services import desktop_direct

    seen: list[str] = []
    real = desktop_direct.take_limit_locks

    async def spy(db, setup, user_id, *, road):
        seen.append(road)
        return await real(db, setup, user_id, road=road)

    monkeypatch.setattr(desktop_direct, "take_limit_locks", spy)
    async with _client() as c:
        _d, _a, phone, sid = await _setup(c, "d4993 mac ag")
        assert (await _ask(c, sid, _body(sid, phone))).status_code == 201
    assert seen == ["direct"], "the direct road's limits are its own"


async def test_33_the_kind_word_lives_in_the_database_check_and_in_the_code_together(world):
    from app.models.desktop_relay import COMMAND_KINDS

    assert "direct_open" in COMMAND_KINDS
    row = (await _sql(fetch="SELECT pg_get_constraintdef(oid) FROM pg_constraint WHERE conname = 'ck_desktop_commands_kind'"))[0][0]
    for kind in COMMAND_KINDS:
        assert f"'{kind}'" in row, kind
    for old in ("start_session", "send_prompt", "answer_approval", "stop_session", "end_session", "clock", "read_changes", "file_list", "file_read", "file_download"):
        assert f"'{old}'" in row, f"{old}: an old kind still passes the CHECK (the new CHECK is the old one plus one word)"
    assert "'nonsense'" not in row


async def test_34_the_answer_table_holds_no_readable_column_and_hangs_from_its_command_and_computer(world):
    cols = {r[0] for r in await _sql(fetch="SELECT column_name FROM information_schema.columns WHERE table_name = 'desktop_direct_asks'")}
    assert cols == {"command_id", "setup_id", "viewer_id", "press_key", "created_at", "expires_at", "payload", "written_at", "polled_at"}, cols
    fks = {(r[0], r[1]) for r in await _sql(fetch=(
        "SELECT kcu.column_name, rc.delete_rule FROM information_schema.referential_constraints rc JOIN information_schema.key_column_usage kcu ON kcu.constraint_name = rc.constraint_name "
        "WHERE kcu.table_name = 'desktop_direct_asks'"))}
    assert fks == {("command_id", "CASCADE"), ("setup_id", "CASCADE")}, fks
    async with _client() as c:
        device, _a, phone, sid = await _setup(c, "d4993 mac ah")
        cid, key = await _asked(c, device, sid, phone)
        assert (await _put(c, device, cid, _answer_env(sid, key))).status_code == 200
        await _sql(f"DELETE FROM desktop_commands WHERE id = '{cid}'")
        assert await _rows(sid) == [], "a command that ends takes its ask row with it"


async def test_35_the_pairing_is_judged_again_under_the_computers_lock(world, monkeypatch):
    """The first judgment can pass on a computer that is re-paired a moment later; the one under the lock reads the row afresh. This makes that moment (the re-pairing commits after the first read) and the ask is refused all the same."""
    from app.services import agent_permissions as ap

    async with _client() as c:
        _d, _a, phone, sid = await _setup(c, "d4993 mac ai")
        real = ap.paired_phone
        flipped = []

        async def re_paired_after_the_read(db, **kw):
            out = await real(db, **kw)
            if not flipped:  # once: the re-pairing commits after the FIRST judgment's data was read (the second one is under the computer's lock)
                flipped.append(1)
                await _sql(f"UPDATE desktop_setups SET confirmed_by = '{PLAIN}' WHERE id = '{sid}'")
            return out

        monkeypatch.setattr(ap, "paired_phone", re_paired_after_the_read)
        r = await _ask(c, sid, _body(sid, phone))
        assert (r.status_code, r.json()["error"]["code"]) == (403, "not_allowed_to_open_direct")
        assert [x for x in await _commands(sid) if x[0] == "direct_open"] == [] and await _rows(sid) == []


async def test_36_a_look_that_waited_for_the_lock_past_the_rows_end_is_not_given(world, monkeypatch):
    """the look checked the row's end before the lock; while it waited, the end passed: it is judged again after the lock"""
    from datetime import timedelta

    from app.core.database import async_session_factory
    from app.services import desktop_direct as dd

    async with _client() as c:
        device, _a, phone, sid = await _setup(c, "d4993 mac aj")
        cid, key = await _asked(c, device, sid, phone)
        assert (await _put(c, device, cid, _answer_env(sid, key))).status_code == 200
        await _age(sid)
        real = dd._now
        calls = []

        def later():
            calls.append(1)
            return real() + (timedelta(minutes=2) if len(calls) > 1 else timedelta(0))  # the first reading of the clock is now; the later ones are past the end

        monkeypatch.setattr(dd, "_now", later)
        async with async_session_factory() as db:
            with pytest.raises(dd.DesktopRelayError) as ei:
                await dd.read_answer(db, user_id=OWNER, org_id=await _org(sid), setup_id=uuid.UUID(str(sid)), command_id=uuid.UUID(str(cid)))
            await db.commit()
        assert ei.value.status == 404
        monkeypatch.setattr(dd, "_now", real)
        assert await _rows(sid) == []


async def test_37_the_phone_pairing_is_held_under_the_computers_lock(world):
    """a pairing removal that comes while an ask holds the phone's rows waits for the ask (a share lock held to the commit)"""
    import asyncio

    from sqlalchemy import text

    from app.core.database import async_session_factory

    async with _client() as c:
        _d, _a, phone, sid = await _setup(c, "d4993 mac ak")
        async with async_session_factory() as holder:  # another transaction wants to change the pairing: it takes the row for update
            await holder.execute(text("SELECT 1 FROM remote_device_pairings WHERE setup_id = :s FOR UPDATE"), {"s": str(sid)})
            task = asyncio.create_task(_ask(c, sid, _body(sid, phone)))
            await asyncio.sleep(1.5)
            assert not task.done(), "the ask went through while the pairing row was held for change"
            await holder.commit()
        r = await asyncio.wait_for(task, 20)
        assert r.status_code == 201, r.text


async def test_38_an_answer_for_a_command_that_is_not_a_direct_ask_is_not_found(world):
    """the answer's row is selected by the command's KIND too: another kind of command of this computer (a clock) is not an ask, whatever row hangs from it"""
    async with _client() as c:
        device, _a, phone, sid = await _setup(c, "d4993 mac al")
        cid, key = await _asked(c, device, sid, phone)
        await _sql(f"UPDATE desktop_commands SET kind = 'read_changes' WHERE id = '{cid}'")
        r = await _put(c, device, cid, _answer_env(sid, key))
        assert r.status_code == 404 and r.json()["error"]["code"] == "direct_ask_not_found", r.text
        assert (await _rows(sid))[0][3] is None
        await _age(sid)
        r = await _get(c, sid, cid)
        assert r.status_code == 404 and r.json()["error"]["code"] == "direct_ask_not_found", "a read is selected by the command's kind too"


async def test_39_the_pause_is_a_persons_own_and_an_answered_ask_does_not_hold_the_next(world):
    async with _client() as c:
        device, agent, phone, sid = await _setup(c, "d4993 mac am")
        cid, key = await _asked(c, device, sid, phone)
        other = (await _sql(fetch=f"SELECT id FROM team_members WHERE id <> (SELECT requested_by FROM desktop_commands WHERE id = '{cid}') AND org_id = (SELECT org_id FROM desktop_setups WHERE id = '{sid}') LIMIT 1"))[0][0]
        await _sql(f"UPDATE desktop_commands SET requested_by = '{other}' WHERE id = '{cid}'")  # the last ask of ANY computer was another person's, a second ago
        await _sql(f"UPDATE desktop_direct_asks SET viewer_id = '{PLAIN}' WHERE command_id = '{cid}'")  # (and it is not this person's waiting ask either)
        r = await _ask(c, sid, _body(sid, phone))
        assert r.status_code == 201, "another person's ask a second ago is not this person's pause: " + r.text
        await _close(sid)
        cid, key = await _asked(c, device, sid, phone)
        assert (await _put(c, device, cid, _answer_env(sid, key))).status_code == 200
        await _age(sid)
        assert (await _ask(c, sid, _body(sid, phone))).status_code == 201, "an ask that already has its answer is not a waiting one"


async def test_40_a_second_computer_of_the_same_person_cannot_give_up_the_first_ones_ask(world):
    async with _client() as c:
        device, _a, phone, sid = await _setup(c, "d4993 mac an")
        _d2, _a2, _p2, sid2 = await _setup(c, "d4993 mac an2")
        cid, _key = await _asked(c, device, sid, phone)
        r = await c.delete(f"/api/v2/desktop/computers/{sid2}/direct/{cid}", headers=_person(OWNER))
        assert r.status_code == 200 and r.json() == {"deleted": False}, "the ask is selected by the computer in the path too"
        assert len(await _rows(sid)) == 1


async def test_41_a_read_judges_the_seat_in_the_service_itself(world):
    from app.core.database import async_session_factory
    from app.services import desktop_direct as dd

    async with _client() as c:
        device, _a, phone, sid = await _setup(c, "d4993 mac ao")
        cid, key = await _asked(c, device, sid, phone)
        assert (await _put(c, device, cid, _answer_env(sid, key))).status_code == 200
        await _age(sid)
        await _sql(f"UPDATE org_members SET deleted_at = now() WHERE user_id = '{OWNER}'")  # (the sign-in layer in front would also refuse it)
        async with async_session_factory() as db:
            with pytest.raises(dd.DesktopRelayError) as ei:
                await dd.read_answer(db, user_id=OWNER, org_id=await _org(sid), setup_id=uuid.UUID(str(sid)), command_id=uuid.UUID(str(cid)))
            await db.commit()
        assert ei.value.status == 404
        await _sql(f"UPDATE org_members SET deleted_at = NULL WHERE user_id = '{OWNER}'")
        assert await _rows(sid) == [], "the answer of a person who has no seat any more goes with the refusal"


def test_42_a_body_is_judged_by_size_before_it_is_parsed_in_the_service_too():
    from app.services import desktop_direct as dd

    for fn, code in ((dd.parse_ask, "direct_request_too_large"), (dd.parse_answer, "direct_too_large")):
        with pytest.raises(dd.DesktopRelayError) as ei:
            fn(b"x" * (8 * 1024 + 1))
        assert (ei.value.status, ei.value.code) == (413, code)


async def test_43_both_routes_bound_what_they_read_before_anything_is_parsed(world, monkeypatch):
    """a body with no length in its header is cut at the limit WHILE it is read: parsing is never reached (made to fail the test if it is)"""
    from app.services import desktop_direct as dd

    def never(*_a, **_k):
        raise AssertionError("a body past the limit reached the parser")

    monkeypatch.setattr(dd, "parse_ask", never)
    monkeypatch.setattr(dd, "parse_answer", never)

    async def chunks():
        yield b'{"padding": "'
        for _ in range(10):
            yield b"x" * 1024
        yield b'"}'

    async with _client() as c:
        device, _a, phone, sid = await _setup(c, "d4993 mac ap")
        r = await c.post(f"/api/v2/desktop/computers/{sid}/direct", content=chunks(), headers={**_person(OWNER), "content-type": "application/json"})
        assert r.status_code == 413 and r.json()["error"]["code"] == "direct_request_too_large", r.text
        monkeypatch.undo()
        cid, _key = await _asked(c, device, sid, phone)
        monkeypatch.setattr(dd, "parse_answer", never)
        r = await c.put(f"/api/v2/desktop/relay/direct/{cid}", content=chunks(), headers={**_tok(device["device_token"]), "content-type": "application/json"})
        assert r.status_code == 413 and r.json()["error"]["code"] == "direct_too_large", r.text


async def test_44_two_presses_of_the_same_key_that_arrive_together_both_get_the_first_command(world, monkeypatch):
    """the second press missed the first look (the first was not committed yet); under the limit locks it asks again and gets the first command — never a «too fast» for a press that is a repeat"""
    from app.core.database import async_session_factory
    from app.services import agent_permissions as ap
    from app.services import desktop_direct as dd

    async with _client() as c:
        _d, _a, phone, sid = await _setup(c, "d4993 mac aq")
        body = _body(sid, phone)
        real, flipped = ap.paired_phone, []

        async def the_other_press_commits_first(db, **kw):
            if not flipped:
                flipped.append(1)  # once: after this press looked for an earlier one and found none, the same press (a double tap) is taken and committed by another request
                async with async_session_factory() as other:
                    member = (await _sql(fetch=f"SELECT id FROM team_members WHERE user_id = '{OWNER}' AND org_id = (SELECT org_id FROM desktop_setups WHERE id = '{sid}') LIMIT 1"))[0][0]
                    await dd.create_ask(other, member_id=member, user_id=OWNER, org_id=await _org(sid), setup_id=uuid.UUID(str(sid)), body=dd.OpenRequest(**body))
                    await other.commit()
            return await real(db, **kw)

        monkeypatch.setattr(ap, "paired_phone", the_other_press_commits_first)
        r = await _ask(c, sid, body)
        assert r.status_code == 201, r.text
        assert len([x for x in await _commands(sid) if x[0] == "direct_open"]) == 1
        assert len(await _rows(sid)) == 1 and str((await _rows(sid))[0][0]) == r.json()["command_id"]


async def test_45_an_answer_is_judged_by_the_pairing_as_it_stands_not_as_the_sign_in_loaded_it(world, monkeypatch):
    """the computer's sign-in loads its row first; a re-pairing that commits after that and before the answer is judged still refuses the old viewer's answer"""
    from app.services import desktop_direct as dd

    async with _client() as c:
        device, _a, phone, sid = await _setup(c, "d4993 mac ar")
        cid, key = await _asked(c, device, sid, phone)
        real, flipped = dd.purge_expired, []

        async def re_paired_meanwhile(db, **kw):
            out = await real(db, **kw)
            if not flipped:
                flipped.append(1)
                await _sql(f"UPDATE desktop_setups SET confirmed_by = '{PLAIN}' WHERE id = '{sid}'")
            return out

        monkeypatch.setattr(dd, "purge_expired", re_paired_meanwhile)
        r = await _put(c, device, cid, _answer_env(sid, key))
        assert (r.status_code, r.json()["error"]["code"]) == (409, "direct_viewer_gone"), r.text
        assert await _rows(sid) == []
