"""story 4983 (P5 · phone ↔ host project files, layer 3) — a person's SEALED request to list a folder of a project on their own computer, and the computer's SEALED answer: the `file_list` command word, the short-lived
read row, who may ask and read, the header rules, the limits, and what goes with a disconnect. The server holds envelopes only — never a name, a path or a word of what a folder holds. Each test goes red without the line it names."""
from __future__ import annotations

import logging
import uuid

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

MARK = "ZQ9-FILES-LEAK-MARKER"  # what must never reach a log line


async def _setup(c, name):
    """A computer of the owner's with the owner's phone paired and one agent; → (device, agent, phone, setup id, a project the owner can open)."""
    device, agent, phone, _der, _conv = await _world(c, name)
    sid = (await _sql(fetch=f"SELECT id FROM desktop_setups WHERE device_name = '{name}'"))[0][0]
    project = (await _sql(fetch=f"SELECT project_id FROM agent_project_profiles WHERE member_id = '{agent}' LIMIT 1"))[0][0]
    return device, agent, phone, sid, project


def _env(sid, key, project, *, kind="file_list", **over):
    over.setdefault("session_key", f"file:{project}")
    return sealed_env(sid, key, kind=kind, **over)


def _body(sid, project, phone, key=None, **env_over):
    key = key or str(uuid.uuid4())
    return {"project_id": str(project), "idempotency_key": key, "phone_key_id": phone, "envelope": _env(sid, key, project, **env_over)}


def _ask(c, sid, body, who=OWNER, headers=None):
    return c.post(f"/api/v2/desktop/computers/{sid}/files", json=body, headers=headers or _person(who))


def _get(c, sid, command_id, who=OWNER):
    return c.get(f"/api/v2/desktop/computers/{sid}/files/{command_id}", headers=_person(who))


def _answer_env(sid, key, project, **over):
    return _env(sid, key, project, kind="file_result", **{"from": "host-1", "to": ["phone-1"], "wraps": [{"to": "phone-1", "enc": b64(32), "ek": b64(48)}], **over})


def _put(c, device, command_id, envelope=None, raw=None, headers=None):
    kw = {"content": raw} if raw is not None else {"json": {"envelope": envelope}}
    h = {**_tok(device["device_token"]), **({"content-type": "application/json"} if raw is not None else {})}
    return c.put(f"/api/v2/desktop/relay/files/{command_id}", headers=headers or h, **kw)


async def _delivered(command_id):
    await _sql(f"UPDATE desktop_commands SET state = 'delivered' WHERE id = '{command_id}'")


async def _rows(sid):
    return await _sql(fetch=f"SELECT command_id, viewer_id, project_id, press_key, payload, written_at, expires_at - created_at FROM desktop_file_reads WHERE setup_id = '{sid}'")


async def _age(sid):
    """Let the pause and the poll gap pass without waiting."""
    await _sql(f"UPDATE desktop_commands SET created_at = created_at - interval '10 seconds' WHERE setup_id = '{sid}' AND kind IN ('file_list', 'file_read')")
    await _sql(f"UPDATE desktop_file_reads SET polled_at = NULL, created_at = created_at - interval '10 seconds' WHERE setup_id = '{sid}'")


async def _close(sid):
    await _age(sid)
    await _sql(f"UPDATE desktop_commands SET state = 'done' WHERE setup_id = '{sid}' AND kind IN ('file_list', 'file_read')")


async def _asked(c, device, sid, phone, project, **kw):
    body = _body(sid, project, phone, **kw)
    r = await _ask(c, sid, body)
    assert r.status_code == 201, r.text
    cid = r.json()["command_id"]
    await _delivered(cid)
    return cid, body["idempotency_key"]


async def test_01_an_ask_queues_one_file_list_command_whose_payload_is_only_the_project_and_the_envelope_and_makes_a_ten_minute_row(world):
    async with _client() as c:
        device, _agent, phone, sid, project = await _setup(c, "d4983 mac a")
        body = _body(sid, project, phone)
        r = await _ask(c, sid, body)
        assert r.status_code == 201, r.text
        assert r.headers["cache-control"] == "no-store"
        cid = r.json()["command_id"]
        cmds = [x for x in await _commands(sid) if x[0] == "file_list"]
        assert [(k, set(p), st) for k, p, _by, _key, st in cmds] == [("file_list", {"project_id", "envelope"}, "queued")]  # no session, no path, nothing readable
        assert cmds[0][1]["project_id"] == str(project) and cmds[0][1]["envelope"] == body["envelope"]
        rows = await _rows(sid)
        assert [(str(a), str(b), str(p), key, pl, w) for a, b, p, key, pl, w, _ttl in rows] == [(cid, str(OWNER), str(project), body["idempotency_key"], None, None)]
        from datetime import timedelta
        assert timedelta(minutes=10) <= rows[0][6] < timedelta(minutes=10, seconds=1)


async def test_02_the_envelope_header_must_be_this_presses_own(world):
    async with _client() as c:
        _d, _a, phone, sid, project = await _setup(c, "d4983 mac b")
        key = str(uuid.uuid4())
        old, future = now_ms() - 3_600_000, now_ms() + 3_600_000
        for over in ({"setup_id": str(uuid.uuid4())}, {"session_key": f"file:{uuid.uuid4()}"}, {"session_key": "s-1"}, {"command_id": str(uuid.uuid4())}, {"ts": old, "expires_at": old + 120_000},
                     {"ts": future, "expires_at": future + 120_000}, {"expires_at": now_ms() - 5_000}, {"ts": now_ms() - 120_000, "expires_at": now_ms() - 60_000}, {"expires_at": now_ms() + 3_600_000}):
            body = {"project_id": str(project), "idempotency_key": key, "phone_key_id": phone, "envelope": _env(sid, key, project, **over)}
            r = await _ask(c, sid, body)
            assert r.status_code == 422 and r.json()["error"]["code"] == "envelope_header_mismatch", (over, r.text)
        assert [x for x in await _commands(sid) if x[0] == "file_list"] == []  # none of them was kept


async def test_03_what_is_not_a_files_request_is_refused_by_shape_and_never_echoed(world):
    async with _client() as c:
        _d, _a, phone, sid, project = await _setup(c, "d4983 mac c")
        good = _body(sid, project, phone)
        bad_bodies = [
            {**good, "envelope": {**good["envelope"], "kind": "send_prompt"}},            # another kind of envelope
            {**good, "envelope": {**good["envelope"], "extra": MARK}},                       # not the agreed shape
            {**good, "envelope": {**good["envelope"], "ct": b64(4 * 1024 + 17)}},            # past the size class of a files request
            {**good, "path": f"/etc/{MARK}"},                                              # a path rides along
            {**good, "project_id": "not-a-uuid"},
            {k: v for k, v in good.items() if k != "envelope"},
        ]
        for bad in bad_bodies:
            r = await _ask(c, sid, bad)
            assert r.status_code == 422, (list(bad), r.text)
            assert MARK not in r.text, "a refusal never carries what it was given"
        assert [x for x in await _commands(sid) if x[0] == "file_list"] == []


async def test_04_who_may_ask_the_computers_pairing_person_who_can_open_the_project_with_a_phone_paired_to_it(world):
    async with _client() as c:
        _d, _a, phone, sid, project = await _setup(c, "d4983 mac d")
        for who in (PLAIN,):
            r = await _ask(c, sid, _body(sid, project, phone), who=who)
            assert (r.status_code, r.json()["error"]["code"]) == (403, "not_allowed_to_read_files"), (who, r.text)  # an org member who is not the pairing person: the same answer as «no such computer»
        assert (await _ask(c, sid, _body(sid, project, phone), who=OUTSIDER)).status_code in (403, 404)
        r = await _ask(c, uuid.uuid4(), _body(sid, project, phone))
        assert r.status_code == 403 and r.json()["error"]["code"] == "not_allowed_to_read_files", "a computer that is no one's looks like a computer that is not yours"
        r = await _ask(c, sid, _body(sid, uuid.uuid4(), phone))
        assert r.status_code == 404 and "project_not_found" in r.text
        r = await _ask(c, sid, _body(sid, project, str(uuid.uuid4())))
        assert r.status_code == 409 and r.json()["error"]["code"] == "phone_not_paired"
        assert [x for x in await _commands(sid) if x[0] == "file_list"] == []
        assert (await _ask(c, sid, _body(sid, project, phone))).status_code == 201


async def test_05_the_same_press_key_gives_back_the_first_command_not_a_second(world):
    async with _client() as c:
        _d, _a, phone, sid, project = await _setup(c, "d4983 mac e")
        body = _body(sid, project, phone)
        first = await _ask(c, sid, body)
        again = await _ask(c, sid, body)
        assert first.status_code == 201 and again.status_code == 201 and first.json() == again.json()
        assert len([x for x in await _commands(sid) if x[0] == "file_list"]) == 1


async def test_06_limits_one_ask_a_second_per_person_and_one_open_request_per_computer(world):
    async with _client() as c:
        device, _a, phone, sid, project = await _setup(c, "d4983 mac f")
        assert (await _ask(c, sid, _body(sid, project, phone))).status_code == 201
        r = await _ask(c, sid, _body(sid, project, phone))
        assert r.status_code == 429 and r.json()["error"]["code"] == "files_too_fast"
        await _age(sid)
        r = await _ask(c, sid, _body(sid, project, phone))
        assert r.status_code == 409 and r.json()["error"]["code"] == "files_busy", "the first is still open"
        await _close(sid)
        assert (await _ask(c, sid, _body(sid, project, phone))).status_code == 201


async def test_07_the_computer_answers_once_and_only_to_this_request(world):
    async with _client() as c:
        device, _a, phone, sid, project = await _setup(c, "d4983 mac g")
        r = await _ask(c, sid, _body(sid, project, phone))
        cid, key = r.json()["command_id"], (await _rows(sid))[0][3]
        ans = _answer_env(sid, key, project)
        assert (await _put(c, device, cid, ans)).status_code == 409, "the command is still queued: not open"
        await _delivered(cid)
        for over in ({"setup_id": str(uuid.uuid4())}, {"session_key": f"file:{uuid.uuid4()}"}, {"command_id": str(uuid.uuid4())}, {"expires_at": now_ms() - 5_000}):
            r = await _put(c, device, cid, _answer_env(sid, key, project, **over))
            assert r.status_code == 422 and r.json()["error"]["code"] == "envelope_header_mismatch", over
        assert (await _rows(sid))[0][4] is None, "none of them was kept"
        assert (await _put(c, device, cid, _env(sid, key, project, kind="approval_card"))).status_code == 422, "the kind of an answer is file_result"
        assert (await _put(c, device, cid, _env(sid, key, project, kind="file_list"))).status_code == 422, "a request is not an answer"
        ok = await _put(c, device, cid, ans)
        assert ok.status_code == 200 and ok.json()["bytes"] > 0, ok.text
        assert (await _put(c, device, cid, _answer_env(sid, key, project))).status_code == 409, "written ONCE"
        rows = await _rows(sid)
        assert rows[0][4] == {"envelope": ans} and rows[0][5] is not None


async def test_08_an_answer_from_another_computer_or_for_a_command_that_is_not_a_files_request_is_not_found_and_too_large_is_refused_unparsed(world):
    async with _client() as c:
        device, _a, phone, sid, project = await _setup(c, "d4983 mac h")
        other, _a2, _p2, _sid2, _pr2 = await _setup(c, "d4983 mac h2")
        cid, key = await _asked(c, device, sid, phone, project)
        r = await _put(c, other, cid, _answer_env(sid, key, project))
        assert r.status_code == 404 and r.json()["error"]["code"] == "files_read_not_found"
        assert (await _put(c, device, uuid.uuid4(), _answer_env(sid, key, project))).status_code == 404
        r = await _put(c, device, cid, raw=b"x" * (400 * 1024 + 1))
        assert r.status_code == 413 and r.json()["error"]["code"] == "files_too_large"
        r = await _put(c, device, cid, raw=('{"envelope": "' + MARK + '"}').encode())
        assert r.status_code == 422 and MARK not in r.text
        r = await _put(c, device, cid, raw=('{"envelope": {}, "extra": "' + MARK + '"}').encode())
        assert r.status_code == 422 and MARK not in r.text


async def test_09_the_person_reads_the_sealed_answer_once_and_nobody_else_ever(world):
    async with _client() as c:
        device, _a, phone, sid, project = await _setup(c, "d4983 mac i")
        cid, key = await _asked(c, device, sid, phone, project)
        r = await _get(c, sid, cid)
        assert r.status_code == 200 and r.json() == {"state": "delivered", "code": None, "envelope": None}, "asked, not answered yet"
        ans = _answer_env(sid, key, project)
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
        device, _a, phone, sid, project = await _setup(c, "d4983 mac j")
        cid, _key = await _asked(c, device, sid, phone, project)
        await _sql(f"UPDATE desktop_commands SET state = 'rejected', result_code = 'envelope_replay' WHERE id = '{cid}'")
        await _age(sid)
        r = await _get(c, sid, cid)
        assert r.status_code == 200 and r.json() == {"state": "rejected", "code": "envelope_replay", "envelope": None}
        assert await _rows(sid) == []


async def test_11_a_row_past_its_end_is_gone_and_a_tight_poll_costs_a_429(world):
    async with _client() as c:
        device, _a, phone, sid, project = await _setup(c, "d4983 mac k")
        cid, _key = await _asked(c, device, sid, phone, project)
        assert (await _get(c, sid, cid)).status_code == 200
        r = await _get(c, sid, cid)
        assert r.status_code == 429 and r.json()["error"]["code"] == "files_polled_too_fast"
        await _sql(f"UPDATE desktop_file_reads SET expires_at = now() - interval '1 second' WHERE command_id = '{cid}'")
        assert (await _get(c, sid, cid)).status_code == 404
        assert await _rows(sid) == []


async def test_12_remote_control_turned_off_takes_the_waiting_answers_with_it(world):
    async with _client() as c:
        device, _a, phone, sid, project = await _setup(c, "d4983 mac l")
        cid, key = await _asked(c, device, sid, phone, project)
        assert (await _put(c, device, cid, _answer_env(sid, key, project))).status_code == 200
        await _remote_control_switch(c, False)
        assert await _rows(sid) == [], "no answer stays for a computer that cannot be reached"


async def test_13_a_request_that_waited_past_thirty_seconds_is_never_delivered(world):
    async with _client() as c:
        device, _a, phone, sid, project = await _setup(c, "d4983 mac m")
        from app.core.database import async_session_factory
        from app.services.desktop_relay import commands_to_send

        r = await _ask(c, sid, _body(sid, project, phone))
        cid = r.json()["command_id"]
        await _sql(f"UPDATE desktop_commands SET created_at = now() - interval '31 seconds' WHERE id = '{cid}'")
        async with async_session_factory() as s:
            sent = await commands_to_send(s, uuid.UUID(str(sid)), 0)
            await s.commit()
        assert [x.kind for x in sent if x.kind == "file_list"] == []
        state = (await _sql(fetch=f"SELECT state, result_code FROM desktop_commands WHERE id = '{cid}'"))[0]
        assert tuple(state) == ("rejected", "expired")


async def test_14_no_envelope_or_name_reaches_a_log_line(world, caplog):
    caplog.set_level(logging.DEBUG)
    async with _client() as c:
        device, _a, phone, sid, project = await _setup(c, "d4983 mac n")
        body = _body(sid, project, phone)
        body["envelope"]["ct"] = b64(200) + "AAAA"
        await _ask(c, sid, body)
        await _ask(c, sid, {**body, "extra": MARK})
        assert MARK not in caplog.text and body["envelope"]["ct"] not in caplog.text


async def test_16_a_persons_own_session_only_an_agent_key_is_refused_on_both_roads(world):
    async with _client() as c:
        device, _a, phone, sid, project = await _setup(c, "d4983 mac o")
        cid, key = await _asked(c, device, sid, phone, project)
        agent_key = {"Authorization": f"Bearer {device['agents'][0]['api_key']}", "X-Org-Id": str((await _sql(fetch=f"SELECT org_id FROM desktop_setups WHERE id = '{sid}'"))[0][0])}
        assert (await _ask(c, sid, _body(sid, project, phone), headers=agent_key)).status_code in (401, 403)
        assert (await c.get(f"/api/v2/desktop/computers/{sid}/files/{cid}", headers=agent_key)).status_code in (401, 403)
        assert len([x for x in await _commands(sid) if x[0] == "file_list"]) == 1, "only the person's own ask exists"


async def test_17_the_pairing_is_judged_again_under_the_computers_lock(world, monkeypatch):
    """The first judgment can pass on a computer that is re-paired a moment later; the one under the lock reads the row afresh. This makes that moment (the re-pairing commits after the first read) and the ask is refused all the same."""
    from app.services import agent_permissions as ap

    async with _client() as c:
        _d, _a, phone, sid, project = await _setup(c, "d4983 mac p")
        real = ap.paired_phone

        flipped = []

        async def re_paired_after_the_read(db, **kw):
            out = await real(db, **kw)
            if not flipped:  # once: the re-pairing commits after the FIRST judgment's data was read (the second one is under the computer's lock)
                flipped.append(1)
                await _sql(f"UPDATE desktop_setups SET confirmed_by = '{PLAIN}' WHERE id = '{sid}'")
            return out

        monkeypatch.setattr(ap, "paired_phone", re_paired_after_the_read)
        r = await _ask(c, sid, _body(sid, project, phone))
        assert (r.status_code, r.json()["error"]["code"]) == (403, "not_allowed_to_read_files")
        assert [x for x in await _commands(sid) if x[0] == "file_list"] == [] and await _rows(sid) == []


async def test_18_the_limits_are_counted_under_advisory_locks_taken_by_the_shared_helper(world):
    """While another transaction holds the person's key (or the machine's) an ask does not pass; when the key is let go it goes through."""
    import asyncio

    from sqlalchemy import text

    from app.core.database import async_session_factory

    async def blocked_while_held(key, sid, phone, project, c):
        async with async_session_factory() as holder:
            await holder.execute(text("SELECT pg_advisory_xact_lock(hashtext(:k))"), {"k": key})
            task = asyncio.create_task(_ask(c, sid, _body(sid, project, phone)))
            await asyncio.sleep(1.5)
            assert not task.done(), f"an ask went through while {key} was held"
            await holder.commit()
        r = await asyncio.wait_for(task, 20)
        assert r.status_code == 201, r.text

    async with _client() as c:
        _d, _a, phone, sid, project = await _setup(c, "d4983 mac q")
        await _sql(f"UPDATE desktop_setups SET machine_key = 'mk-4983-lock' WHERE id = '{sid}'")
        org = (await _sql(fetch=f"SELECT org_id FROM desktop_setups WHERE id = '{sid}'"))[0][0]
        await blocked_while_held(f"files-person:{OWNER}", sid, phone, project, c)
        await _close(sid)
        await blocked_while_held(f"files-machine:{org}:mk-4983-lock", sid, phone, project, c)


async def test_19_two_asks_at_once_never_both_pass(world):
    import asyncio

    async with _client() as c:
        _d, _a, phone, sid, project = await _setup(c, "d4983 mac r")
        rs = await asyncio.gather(*(_ask(c, sid, _body(sid, project, phone)) for _ in range(4)))
        assert sorted(r.status_code for r in rs).count(201) == 1, [r.status_code for r in rs]
        assert len([x for x in await _commands(sid) if x[0] == "file_list"]) == 1


async def test_20_a_read_whose_pairing_remote_control_or_line_is_gone_is_not_readable_and_leaves_nothing(world):
    async with _client() as c:
        device, _a, phone, sid, project = await _setup(c, "d4983 mac s")
        cid, key = await _asked(c, device, sid, phone, project)
        assert (await _put(c, device, cid, _answer_env(sid, key, project))).status_code == 200
        await _sql(f"UPDATE desktop_setups SET confirmed_by = '{PLAIN}' WHERE id = '{sid}'")  # re-paired: the old viewer gets nothing, and the row goes
        await _age(sid)
        assert (await _get(c, sid, cid)).status_code == 404
        assert await _rows(sid) == []
        await _sql(f"UPDATE desktop_setups SET confirmed_by = '{OWNER}' WHERE id = '{sid}'")
        await _close(sid)
        cid, key = await _asked(c, device, sid, phone, project)
        assert (await _put(c, device, cid, _answer_env(sid, key, project))).status_code == 200
        r = await c.delete(f"/api/v2/desktop/setups/{sid}", headers=_person(OWNER))  # the computer is disconnected: its answers go and no new ask is taken
        assert r.status_code == 200, r.text
        assert await _rows(sid) == []
        assert (await _get(c, sid, cid)).status_code == 404
        assert (await _ask(c, sid, _body(sid, project, phone))).status_code in (403, 404, 409)
        assert await _rows(sid) == []


async def test_21_a_replaced_line_and_a_reclaimed_account_take_their_answers_too(world):
    from datetime import datetime, timezone

    from app.core.database import async_session_factory
    from app.models.desktop_setup import DesktopSetup
    from app.models.user import User
    from app.routers.auth import _reclaim_unproved_account
    from app.services.desktop_setup import _retire_same_machine

    async with _client() as c:
        device, _a, phone, sid, project = await _setup(c, "d4983 mac t")
        cid, key = await _asked(c, device, sid, phone, project)
        assert (await _put(c, device, cid, _answer_env(sid, key, project))).status_code == 200
        await _sql(f"UPDATE desktop_setups SET machine_key = 'mk-4983' WHERE id = '{sid}'")
        async with async_session_factory() as s:
            setup = await s.get(DesktopSetup, uuid.UUID(str(sid)))
            agents = frozenset(uuid.UUID(str(m["member_id"])) for m in (setup.members or []) if m.get("kind") == "agent")
            assert await _retire_same_machine(s, machine_key="mk-4983", others=[setup], now=datetime.now(timezone.utc), new_agents=agents, before={setup.id: agents}) == 1
            await s.commit()
        assert await _rows(sid) == []
        await _age(sid)  # the person's pause reads their last ask of any computer
        device2, _a2, phone2, sid2, project2 = await _setup(c, "d4983 mac t2")
        cid2, key2 = await _asked(c, device2, sid2, phone2, project2)
        assert (await _put(c, device2, cid2, _answer_env(sid2, key2, project2))).status_code == 200
        await _sql(f"UPDATE users SET email_verified = false WHERE id = '{PLAIN}'", f"UPDATE desktop_setups SET confirmed_by = '{PLAIN}' WHERE id = '{sid2}'")
        assert len(await _rows(sid2)) == 1
        async with async_session_factory() as s:
            user = await s.get(User, PLAIN)
            assert await _reclaim_unproved_account(s, user, why="test 4983") is not None
            await s.commit()
        assert await _rows(sid2) == []


async def test_22_the_minute_sweep_takes_a_row_past_its_end(world):
    from app.core.database import async_session_factory
    from app.services.desktop_files import purge_expired

    async with _client() as c:
        device, _a, phone, sid, project = await _setup(c, "d4983 mac u")
        await _asked(c, device, sid, phone, project)
        await _sql(f"UPDATE desktop_file_reads SET expires_at = now() - interval '1 second' WHERE setup_id = '{sid}'")
        async with async_session_factory() as s:
            assert await purge_expired(s) == 1
            await s.commit()
        assert await _rows(sid) == []


async def test_23_remote_control_off_a_computer_not_heard_from_and_a_seat_that_ended_each_stop_the_ask(world):
    from app.core.database import async_session_factory
    from app.services import desktop_files

    async with _client() as c:
        device, _a, phone, sid, project = await _setup(c, "d4983 mac v")
        await _sql(f"UPDATE organizations SET remote_control_enabled_at = NULL WHERE id = '{await _org(sid)}'")
        r = await _ask(c, sid, _body(sid, project, phone))
        assert r.status_code == 409 and r.json()["error"]["code"] != "files_busy"
        await _sql(f"UPDATE organizations SET remote_control_enabled_at = now() WHERE id = '{await _org(sid)}'")
        await _sql(f"UPDATE desktop_device_tokens SET last_used_at = now() - interval '1 hour' WHERE setup_id = '{sid}'")
        r = await _ask(c, sid, _body(sid, project, phone))
        assert (r.status_code, r.json()["error"]["code"]) == (409, "device_unreachable")
        await _sql(f"UPDATE desktop_device_tokens SET last_used_at = now() WHERE setup_id = '{sid}'")
        # the seat of the pairing person in the organization ended: judged in the service itself (the sign-in layer in front would also refuse it)
        await _sql(f"UPDATE org_members SET deleted_at = now() WHERE user_id = '{OWNER}'")
        async with async_session_factory() as db:
            with pytest.raises(desktop_files.DesktopRelayError) as ei:
                await desktop_files.create_ask(db, member_id=uuid.uuid4(), user_id=OWNER, org_id=await _org(sid), setup_id=uuid.UUID(str(sid)),
                                                body=desktop_files.ListRequest(**_body(sid, project, phone)))
        assert ei.value.status == 403 and ei.value.code == "not_allowed_to_read_files"
        await _sql(f"UPDATE org_members SET deleted_at = NULL WHERE user_id = '{OWNER}'")
        assert [x for x in await _commands(sid) if x[0] == "file_list"] == []


async def _org(sid):
    return (await _sql(fetch=f"SELECT org_id FROM desktop_setups WHERE id = '{sid}'"))[0][0]


async def test_24_an_answer_is_refused_and_its_row_goes_when_the_asker_no_longer_pairs_the_computer_or_the_row_is_past_its_end(world):
    async with _client() as c:
        device, _a, phone, sid, project = await _setup(c, "d4983 mac w")
        cid, key = await _asked(c, device, sid, phone, project)
        await _sql(f"UPDATE desktop_setups SET confirmed_by = '{PLAIN}' WHERE id = '{sid}'")
        r = await _put(c, device, cid, _answer_env(sid, key, project))
        assert (r.status_code, r.json()["error"]["code"]) == (409, "files_viewer_gone")
        assert await _rows(sid) == [], "the refusal's own deletion stays (it is committed)"
        await _sql(f"UPDATE desktop_setups SET confirmed_by = '{OWNER}' WHERE id = '{sid}'")
        await _close(sid)
        cid, key = await _asked(c, device, sid, phone, project)
        await _sql(f"UPDATE desktop_file_reads SET expires_at = now() - interval '1 second' WHERE command_id = '{cid}'")
        assert (await _put(c, device, cid, _answer_env(sid, key, project))).status_code == 404
        assert await _rows(sid) == [], "a refused write past the end deletes the row, and that stays"


async def test_25_a_read_whose_remote_control_is_off_or_whose_command_ended_after_the_answer_is_not_given_and_leaves_nothing(world):
    async with _client() as c:
        device, _a, phone, sid, project = await _setup(c, "d4983 mac x")
        cid, key = await _asked(c, device, sid, phone, project)
        assert (await _put(c, device, cid, _answer_env(sid, key, project))).status_code == 200
        await _sql(f"UPDATE organizations SET remote_control_enabled_at = NULL WHERE id = '{await _org(sid)}'")  # (no forget ran: the read's own judgment)
        await _age(sid)
        assert (await _get(c, sid, cid)).status_code == 404
        assert await _rows(sid) == []
        await _sql(f"UPDATE organizations SET remote_control_enabled_at = now() WHERE id = '{await _org(sid)}'")
        await _close(sid)
        cid, key = await _asked(c, device, sid, phone, project)
        assert (await _put(c, device, cid, _answer_env(sid, key, project))).status_code == 200
        await _sql(f"UPDATE desktop_commands SET state = 'failed', result_code = 'x' WHERE id = '{cid}'")  # the stale rejection that came after the answer was stored
        await _age(sid)
        r = await _get(c, sid, cid)
        assert r.status_code == 200 and r.json() == {"state": "failed", "code": "x", "envelope": None}
        assert await _rows(sid) == []


def test_26b_an_ask_body_is_judged_by_size_before_it_is_parsed():
    from app.services.desktop_files import ASK_BODY_MAX, DesktopRelayError, parse_ask

    with pytest.raises(DesktopRelayError) as ei:
        parse_ask(b"x" * (ASK_BODY_MAX + 1))
    assert ei.value.status == 413


def test_26_the_answer_body_is_judged_by_size_before_it_is_parsed_and_an_error_never_carries_it():
    from app.services.desktop_files import ANSWER_BODY_MAX, DesktopRelayError, parse_answer

    with pytest.raises(DesktopRelayError) as ei:
        parse_answer(b"x" * (ANSWER_BODY_MAX + 1))
    assert ei.value.status == 413
    with pytest.raises(DesktopRelayError) as ei:
        parse_answer(('{"envelope": "' + MARK + '"}').encode())
    assert ei.value.status == 422 and MARK not in ei.value.message


async def test_27_a_persons_api_key_is_refused_on_both_roads_like_an_agents(world):
    from app.core.security import create_access_token

    async with _client() as c:
        device, _a, phone, sid, project = await _setup(c, "d4983 mac y")
        cid, _key = await _asked(c, device, sid, phone, project)
        org = await _org(sid)
        tok = create_access_token(user_id=str(OWNER), app_metadata={"human_api_key_id": str(uuid.uuid4())})
        keyed = {"Authorization": f"Bearer {tok}", "X-Org-Id": str(org)}
        r = await _ask(c, sid, _body(sid, project, phone), headers=keyed)
        assert r.status_code == 403 and "person_session_required" in r.text, r.text
        r = await c.get(f"/api/v2/desktop/computers/{sid}/files/{cid}", headers=keyed)
        assert r.status_code == 403 and "person_session_required" in r.text, r.text


async def test_28_the_minute_job_sweeps_the_files_rows_too(world, monkeypatch):
    from httpx import ASGITransport, AsyncClient

    from app.main import app
    from app.routers import cron as cron_module

    monkeypatch.setattr(cron_module, "CRON_SECRET", "test-cron-secret")
    async with _client() as c:
        device, _a, phone, sid, project = await _setup(c, "d4983 mac z")
        await _asked(c, device, sid, phone, project)
        await _sql(f"UPDATE desktop_file_reads SET expires_at = now() - interval '1 second' WHERE setup_id = '{sid}'")
    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as client:
        r = await client.post("/api/v2/internal/cron/changes-purge", headers={"Authorization": "Bearer test-cron-secret"})
    assert r.status_code == 200 and r.json()["data"]["files_purged"] == 1, r.text
    assert await _rows(sid) == []


async def test_29_a_person_who_lost_the_project_since_the_ask_is_not_given_the_answer_and_the_row_goes(world, monkeypatch):
    from app.services import project_auth

    async with _client() as c:
        device, _a, phone, sid, project = await _setup(c, "d4983 mac aa")
        cid, key = await _asked(c, device, sid, phone, project)
        assert (await _put(c, device, cid, _answer_env(sid, key, project))).status_code == 200
        await _age(sid)

        async def no_access(*a, **kw):
            return False

        monkeypatch.setattr(project_auth, "has_project_access", no_access)
        assert (await _get(c, sid, cid)).status_code == 404
        assert await _rows(sid) == []


async def test_30_an_ask_is_judged_by_size_before_it_is_parsed_whatever_the_header_said(world):
    async with _client() as c:
        _d, _a, phone, sid, project = await _setup(c, "d4983 mac ab")
        big = {**_body(sid, project, phone), "padding": "x" * (16 * 1024)}
        r = await _ask(c, sid, big)
        assert r.status_code == 413 and r.json()["error"]["code"] == "files_request_too_large"

        async def chunks():  # no content-length: the stream itself is bounded
            yield b'{"padding": "'
            for _ in range(20):
                yield b"x" * 1024
            yield b'"}'

        r = await c.post(f"/api/v2/desktop/computers/{sid}/files", content=chunks(), headers={**_person(OWNER), "content-type": "application/json"})
        assert r.status_code == 413 and r.json()["error"]["code"] == "files_request_too_large"
        assert [x for x in await _commands(sid) if x[0] == "file_list"] == []


async def test_31_an_answer_must_be_fresh_a_stale_future_or_long_lived_envelope_is_refused(world):
    async with _client() as c:
        device, _a, phone, sid, project = await _setup(c, "d4983 mac ac")
        cid, key = await _asked(c, device, sid, phone, project)
        old, future = now_ms() - 3_600_000, now_ms() + 3_600_000
        for over in ({"ts": old, "expires_at": now_ms() + 60_000}, {"ts": future, "expires_at": future + 60_000}, {"expires_at": now_ms() + 3_600_000},
                     {"ts": now_ms() + 60_000, "expires_at": now_ms() + 30_000}, {"ts": now_ms() - 120_000, "expires_at": now_ms() - 60_000}):
            r = await _put(c, device, cid, _answer_env(sid, key, project, **over))
            assert r.status_code == 422 and r.json()["error"]["code"] == "envelope_header_mismatch", over
        assert (await _rows(sid))[0][4] is None
        assert (await _put(c, device, cid, _answer_env(sid, key, project, expires_at=now_ms() + 600_000))).status_code == 200, "the ten minutes the host gives an answer pass"


async def test_32_two_looks_that_arrive_together_cannot_both_pass_the_poll_gap(world):
    import asyncio

    async with _client() as c:
        device, _a, phone, sid, project = await _setup(c, "d4983 mac ad")
        cid, _key = await _asked(c, device, sid, phone, project)
        rs = await asyncio.gather(*(_get(c, sid, cid) for _ in range(4)))
        assert sorted(r.status_code for r in rs).count(200) == 1, [r.status_code for r in rs]


async def test_33_a_full_size_legal_answer_is_taken_and_one_past_the_envelope_cap_is_not(world):
    async with _client() as c:
        device, _a, phone, sid, project = await _setup(c, "d4983 mac ae")
        cid, key = await _asked(c, device, sid, phone, project)
        full = _answer_env(sid, key, project, ct=b64(256 * 1024 + 16))
        ok = await _put(c, device, cid, full)
        assert ok.status_code == 200, ok.text[:200]
        await _close(sid)
        cid, key = await _asked(c, device, sid, phone, project)
        r = await _put(c, device, cid, _answer_env(sid, key, project, ct=b64(256 * 1024 + 17)))
        assert r.status_code == 422


async def test_34_a_look_that_waited_for_the_lock_past_the_rows_end_is_not_given(world, monkeypatch):
    """the look checked the row's end before the lock; while it waited, the end passed: it is judged again after the lock"""
    from app.core.database import async_session_factory
    from app.services import desktop_files as df

    async with _client() as c:
        device, _a, phone, sid, project = await _setup(c, "d4983 mac af")
        cid, key = await _asked(c, device, sid, phone, project)
        assert (await _put(c, device, cid, _answer_env(sid, key, project))).status_code == 200
        await _age(sid)
        real = df._now
        calls = []

        def later():
            calls.append(1)
            from datetime import timedelta
            return real() + (timedelta(minutes=11) if len(calls) > 1 else timedelta(0))  # the first reading of the clock is now; the later ones are past the end

        monkeypatch.setattr(df, "_now", later)
        async with async_session_factory() as db:
            with pytest.raises(df.DesktopRelayError) as ei:
                await df.read_answer(db, user_id=OWNER, org_id=await _org(sid), setup_id=uuid.UUID(str(sid)), command_id=uuid.UUID(str(cid)))
            await db.commit()
        assert ei.value.status == 404
        monkeypatch.setattr(df, "_now", real)
        assert await _rows(sid) == []


async def test_35_the_phone_pairing_is_held_under_the_computers_lock(world):
    """a pairing removal that comes while an ask holds the phone's rows waits for the ask (a share lock held to the commit)"""
    import asyncio

    from sqlalchemy import text

    from app.core.database import async_session_factory

    async with _client() as c:
        _d, _a, phone, sid, project = await _setup(c, "d4983 mac ag")
        async with async_session_factory() as holder:  # another transaction wants to change the pairing: it takes the row for update
            await holder.execute(text("SELECT 1 FROM remote_device_pairings WHERE setup_id = :s FOR UPDATE"), {"s": str(sid)})
            task = asyncio.create_task(_ask(c, sid, _body(sid, project, phone)))
            await asyncio.sleep(1.5)
            assert not task.done(), "the ask went through while the pairing row was held for change"
            await holder.commit()
        r = await asyncio.wait_for(task, 20)
        assert r.status_code == 201, r.text


def test_15_the_command_words_of_the_code_and_the_migration_are_the_same():
    from importlib import util
    from pathlib import Path

    from app.models.desktop_relay import COMMAND_KINDS

    # the CHECK as the LATEST migration that changed it leaves it (0492 added `file_download`): the code's words and that migration's are the same
    spec = util.spec_from_file_location("m0492", Path(__file__).parent.parent / "alembic" / "versions" / "0492_desktop_file_download.py")
    mod = util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    assert tuple(mod._NEW) == tuple(COMMAND_KINDS) and "file_list" in COMMAND_KINDS and "file_read" in COMMAND_KINDS and "file_download" in COMMAND_KINDS
    assert tuple(mod._OLD) + ("file_download",) == tuple(COMMAND_KINDS), "0492 adds exactly one word to what 0491 left"
    spec = util.spec_from_file_location("m0491", Path(__file__).parent.parent / "alembic" / "versions" / "0491_desktop_file_read_kind.py")
    old = util.module_from_spec(spec)
    spec.loader.exec_module(old)
    assert tuple(old._NEW) == tuple(mod._OLD) and tuple(old._OLD) + ("file_read",) == tuple(old._NEW), "0491 adds exactly one word to what 0488 left, and 0492 starts where 0491 ended"
