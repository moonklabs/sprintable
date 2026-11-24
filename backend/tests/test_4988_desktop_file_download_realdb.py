"""story 4988 (P8 · phone ↔ host project files) — DOWNLOADING one file: the `file_download` command word (0492), the unread SEALED chunks of its answer (`desktop_file_chunks`, hanging from the request's row), and the rules that keep the
server's part small: chunks are put and read IN ORDER and ONCE, the computer may be at most four chunks ahead of the phone, a chunk is gone the moment it is read, and every end of the request's row takes its chunks with it. The server holds
envelopes only — never a name, a path or a byte of a file. Each test goes red without the line it names."""
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
from tests.test_4534_desktop_commands_realdb import _commands, _remote_control_on  # noqa: F401
from tests.test_4535_org_remote_control_realdb import _switch as _remote_control_switch  # noqa: F401
from tests.test_4976_sealed_prompt_realdb import b64, now_ms
from tests.test_4983_desktop_files_realdb import (  # the road's own helpers
    MARK,
    _answer_env,
    _ask,
    _body,
    _delivered,
    _env,
    _get,
    _org,
    _rows,
    _setup,
)

pytestmark = pytest.mark.anyio

CHUNKS_MAX = 57
AHEAD = 4


def _dl_body(sid, project, phone, key=None, **over):
    return _body(sid, project, phone, key=key, kind="file_download", **over)


def _chunk_env(sid, key, project, **over):
    return _answer_env(sid, key, project, **over)


async def _age_dl(sid):
    """Let the pause and the poll gap pass without waiting."""
    await _sql(f"UPDATE desktop_commands SET created_at = created_at - interval '10 seconds' WHERE setup_id = '{sid}' AND kind IN ('file_list', 'file_read', 'file_download')")
    await _sql(f"UPDATE desktop_file_reads SET polled_at = NULL, created_at = created_at - interval '10 seconds' WHERE setup_id = '{sid}'")


async def _close_dl(sid):
    await _age_dl(sid)
    await _sql(f"UPDATE desktop_commands SET state = 'done' WHERE setup_id = '{sid}' AND kind IN ('file_list', 'file_read', 'file_download')")


async def _asked_dl(c, sid, phone, project):
    body = _dl_body(sid, project, phone)
    r = await _ask(c, sid, body)
    assert r.status_code == 201, r.text
    cid = r.json()["command_id"]
    await _delivered(cid)
    return cid, body["idempotency_key"]


def _put_chunk(c, device, cid, i, envelope=None, raw=None, headers=None):
    kw = {"content": raw} if raw is not None else {"json": {"envelope": envelope}}
    h = {**_tok(device["device_token"]), **({"content-type": "application/json"} if raw is not None else {})}
    return c.put(f"/api/v2/desktop/relay/files/{cid}/chunks/{i}", headers=headers or h, **kw)


def _get_chunk(c, sid, cid, i, who=OWNER):
    return c.get(f"/api/v2/desktop/computers/{sid}/files/{cid}/chunks/{i}", headers=_person(who))


async def _chunk_rows(cid):
    return await _sql(fetch=f"SELECT i FROM desktop_file_chunks WHERE command_id = '{cid}' ORDER BY i")


async def _counters(cid):
    r = (await _sql(fetch=f"SELECT chunks_written, chunks_read FROM desktop_file_reads WHERE command_id = '{cid}'"))
    return tuple(r[0]) if r else None


async def _all_chunk_rows():
    return await _sql(fetch="SELECT count(*) FROM desktop_file_chunks")


async def test_01_an_ask_with_a_file_download_envelope_queues_a_file_download_command_with_only_the_project_and_the_envelope_and_both_counters_at_zero(world):
    async with _client() as c:
        _d, _a, phone, sid, project = await _setup(c, "d4988 mac a")
        body = _dl_body(sid, project, phone)
        r = await _ask(c, sid, body)
        assert r.status_code == 201, r.text
        cid = r.json()["command_id"]
        cmds = [x for x in await _commands(sid) if x[0] == "file_download"]
        assert [(k, set(p), st) for k, p, _by, _key, st in cmds] == [("file_download", {"project_id", "envelope"}, "queued")]  # no name, no path
        assert [x for x in await _commands(sid) if x[0] in ("file_list", "file_read")] == [], "the kind of the command is the envelope's own"
        assert await _counters(cid) == (0, 0)
        assert (await _rows(sid))[0][4] is None
        # a request is a short list of names: the same 4 KiB cap as an open's
        big = _dl_body(sid, project, phone)
        big["envelope"]["ct"] = b64(4 * 1024 + 17)
        assert (await _ask(c, sid, big)).status_code == 422


async def test_02_a_download_is_answered_in_chunks_only_the_one_answer_road_is_closed_for_it(world):
    async with _client() as c:
        device, _a, phone, sid, project = await _setup(c, "d4988 mac b")
        cid, key = await _asked_dl(c, sid, phone, project)
        r = await c.put(f"/api/v2/desktop/relay/files/{cid}", headers=_tok(device["device_token"]), json={"envelope": _answer_env(sid, key, project)})
        assert r.status_code == 409 and r.json()["error"]["code"] == "files_use_chunks"
        assert (await _rows(sid))[0][4] is None, "nothing was kept"
        await _age_dl(sid)
        assert (await _get(c, sid, cid)).status_code == 404, "the one-answer read is not the road of a download"
        assert (await _put_chunk(c, device, cid, 0, _chunk_env(sid, key, project))).status_code == 200


async def test_03_the_computer_puts_chunk_i_only_into_its_own_open_download_in_order_once_each_and_only_with_this_requests_header(world):
    async with _client() as c:
        device, _a, phone, sid, project = await _setup(c, "d4988 mac c")
        other, _a2, _p2, _sid2, _pr2 = await _setup(c, "d4988 mac c2")
        body = _dl_body(sid, project, phone)
        cid = (await _ask(c, sid, body)).json()["command_id"]
        key = body["idempotency_key"]
        ok_env = _chunk_env(sid, key, project)
        assert (await _put_chunk(c, device, cid, 0, ok_env)).status_code == 409, "the command is still queued: not open"
        await _delivered(cid)
        r = await _put_chunk(c, device, cid, 1, ok_env)
        assert r.status_code == 409 and r.json()["error"]["code"] == "files_chunk_out_of_order", "chunk 1 before chunk 0"
        for over in ({"setup_id": str(uuid.uuid4())}, {"session_key": f"file:{uuid.uuid4()}"}, {"command_id": str(uuid.uuid4())}, {"expires_at": now_ms() - 5_000}):
            r = await _put_chunk(c, device, cid, 0, _chunk_env(sid, key, project, **over))
            assert r.status_code == 422 and r.json()["error"]["code"] == "envelope_header_mismatch", over
        assert await _chunk_rows(cid) == [], "none of them was kept"
        assert (await _put_chunk(c, device, cid, 0, _env(sid, key, project, kind="approval_card"))).status_code == 422, "the kind of a chunk is file_result"
        assert (await _put_chunk(c, device, cid, 0, _env(sid, key, project, kind="file_list"))).status_code == 422, "a request is not an answer"
        r = await _put_chunk(c, other, cid, 0, ok_env)
        assert r.status_code == 404 and r.json()["error"]["code"] == "files_read_not_found", "another computer's token"
        assert (await _put_chunk(c, device, uuid.uuid4(), 0, ok_env)).status_code == 404
        ok = await _put_chunk(c, device, cid, 0, ok_env)
        assert ok.status_code == 200 and ok.json()["bytes"] > 0, ok.text
        assert await _chunk_rows(cid) == [(0,)] and await _counters(cid) == (1, 0)
        assert (await _put_chunk(c, device, cid, 0, _chunk_env(sid, key, project))).status_code == 409, "once"
        assert (await _put_chunk(c, device, cid, 2, _chunk_env(sid, key, project))).status_code == 409, "a hole"
        assert (await _put_chunk(c, device, cid, CHUNKS_MAX, _chunk_env(sid, key, project))).status_code == 422, "no such place in a download"
        assert (await _put_chunk(c, device, cid, -1, _chunk_env(sid, key, project))).status_code == 422
        assert await _chunk_rows(cid) == [(0,)]


async def test_04_a_chunk_is_the_computers_to_put_only_for_a_download_a_list_or_an_open_has_no_chunks(world):
    async with _client() as c:
        device, _a, phone, sid, project = await _setup(c, "d4988 mac d")
        body = _body(sid, project, phone, kind="file_list")
        cid = (await _ask(c, sid, body)).json()["command_id"]
        await _delivered(cid)
        r = await _put_chunk(c, device, cid, 0, _chunk_env(sid, body["idempotency_key"], project))
        assert r.status_code == 404, "a list's command is not a download"
        await _age_dl(sid)
        assert (await _get_chunk(c, sid, cid, 0)).status_code == 404


async def test_05_the_computer_may_be_at_most_four_chunks_ahead_of_the_phone_and_a_read_makes_room(world):
    async with _client() as c:
        device, _a, phone, sid, project = await _setup(c, "d4988 mac e")
        cid, key = await _asked_dl(c, sid, phone, project)
        for i in range(AHEAD):
            assert (await _put_chunk(c, device, cid, i, _chunk_env(sid, key, project))).status_code == 200, i
        r = await _put_chunk(c, device, cid, AHEAD, _chunk_env(sid, key, project))
        assert r.status_code == 409 and r.json()["error"]["code"] == "files_chunks_ahead", "the fifth unread chunk"
        assert r.json()["error"].get("detail", {}).get("retry_after") == 1 or "retry_after" in r.text
        assert await _chunk_rows(cid) == [(0,), (1,), (2,), (3,)] and await _counters(cid) == (4, 0)
        got = await _get_chunk(c, sid, cid, 0)
        assert got.status_code == 200
        assert (await _put_chunk(c, device, cid, AHEAD, _chunk_env(sid, key, project))).status_code == 200, "one was read: one more may come"
        r = await _put_chunk(c, device, cid, AHEAD + 1, _chunk_env(sid, key, project))
        assert r.status_code == 409 and r.json()["error"]["code"] == "files_chunks_ahead"
        assert await _chunk_rows(cid) == [(1,), (2,), (3,), (4,)] and await _counters(cid) == (5, 1)


async def test_06_the_person_reads_chunk_i_once_in_order_and_nobody_else_ever_the_chunk_is_gone_the_moment_it_is_read(world):
    async with _client() as c:
        device, _a, phone, sid, project = await _setup(c, "d4988 mac f")
        cid, key = await _asked_dl(c, sid, phone, project)
        envs = [_chunk_env(sid, key, project, ctr=i) for i in range(3)]
        for i, e in enumerate(envs):
            assert (await _put_chunk(c, device, cid, i, e)).status_code == 200
        assert (await _get_chunk(c, sid, cid, 0, who=PLAIN)).status_code in (403, 404), "not the asker"
        assert (await _get_chunk(c, uuid.uuid4(), cid, 0)).status_code == 404, "another computer's id"
        r = await _get_chunk(c, sid, cid, 1)
        assert r.status_code == 409 and r.json()["error"]["code"] == "files_chunk_out_of_order", "chunk 1 before chunk 0"
        assert (await _get_chunk(c, sid, cid, CHUNKS_MAX)).status_code in (404, 422), "no such place"
        got = await _get_chunk(c, sid, cid, 0)
        assert got.status_code == 200 and got.headers["cache-control"] == "no-store"
        assert got.json() == {"state": "ready", "code": None, "envelope": envs[0]}
        assert await _chunk_rows(cid) == [(1,), (2,)], "read once: reading deletes it"
        r = await _get_chunk(c, sid, cid, 0)
        assert r.status_code == 409 and r.json()["error"]["code"] == "files_chunk_out_of_order", "the same chunk twice is not given"
        assert (await _get_chunk(c, sid, cid, 1)).json()["envelope"] == envs[1]
        assert (await _get_chunk(c, sid, cid, 2)).json()["envelope"] == envs[2]
        assert await _chunk_rows(cid) == [] and await _counters(cid) == (3, 3)


async def test_07_a_chunk_not_there_yet_is_where_the_request_stands_and_a_tight_look_costs_a_429_while_a_look_that_finds_a_chunk_never_does(world):
    async with _client() as c:
        device, _a, phone, sid, project = await _setup(c, "d4988 mac g")
        cid, key = await _asked_dl(c, sid, phone, project)
        r = await _get_chunk(c, sid, cid, 0)
        assert r.status_code == 200 and r.json() == {"state": "delivered", "code": None, "envelope": None}
        r = await _get_chunk(c, sid, cid, 0)
        assert r.status_code == 429 and r.json()["error"]["code"] == "files_polled_too_fast", "a second look within the gap"
        assert (await _put_chunk(c, device, cid, 0, _chunk_env(sid, key, project))).status_code == 200
        assert (await _put_chunk(c, device, cid, 1, _chunk_env(sid, key, project))).status_code == 200
        assert (await _get_chunk(c, sid, cid, 0)).status_code == 200, "a chunk is there: no gap applies"
        assert (await _get_chunk(c, sid, cid, 1)).status_code == 200, "…and again straight away"


async def test_08_a_computer_that_ended_without_the_chunk_is_the_answer_and_nothing_is_held(world):
    async with _client() as c:
        device, _a, phone, sid, project = await _setup(c, "d4988 mac h")
        cid, key = await _asked_dl(c, sid, phone, project)
        assert (await _put_chunk(c, device, cid, 0, _chunk_env(sid, key, project))).status_code == 200
        assert (await _get_chunk(c, sid, cid, 0)).status_code == 200
        await _sql(f"UPDATE desktop_commands SET state = 'failed', result_code = 'upload_failed' WHERE id = '{cid}'")
        await _age_dl(sid)
        r = await _get_chunk(c, sid, cid, 1)
        assert r.status_code == 200 and r.json() == {"state": "failed", "code": "upload_failed", "envelope": None}
        assert await _rows(sid) == [] and await _all_chunk_rows() == [(0,)], "the row goes and there is nothing left of the download"
        # a command that is `done` with all its chunks read leaves nothing either once the person is done
        await _close_dl(sid)
        cid2, key2 = await _asked_dl(c, sid, phone, project)
        assert (await _put_chunk(c, device, cid2, 0, _chunk_env(sid, key2, project))).status_code == 200
        await _sql(f"UPDATE desktop_commands SET state = 'done' WHERE id = '{cid2}'")
        await _age_dl(sid)
        assert (await _get_chunk(c, sid, cid2, 0)).status_code == 200
        r = await _get_chunk(c, sid, cid2, 1)
        assert r.status_code == 200 and r.json()["envelope"] is None and r.json()["state"] == "done"
        assert await _rows(sid) == []


async def test_09_the_person_gives_up_or_is_done_and_the_row_and_every_chunk_in_it_go_now_only_the_askers_own_and_the_computer_finds_out_on_its_next_put(world):
    async with _client() as c:
        device, _a, phone, sid, project = await _setup(c, "d4988 mac i")
        cid, key = await _asked_dl(c, sid, phone, project)
        for i in range(3):
            assert (await _put_chunk(c, device, cid, i, _chunk_env(sid, key, project))).status_code == 200
        r = await c.delete(f"/api/v2/desktop/computers/{sid}/files/{cid}", headers=_person(PLAIN))
        assert r.status_code in (200, 403, 404)
        assert len(await _rows(sid)) == 1 and len(await _chunk_rows(cid)) == 3, "another person's delete took nothing"
        assert (await c.delete(f"/api/v2/desktop/computers/{uuid.uuid4()}/files/{cid}", headers=_person(OWNER))).json() == {"deleted": False}
        assert len(await _rows(sid)) == 1, "another computer's id took nothing"
        r = await c.delete(f"/api/v2/desktop/computers/{sid}/files/{cid}", headers=_person(OWNER))
        assert r.status_code == 200 and r.json() == {"deleted": True} and r.headers["cache-control"] == "no-store"
        assert await _rows(sid) == [] and await _chunk_rows(cid) == [], "the chunks went with the row (the foreign key)"
        assert (await c.delete(f"/api/v2/desktop/computers/{sid}/files/{cid}", headers=_person(OWNER))).json() == {"deleted": False}, "again: nothing left, no error"
        r = await _put_chunk(c, device, cid, 3, _chunk_env(sid, key, project))
        assert r.status_code == 404 and r.json()["error"]["code"] == "files_read_not_found", "the computer finds out on its next put"


async def test_10_a_request_past_its_ten_minutes_is_not_readable_not_writable_and_leaves_nothing_chunks_included(world):
    async with _client() as c:
        device, _a, phone, sid, project = await _setup(c, "d4988 mac j")
        cid, key = await _asked_dl(c, sid, phone, project)
        for i in range(2):
            assert (await _put_chunk(c, device, cid, i, _chunk_env(sid, key, project))).status_code == 200
        await _sql(f"UPDATE desktop_file_reads SET expires_at = now() - interval '1 second' WHERE command_id = '{cid}'")
        await _age_dl(sid)
        assert (await _get_chunk(c, sid, cid, 0)).status_code == 404
        assert await _rows(sid) == [] and await _chunk_rows(cid) == [], "an expired read takes its chunks"
        await _close_dl(sid)
        cid, key = await _asked_dl(c, sid, phone, project)
        assert (await _put_chunk(c, device, cid, 0, _chunk_env(sid, key, project))).status_code == 200
        await _sql(f"UPDATE desktop_file_reads SET expires_at = now() - interval '1 second' WHERE command_id = '{cid}'")
        assert (await _put_chunk(c, device, cid, 1, _chunk_env(sid, key, project))).status_code == 404
        assert await _rows(sid) == [] and await _chunk_rows(cid) == [], "a refused write past the end deletes the row and its chunks"


async def test_11_a_read_whose_pairing_remote_control_or_line_is_gone_is_not_readable_and_leaves_nothing_chunks_included(world):
    async with _client() as c:
        device, _a, phone, sid, project = await _setup(c, "d4988 mac k")
        cid, key = await _asked_dl(c, sid, phone, project)
        assert (await _put_chunk(c, device, cid, 0, _chunk_env(sid, key, project))).status_code == 200
        await _sql(f"UPDATE desktop_setups SET confirmed_by = '{PLAIN}' WHERE id = '{sid}'")  # re-paired: the old viewer gets nothing, and the row goes
        await _age_dl(sid)
        assert (await _get_chunk(c, sid, cid, 0)).status_code == 404
        assert await _rows(sid) == [] and await _all_chunk_rows() == [(0,)]
        await _sql(f"UPDATE desktop_setups SET confirmed_by = '{OWNER}' WHERE id = '{sid}'")
        await _close_dl(sid)
        cid, key = await _asked_dl(c, sid, phone, project)
        assert (await _put_chunk(c, device, cid, 0, _chunk_env(sid, key, project))).status_code == 200
        await _sql(f"UPDATE organizations SET remote_control_enabled_at = NULL WHERE id = '{await _org(sid)}'")  # (no forget ran: the read's own judgment)
        await _age_dl(sid)
        assert (await _get_chunk(c, sid, cid, 0)).status_code == 404
        assert await _rows(sid) == [] and await _all_chunk_rows() == [(0,)]
        await _sql(f"UPDATE organizations SET remote_control_enabled_at = now() WHERE id = '{await _org(sid)}'")
        await _close_dl(sid)
        cid, key = await _asked_dl(c, sid, phone, project)
        assert (await _put_chunk(c, device, cid, 0, _chunk_env(sid, key, project))).status_code == 200
        r = await c.delete(f"/api/v2/desktop/setups/{sid}", headers=_person(OWNER))  # the computer is disconnected: its answers go
        assert r.status_code == 200, r.text
        assert await _rows(sid) == [] and await _all_chunk_rows() == [(0,)]
        assert (await _get_chunk(c, sid, cid, 0)).status_code == 404


async def test_12_one_open_request_per_computer_a_download_in_flight_holds_the_slot_and_the_next_ask_waits_for_it(world):
    async with _client() as c:
        device, _a, phone, sid, project = await _setup(c, "d4988 mac l")
        cid, key = await _asked_dl(c, sid, phone, project)
        await _age_dl(sid)
        r = await _ask(c, sid, _body(sid, project, phone))
        assert r.status_code == 409 and r.json()["error"]["code"] == "files_busy"
        await _sql(f"UPDATE desktop_commands SET state = 'done' WHERE id = '{cid}'")
        r = await _ask(c, sid, _body(sid, project, phone))
        assert r.status_code == 201, "the computer's command ended: its slot is free (the unread chunks do not hold it)"


async def test_13_nothing_readable_is_logged_and_a_refusal_never_echoes_the_body(world, caplog):
    caplog.set_level(logging.DEBUG)
    async with _client() as c:
        device, _a, phone, sid, project = await _setup(c, "d4988 mac m")
        cid, key = await _asked_dl(c, sid, phone, project)
        env = _chunk_env(sid, key, project)
        env["ct"] = b64(300)
        assert (await _put_chunk(c, device, cid, 0, env)).status_code == 200
        r = await _put_chunk(c, device, cid, 1, raw=('{"envelope": "' + MARK + '"}').encode())
        assert r.status_code == 422 and MARK not in r.text
        r = await _put_chunk(c, device, cid, 1, raw=('{"envelope": {}, "extra": "' + MARK + '"}').encode())
        assert r.status_code == 422 and MARK not in r.text
        r = await _put_chunk(c, device, cid, 1, raw=b"x" * (400 * 1024 + 1))
        assert r.status_code == 413 and r.json()["error"]["code"] == "files_too_large"
        await _age_dl(sid)
        assert (await _get_chunk(c, sid, cid, 0)).status_code == 200
    logged = "\n".join(rec.getMessage() for rec in caplog.records)
    assert MARK not in logged and env["ct"] not in logged and env["sig"] not in logged
    assert "desktop files chunk read: viewer=" in logged and f"command={cid}" in logged and "i=0" in logged, "ids and counts only"


async def test_14_a_full_size_chunk_envelope_is_taken_and_the_tables_own_checks_hold_the_same_numbers(world):
    async with _client() as c:
        device, _a, phone, sid, project = await _setup(c, "d4988 mac n")
        cid, key = await _asked_dl(c, sid, phone, project)
        full = _chunk_env(sid, key, project)
        full["ct"] = b64(256 * 1024 + 16)  # the padded frame (13 buckets = 208 KiB) and the tag are under it; the server's own cap on a sealed body is the frame cap + the 16-byte tag
        assert (await _put_chunk(c, device, cid, 0, full)).status_code == 200
        over = _chunk_env(sid, key, project)
        over["ct"] = b64(256 * 1024 + 17)
        assert (await _put_chunk(c, device, cid, 1, over)).status_code == 422, "over the envelope cap"
    from sqlalchemy.exc import DBAPIError

    with pytest.raises(DBAPIError):
        await _sql(f"INSERT INTO desktop_file_chunks (command_id, i, payload) VALUES ('{cid}', {CHUNKS_MAX}, '{{}}'::jsonb)")
    with pytest.raises(DBAPIError):
        await _sql(f"UPDATE desktop_file_reads SET chunks_read = 5 WHERE command_id = '{cid}'")  # read ahead of written
    with pytest.raises(DBAPIError):
        await _sql(f"UPDATE desktop_file_reads SET chunks_written = {CHUNKS_MAX + 1} WHERE command_id = '{cid}'")


async def test_15_a_chunk_cannot_be_put_by_a_device_for_a_row_of_another_viewer_or_a_row_that_is_not_its_own_and_the_outsider_gets_nothing(world):
    async with _client() as c:
        device, _a, phone, sid, project = await _setup(c, "d4988 mac o")
        cid, key = await _asked_dl(c, sid, phone, project)
        assert (await _put_chunk(c, device, cid, 0, _chunk_env(sid, key, project), headers={"x-nothing": "1"})).status_code in (401, 403), "no token"
        assert (await _get_chunk(c, sid, cid, 0, who=OUTSIDER)).status_code in (403, 404)
        assert (await c.get(f"/api/v2/desktop/computers/{sid}/files/{cid}/chunks/0")).status_code in (401, 403), "no session"
        assert (await _rows(sid))[0][1] == OWNER


async def test_16_a_download_that_waited_past_thirty_seconds_is_never_delivered(world):
    async with _client() as c:
        _d, _a, phone, sid, project = await _setup(c, "d4988 mac p")
        from app.core.database import async_session_factory
        from app.services.desktop_relay import commands_to_send

        cid = (await _ask(c, sid, _dl_body(sid, project, phone))).json()["command_id"]
        await _sql(f"UPDATE desktop_commands SET created_at = now() - interval '31 seconds' WHERE id = '{cid}'")
        async with async_session_factory() as s:
            sent = await commands_to_send(s, uuid.UUID(str(sid)), 0)
            await s.commit()
        assert [x.kind for x in sent if x.kind == "file_download"] == []
        assert tuple((await _sql(fetch=f"SELECT state, result_code FROM desktop_commands WHERE id = '{cid}'"))[0]) == ("rejected", "expired")


async def test_17_a_person_who_lost_the_project_or_the_seat_since_the_ask_is_not_given_a_chunk_and_the_row_and_its_chunks_go(world, monkeypatch):
    from app.services import project_auth

    async with _client() as c:
        device, _a, phone, sid, project = await _setup(c, "d4988 mac q")
        cid, key = await _asked_dl(c, sid, phone, project)
        assert (await _put_chunk(c, device, cid, 0, _chunk_env(sid, key, project))).status_code == 200
        await _age_dl(sid)

        async def no_access(*a, **kw):
            return False

        monkeypatch.setattr(project_auth, "has_project_access", no_access)
        assert (await _get_chunk(c, sid, cid, 0)).status_code == 404
        assert await _rows(sid) == [] and await _all_chunk_rows() == [(0,)]
        monkeypatch.undo()
        await _close_dl(sid)
        cid, key = await _asked_dl(c, sid, phone, project)
        assert (await _put_chunk(c, device, cid, 0, _chunk_env(sid, key, project))).status_code == 200
        await _age_dl(sid)
        from app.services import desktop_commands

        async def no_seat(*a, **kw):
            return None

        monkeypatch.setattr(desktop_commands, "org_role", no_seat)
        assert (await _get_chunk(c, sid, cid, 0)).status_code == 404
        assert await _rows(sid) == [] and await _all_chunk_rows() == [(0,)]


async def test_18_a_computer_that_no_longer_pairs_the_asker_cannot_put_more_chunks_the_row_and_its_chunks_go(world):
    async with _client() as c:
        device, _a, phone, sid, project = await _setup(c, "d4988 mac r")
        cid, key = await _asked_dl(c, sid, phone, project)
        assert (await _put_chunk(c, device, cid, 0, _chunk_env(sid, key, project))).status_code == 200
        await _sql(f"UPDATE desktop_setups SET confirmed_by = '{PLAIN}' WHERE id = '{sid}'")  # re-paired by another person
        r = await _put_chunk(c, device, cid, 1, _chunk_env(sid, key, project))
        assert r.status_code == 409 and r.json()["error"]["code"] == "files_viewer_gone"
        assert await _rows(sid) == [] and await _all_chunk_rows() == [(0,)], "a refused write deletes the row, and its chunks with it"


def test_19_the_numbers_are_held_together_in_the_code_the_migration_and_the_route():
    import pathlib
    from importlib import util

    from app.models.desktop_relay import DesktopFileChunk, DesktopFileRead
    from app.services.desktop_files import CHUNKS_AHEAD_MAX, CHUNKS_MAX

    assert (CHUNKS_MAX, CHUNKS_AHEAD_MAX) == (57, 4), "the contract's chunks_max and chunks_ahead_max"
    root = pathlib.Path(__file__).resolve().parents[1]
    spec = util.spec_from_file_location("m0492", root / "alembic" / "versions" / "0492_desktop_file_download.py")
    mod = util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    assert mod.CHUNKS_MAX == CHUNKS_MAX
    assert (root / "app" / "routers" / "desktop_relay.py").read_text(encoding="utf-8").count(f"i: int = Path(ge=0, lt={CHUNKS_MAX})") == 1, "the computer's route bounds the place by the same number (the module cannot import the service: a lazy import there)"
    checks = {str(c.name): str(c.sqltext) for t in (DesktopFileRead.__table__, DesktopFileChunk.__table__) for c in t.constraints if getattr(c, "sqltext", None) is not None}
    assert f"chunks_written <= {CHUNKS_MAX}" in checks["ck_desktop_file_reads_chunks"] and f"i < {CHUNKS_MAX}" in checks["ck_desktop_file_chunks_i"], "the model says the same numbers as the migration"
    assert (root / "app" / "routers" / "desktop_files.py").read_text(encoding="utf-8").count("lt=desktop_files.CHUNKS_MAX") == 1


async def test_20_the_delete_is_for_downloads_only_a_lists_or_an_opens_answer_is_not_this_routes_to_delete(world):
    async with _client() as c:
        device, _a, phone, sid, project = await _setup(c, "d4988 mac s")
        body = _body(sid, project, phone, kind="file_list")
        cid = (await _ask(c, sid, body)).json()["command_id"]
        await _delivered(cid)
        r = await c.delete(f"/api/v2/desktop/computers/{sid}/files/{cid}", headers=_person(OWNER))
        assert r.status_code == 200 and r.json() == {"deleted": False}, "the list's row is not a download's"
        assert len(await _rows(sid)) == 1, "…and it is still there"
        await _close_dl(sid)
        cid2, _key = await _asked_dl(c, sid, phone, project)
        assert (await c.delete(f"/api/v2/desktop/computers/{sid}/files/{cid2}", headers=_person(OWNER))).json() == {"deleted": True}


async def test_21_a_person_who_asks_again_replaces_their_earlier_download_that_ended_with_unread_chunks_but_never_one_that_is_still_open(world):
    async with _client() as c:
        device, _a, phone, sid, project = await _setup(c, "d4988 mac t")
        cid, key = await _asked_dl(c, sid, phone, project)
        for i in range(AHEAD):
            assert (await _put_chunk(c, device, cid, i, _chunk_env(sid, key, project))).status_code == 200
        await _age_dl(sid)
        r = await _ask(c, sid, _dl_body(sid, project, phone))
        assert r.status_code == 409 and r.json()["error"]["code"] == "files_busy", "the first download is still open: not touched"
        assert len(await _chunk_rows(cid)) == AHEAD
        await _sql(f"UPDATE desktop_commands SET state = 'done' WHERE id = '{cid}'")  # the computer ended; the phone never read the chunks
        r = await _ask(c, sid, _dl_body(sid, project, phone))
        assert r.status_code == 201, r.text
        assert await _chunk_rows(cid) == [] and await _counters(cid) is None, "the leftover and its four unread chunks went with the new ask"
        assert len(await _rows(sid)) == 1, "one row: the new ask's"
        # the same, a hundred times over: what is kept is one leftover, never a pile
        for _ in range(3):
            row_cid = (await _rows(sid))[0][0]
            await _delivered(row_cid)
            await _age_dl(sid)
            device_env = _chunk_env(sid, (await _rows(sid))[0][3], project)
            assert (await _put_chunk(c, device, row_cid, 0, device_env)).status_code == 200
            await _sql(f"UPDATE desktop_commands SET state = 'done' WHERE id = '{row_cid}'")
            assert (await _ask(c, sid, _dl_body(sid, project, phone))).status_code == 201
            assert len(await _rows(sid)) == 1
        assert (await _all_chunk_rows())[0][0] <= 1, "at most the last leftover's chunk is stored"


async def test_22_a_phone_pairing_removed_since_the_ask_leaves_nobody_to_read_the_chunks_and_the_row_goes(world):
    async with _client() as c:
        device, _a, phone, sid, project = await _setup(c, "d4988 mac u")
        cid, key = await _asked_dl(c, sid, phone, project)
        assert (await _put_chunk(c, device, cid, 0, _chunk_env(sid, key, project))).status_code == 200
        await _age_dl(sid)
        await _sql(f"UPDATE remote_device_pairings SET removed_at = now() WHERE setup_id = '{sid}'")  # [빼기]: the pair is removed
        assert (await _get_chunk(c, sid, cid, 0)).status_code == 404
        assert await _rows(sid) == [] and await _all_chunk_rows() == [(0,)], "the row and its chunk are gone"


async def test_23_the_replacement_is_for_the_askers_own_leftover_only(world):
    async with _client() as c:
        device, _a, phone, sid, project = await _setup(c, "d4988 mac v")
        cid, key = await _asked_dl(c, sid, phone, project)
        assert (await _put_chunk(c, device, cid, 0, _chunk_env(sid, key, project))).status_code == 200
        await _sql(f"UPDATE desktop_commands SET state = 'done' WHERE id = '{cid}'")
        await _sql(f"UPDATE desktop_file_reads SET viewer_id = '{PLAIN}' WHERE command_id = '{cid}'")  # a leftover that is somebody else's
        await _age_dl(sid)
        assert (await _ask(c, sid, _dl_body(sid, project, phone))).status_code == 201
        assert (await _chunk_rows(cid)) == [(0,)] and await _counters(cid) is not None, "another person's leftover is not touched"


async def test_24_a_pairing_removal_and_a_chunk_read_are_serialized_the_read_waits_for_it_and_then_finds_nothing(world):
    """the live-phone check holds the pairing rows with a share lock: a removal that is in flight (it holds the pairing row FOR UPDATE) makes the read WAIT, and once the removal has committed the read hands nothing over"""
    import asyncio

    from sqlalchemy import text

    from app.core.database import async_session_factory

    async with _client() as c:
        device, _a, phone, sid, project = await _setup(c, "d4988 mac w")
        cid, key = await _asked_dl(c, sid, phone, project)
        assert (await _put_chunk(c, device, cid, 0, _chunk_env(sid, key, project))).status_code == 200
        await _age_dl(sid)
        async with async_session_factory() as remover:  # a removal in flight: the pairing row is locked FOR UPDATE and marked removed, not yet committed
            await remover.execute(text(f"SELECT 1 FROM remote_device_pairings WHERE setup_id = '{sid}' FOR UPDATE"))
            await remover.execute(text(f"UPDATE remote_device_pairings SET removed_at = now() WHERE setup_id = '{sid}'"))
            reading = asyncio.ensure_future(_get_chunk(c, sid, cid, 0))
            await asyncio.sleep(1.0)
            assert not reading.done(), "the read waits for the removal that is in flight"
            await remover.commit()
        r = await asyncio.wait_for(reading, timeout=20)
        assert r.status_code == 404, "the removal committed first: nothing is handed over"
        assert await _rows(sid) == [] and await _all_chunk_rows() == [(0,)]


async def test_25_a_phone_key_revoked_since_the_ask_and_a_live_pairing_with_ANOTHER_computer_do_not_let_a_chunk_through(world):
    async with _client() as c:
        device, _a, phone, sid, project = await _setup(c, "d4988 mac x")
        _d2, _a2, _phone2, sid2, _p2 = await _setup(c, "d4988 mac x2")  # the same person has a live phone paired with ANOTHER computer too
        cid, key = await _asked_dl(c, sid, phone, project)
        assert (await _put_chunk(c, device, cid, 0, _chunk_env(sid, key, project))).status_code == 200
        await _age_dl(sid)
        await _sql(f"UPDATE remote_device_pairings SET removed_at = now() WHERE setup_id = '{sid}'")  # the pair with THIS computer is removed; the other computer's pair stands
        assert (await _get_chunk(c, sid, cid, 0)).status_code == 404, "a live pairing with another computer is no phone of this one"
        assert await _rows(sid) == []
        await _close_dl(sid)
        await _sql(f"UPDATE remote_device_pairings SET removed_at = NULL WHERE setup_id = '{sid}'")
        cid, key = await _asked_dl(c, sid, phone, project)
        assert (await _put_chunk(c, device, cid, 0, _chunk_env(sid, key, project))).status_code == 200
        await _age_dl(sid)
        await _sql(f"UPDATE remote_devices SET revoked_at = now() WHERE id IN (SELECT remote_device_id FROM remote_device_pairings WHERE setup_id = '{sid}')")  # the phone's key is revoked
        assert (await _get_chunk(c, sid, cid, 0)).status_code == 404, "a revoked phone key is no phone"
        assert sid2 is not None
