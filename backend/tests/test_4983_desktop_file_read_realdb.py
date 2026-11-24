"""story 4983 (P6 · phone ↔ host project files) — the SAME road for OPENING one file of a project: the `file_read` command word (0491), the one route that takes either kind by the envelope's own header, and every rule
that is shared with the folder list (the header rules, the limits, the answer, the single read, the 30-second stale rule). The server holds envelopes only — never a name, a path or a word of a file. Each test goes red
without the line it pins."""
from __future__ import annotations

import uuid
from datetime import timedelta

import pytest

from tests.test_4424_desktop_setup_realdb import (  # noqa: F401 — fixtures (autouse ones apply here too: the addresses the pairing needs, the engine's disposal)
    OWNER,
    _addresses,
    _client,
    _dispose_global_engine_after_test,
    _sql,
    anyio_backend,
    world,
)
from tests.test_4534_desktop_commands_realdb import _commands, _remote_control_on  # noqa: F401
from tests.test_4535_org_remote_control_realdb import _switch as _remote_control_switch  # noqa: F401
from tests.test_4976_sealed_prompt_realdb import b64, now_ms
from tests.test_4983_desktop_files_realdb import (  # the road's own helpers
    MARK,
    _age,
    _answer_env,
    _ask,
    _asked,
    _body,
    _close,
    _get,
    _put,
    _rows,
    _setup,
)

pytestmark = pytest.mark.anyio


def _read_body(sid, project, phone, key=None, **over):
    return _body(sid, project, phone, key=key, kind="file_read", **over)


async def _file_cmds(sid, kind):
    return [x for x in await _commands(sid) if x[0] == kind]


async def test_01_an_ask_with_a_file_read_envelope_queues_a_file_read_command_with_only_the_project_and_the_envelope(world):
    async with _client() as c:
        _d, _a, phone, sid, project = await _setup(c, "d4983r mac a")
        body = _read_body(sid, project, phone)
        r = await _ask(c, sid, body)
        assert r.status_code == 201, r.text
        cid = r.json()["command_id"]
        cmds = await _file_cmds(sid, "file_read")
        assert [(k, set(p), st) for k, p, _by, _key, st in cmds] == [("file_read", {"project_id", "envelope"}, "queued")]  # no name, no path, nothing readable
        assert cmds[0][1]["project_id"] == str(project) and cmds[0][1]["envelope"] == body["envelope"]
        assert await _file_cmds(sid, "file_list") == [], "the kind of the command is the envelope's own"
        rows = await _rows(sid)
        assert [(str(a), str(b), str(p), key, pl, w) for a, b, p, key, pl, w, _ttl in rows] == [(cid, str(OWNER), str(project), body["idempotency_key"], None, None)]
        assert timedelta(minutes=10) <= rows[0][6] < timedelta(minutes=10, seconds=1)


async def test_02_the_header_rules_of_a_list_are_the_rules_of_an_open(world):
    async with _client() as c:
        _d, _a, phone, sid, project = await _setup(c, "d4983r mac b")
        key = str(uuid.uuid4())
        old, future = now_ms() - 3_600_000, now_ms() + 3_600_000
        for over in ({"setup_id": str(uuid.uuid4())}, {"session_key": f"file:{uuid.uuid4()}"}, {"command_id": str(uuid.uuid4())}, {"ts": old, "expires_at": old + 120_000},
                     {"ts": future, "expires_at": future + 120_000}, {"expires_at": now_ms() - 5_000}, {"expires_at": now_ms() + 3_600_000}):
            body = {"project_id": str(project), "idempotency_key": key, "phone_key_id": phone, "envelope": _body(sid, project, phone, key=key, kind="file_read", **over)["envelope"]}
            r = await _ask(c, sid, body)
            assert r.status_code == 422 and r.json()["error"]["code"] == "envelope_header_mismatch", (over, r.text)
        assert await _file_cmds(sid, "file_read") == []


async def test_03_only_the_asking_kinds_are_taken_and_a_read_request_has_the_size_class_of_a_list(world):
    async with _client() as c:
        _d, _a, phone, sid, project = await _setup(c, "d4983r mac c")
        good = _read_body(sid, project, phone)
        for kind in ("file_result", "send_prompt", "approval_card", "", "File_Read", "File_Download"):  # (story 4988: `file_download` is the third asking kind — its own tests are test_4988_*)
            r = await _ask(c, sid, {**good, "envelope": {**good["envelope"], "kind": kind}})
            assert r.status_code == 422, (kind, r.text)
        r = await _ask(c, sid, {**good, "envelope": {**good["envelope"], "kind": 7}})
        assert r.status_code == 422
        r = await _ask(c, sid, {**good, "envelope": {k: v for k, v in good["envelope"].items() if k != "kind"}})
        assert r.status_code == 422
        r = await _ask(c, sid, {**good, "envelope": {**good["envelope"], "ct": b64(4 * 1024 + 17)}})
        assert r.status_code == 422, "past the 4 KiB class of a request"
        assert MARK not in r.text
        await _close(sid)
        ok = await _ask(c, sid, _read_body(sid, project, phone, ct=b64(4 * 1024 + 16)))
        assert ok.status_code == 201, ok.text
        assert await _file_cmds(sid, "file_list") == []


async def test_04_one_press_key_is_one_question_the_same_kind_again_gives_back_the_first_another_kind_is_refused(world):
    async with _client() as c:
        _d, _a, phone, sid, project = await _setup(c, "d4983r mac d")
        key = str(uuid.uuid4())
        body = _read_body(sid, project, phone, key=key)
        first, again = await _ask(c, sid, body), await _ask(c, sid, body)
        assert first.status_code == 201 and again.status_code == 201 and first.json() == again.json()
        assert len(await _file_cmds(sid, "file_read")) == 1
        other = await _ask(c, sid, _body(sid, project, phone, key=key))  # the SAME key under the list kind
        assert other.status_code == 409 and other.json()["error"]["code"] == "files_key_reused", other.text
        assert await _file_cmds(sid, "file_list") == [] and len(await _file_cmds(sid, "file_read")) == 1


async def test_05_a_list_and_an_open_share_one_ask_a_second_per_person_and_one_open_request_per_computer(world):
    async with _client() as c:
        _d, _a, phone, sid, project = await _setup(c, "d4983r mac e")
        assert (await _ask(c, sid, _read_body(sid, project, phone))).status_code == 201
        r = await _ask(c, sid, _body(sid, project, phone))  # a list, at once
        assert r.status_code == 429 and r.json()["error"]["code"] == "files_too_fast"
        r = await _ask(c, sid, _read_body(sid, project, phone))
        assert r.status_code == 429 and r.json()["error"]["code"] == "files_too_fast"
        await _age(sid)
        for body in (_body(sid, project, phone), _read_body(sid, project, phone)):
            r = await _ask(c, sid, body)
            assert r.status_code == 409 and r.json()["error"]["code"] == "files_busy", "the open is still open for either kind"
        await _close(sid)
        assert (await _ask(c, sid, _body(sid, project, phone))).status_code == 201
        await _age(sid)
        r = await _ask(c, sid, _read_body(sid, project, phone))
        assert r.status_code == 409 and r.json()["error"]["code"] == "files_busy", "a list in flight blocks an open"


async def test_06_the_computer_answers_an_open_once_and_the_person_reads_it_once(world):
    async with _client() as c:
        device, _a, phone, sid, project = await _setup(c, "d4983r mac f")
        cid, key = await _asked(c, device, sid, phone, project, kind="file_read")
        ans = _answer_env(sid, key, project)
        r = await _put(c, device, cid, ans)
        assert r.status_code == 200, r.text
        again = await _put(c, device, cid, ans)
        assert again.status_code == 409 and again.json()["error"]["code"] == "files_already_answered"
        await _age(sid)
        got = await _get(c, sid, cid)
        assert got.status_code == 200 and got.json()["envelope"] == ans and got.json()["state"] == "done"
        assert (await _get(c, sid, cid)).status_code == 404, "reading deleted it"
        assert await _rows(sid) == []


async def test_07_an_answer_to_an_open_is_judged_by_the_header_of_THAT_request(world):
    async with _client() as c:
        device, _a, phone, sid, project = await _setup(c, "d4983r mac g")
        cid, key = await _asked(c, device, sid, phone, project, kind="file_read")
        for over in ({"session_key": f"file:{uuid.uuid4()}"}, {"command_id": str(uuid.uuid4())}, {"setup_id": str(uuid.uuid4())}, {"expires_at": now_ms() - 1_000}):
            r = await _put(c, device, cid, _answer_env(sid, key, project, **over))
            assert r.status_code == 422 and r.json()["error"]["code"] == "envelope_header_mismatch", (over, r.text)
        assert (await _rows(sid))[0][4] is None, "nothing was kept"
        # an open's answer may be the largest an envelope can be (a picture): a full-size one is taken, one past the cap is not
        full = await _put(c, device, cid, _answer_env(sid, key, project, ct=b64(256 * 1024 + 16)))
        assert full.status_code == 200, full.text[:200]
        await _close(sid)
        cid, key = await _asked(c, device, sid, phone, project, kind="file_read")
        assert (await _put(c, device, cid, _answer_env(sid, key, project, ct=b64(256 * 1024 + 17)))).status_code == 422


async def test_08_an_open_that_waited_past_thirty_seconds_is_never_delivered(world):
    async with _client() as c:
        device, _a, phone, sid, project = await _setup(c, "d4983r mac h")
        from app.core.database import async_session_factory
        from app.services.desktop_relay import commands_to_send

        r = await _ask(c, sid, _read_body(sid, project, phone))
        cid = r.json()["command_id"]
        await _sql(f"UPDATE desktop_commands SET created_at = now() - interval '31 seconds' WHERE id = '{cid}'")
        async with async_session_factory() as s:
            sent = await commands_to_send(s, uuid.UUID(str(sid)), 0)
            await s.commit()
        assert [x.kind for x in sent if x.kind == "file_read"] == []
        assert tuple((await _sql(fetch=f"SELECT state, result_code FROM desktop_commands WHERE id = '{cid}'"))[0]) == ("rejected", "expired")
        await _age(sid)
        assert (await _get(c, sid, cid)).json() == {"state": "rejected", "code": "expired", "envelope": None}


async def test_09_remote_control_off_and_a_lost_project_take_an_open_answer_with_them_as_they_take_a_lists(world):
    async with _client() as c:
        device, _a, phone, sid, project = await _setup(c, "d4983r mac i")
        cid, key = await _asked(c, device, sid, phone, project, kind="file_read")
        assert (await _put(c, device, cid, _answer_env(sid, key, project))).status_code == 200
        from app.services import desktop_files
        from app.core.database import async_session_factory

        async with async_session_factory() as db:
            await desktop_files.forget(db, [uuid.UUID(str(sid))])
            await db.commit()
        assert await _rows(sid) == []
        await _age(sid)
        assert (await _get(c, sid, cid)).status_code == 404


def test_10_the_envelope_kinds_and_their_size_classes_are_held_together():
    from app.models.desktop_relay import COMMAND_KINDS
    from app.services.desktop_files import FILE_ASK_KINDS
    from app.services.desktop_relay import PAYLOAD_SCHEMAS
    from app.services.envelope_shape import ENVELOPE_KINDS, MAX_CT_BYTES, MAX_CT_BYTES_BY_KIND

    assert FILE_ASK_KINDS == ("file_list", "file_read", "file_download") and set(FILE_ASK_KINDS) <= set(COMMAND_KINDS) and set(FILE_ASK_KINDS) <= ENVELOPE_KINDS
    assert MAX_CT_BYTES_BY_KIND["file_download"] == MAX_CT_BYTES_BY_KIND["file_read"] == MAX_CT_BYTES_BY_KIND["file_list"] == 4 * 1024 and "file_result" not in MAX_CT_BYTES_BY_KIND and MAX_CT_BYTES == 256 * 1024
    assert PAYLOAD_SCHEMAS["file_read"] is PAYLOAD_SCHEMAS["file_list"], "an open names exactly what a list names: the project and the sealed request"
    assert set(PAYLOAD_SCHEMAS["file_read"].model_fields) == {"project_id", "envelope"}
    assert PAYLOAD_SCHEMAS["file_download"] is PAYLOAD_SCHEMAS["file_list"], "a download names exactly what a list names (story 4988)"


async def test_11_an_answer_row_is_only_ever_for_a_files_command_the_kind_filters_hold_on_both_roads(world):
    """a REAL command of another kind that happens to carry a read row (it cannot be made by the routes: this is the filter's own test) is neither answered nor read"""
    async with _client() as c:
        device, _a, phone, sid, project = await _setup(c, "d4983r mac j")
        cid, key = await _asked(c, device, sid, phone, project, kind="file_read")
        await _sql(f"UPDATE desktop_commands SET kind = 'read_changes', payload = '{{\"session_key\": \"s\"}}'::jsonb WHERE id = '{cid}'")
        r = await _put(c, device, cid, _answer_env(sid, key, project))
        assert r.status_code == 404 and r.json()["error"]["code"] == "files_read_not_found", r.text
        await _age(sid)
        assert (await _get(c, sid, cid)).status_code == 404
        await _sql(f"UPDATE desktop_commands SET kind = 'file_read', payload = '{{}}'::jsonb WHERE id = '{cid}'")
        assert (await _put(c, device, cid, _answer_env(sid, key, project))).status_code == 200
