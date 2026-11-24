"""story 4972 — a permission request reported with its words sealed in one envelope: the server keeps the envelope as it came and serves it to the phone,
holds NO word of the request (tool · summary · folder · preview all NULL), sends a notice that names nothing, and lets the envelope go with its question."""
from __future__ import annotations

import base64
import json

import pytest

from tests.test_4424_desktop_setup_realdb import (  # noqa: F401 — fixtures (autouse ones apply here too)
    ORG,
    OWNER,
    OWNER_TM,
    _addresses,
    _client,
    _dispose_global_engine_after_test,
    _person,
    _sql,
    anyio_backend,
    world,
)
from tests.test_4529_desktop_relay_realdb import _device, _tok
from tests.test_4533_agent_permissions_realdb import (  # noqa: F401 — the autouse remote-control fixture applies here too
    PHONES,
    REQS,
    _answer,
    _ask,
    _pair,
    _post_ask,
    _register,
    _remote_control_on,
    _with_session,
)

pytestmark = pytest.mark.anyio

MARKER = "MK4972sealed"


def b64(n: int) -> str:
    return base64.urlsafe_b64encode(b"\x07" * n).rstrip(b"=").decode()


def sealed(setup_id, request_id, expires_at_ms, session_key="s-1", **over):
    env = {
        "v": 1, "kind": "approval_card", "setup_id": str(setup_id), "session_key": session_key, "command_id": str(request_id), "expires_at": expires_at_ms,
        "from": "host-1", "to": ["phone-1"], "epoch": 1, "ctr": 0, "ts": expires_at_ms - 60_000, "nonce": b64(16),
        "wraps": [{"to": "phone-1", "enc": b64(32), "ek": b64(48)}], "ct": b64(120), "sig": b64(71),
    }
    env.update(over)
    return env


async def _setup_id(token_name):
    return (await _sql(fetch=f"SELECT id FROM desktop_setups WHERE device_name = '{token_name}'"))[0][0]


def _sealed_ask(agent, setup_id, **over):
    plain = _ask(agent)
    for k in ("tool", "summary", "workdir"):
        del plain[k]
    plain["masked"] = False
    from datetime import datetime

    ms = int(datetime.fromisoformat(plain["expires_at"]).timestamp() * 1000)
    plain["envelope"] = sealed(setup_id, plain["request_id"], ms, **over)
    return plain


async def _row(request_id):
    return (await _sql(fetch=f"SELECT tool, summary, workdir, preview, envelope, state FROM agent_permission_requests WHERE request_id = '{request_id}'"))[0]


async def test_a_sealed_request_stores_no_word_serves_its_envelope_and_lets_it_go_with_the_answer(world):
    async with _client() as c:
        name = "d4424 mac 4972a"
        device = await _device(c, name=name)
        token = device["device_token"]
        agent = await _with_session(c, device)
        phone_id, der = await _register(c)
        await _pair(c, token, der)
        body = _sealed_ask(agent, await _setup_id(name))
        made = await _post_ask(c, device, body)
        assert made.status_code == 201, made.text
        tool, summary, workdir, preview, envelope, state = await _row(body["request_id"])
        assert (tool, summary, workdir, preview) == (None, None, None, None) and envelope == body["envelope"] and state == "pending"
        [view] = (await c.get(REQS, headers=_person(OWNER))).json()["requests"]
        assert view["envelope"] == body["envelope"] and view["sealed"] is True and view["tool"] is None and view["summary"] is None and view["workdir"] is None and view["preview"] is None
        ok = await c.post(f"{REQS}/{view['id']}/answer", json=_answer(phone_id), headers=_person(OWNER))
        assert ok.status_code == 200, ok.text
        assert (await _row(body["request_id"]))[4] is None
        [done] = (await c.get(REQS, headers=_person(OWNER))).json()["requests"]
        assert done["state"] == "answered" and done["envelope"] is None


async def test_the_notice_of_a_sealed_request_names_the_agent_and_an_approval_only(world):
    async with _client() as c:
        name = "d4424 mac 4972b"
        device = await _device(c, name=name)
        token = device["device_token"]
        agent = await _with_session(c, device)
        phone_id, der = await _register(c)
        await _pair(c, token, der)
        body = _sealed_ask(agent, await _setup_id(name))
        assert (await _post_ask(c, device, body)).status_code == 201
        rows = await _sql(fetch=("SELECT payload FROM events WHERE recipient_id = :m AND event_type = 'dispatched' "
                                 "AND payload->>'event_type' = 'agent.permission_request'"), params={"m": OWNER_TM})
        assert len(rows) == 1
        payload = rows[0][0]
        assert payload["body"] == "승인 요청이 왔어요" and payload["agent_name"]
        assert "Bash" not in json.dumps(payload, ensure_ascii=False)


async def test_a_withdrawal_and_a_window_that_passed_let_the_envelope_go(world):
    async with _client() as c:
        name = "d4424 mac 4972c"
        device = await _device(c, name=name)
        token = device["device_token"]
        agent = await _with_session(c, device)
        phone_id, der = await _register(c)
        await _pair(c, token, der)
        sid = await _setup_id(name)
        a, b = _sealed_ask(agent, sid), _sealed_ask(agent, sid)
        assert (await _post_ask(c, device, a)).status_code == 201 and (await _post_ask(c, device, b)).status_code == 201
        w = await c.post(f"/api/v2/desktop/relay/permission-requests/{a['request_id']}/withdraw", json={"reason": "answered_locally"}, headers=_tok(token))
        assert w.status_code == 200, w.text
        assert (await _row(a["request_id"]))[4] is None and (await _row(b["request_id"]))[4] is not None
        # the window passes without an answer → the next report of that computer lets go of it
        await _sql(f"UPDATE agent_permission_requests SET expires_at = now() - interval '1 second' WHERE request_id = '{b['request_id']}'")
        assert (await _post_ask(c, device, _sealed_ask(agent, sid))).status_code == 201
        assert (await _row(b["request_id"]))[4] is None
        state, code, envelope, input_hash, _p, sealed = await _card(b["request_id"])  # the report's own purge is the same one as the minute job's: the hash goes too, the row ends
        assert (state, code, envelope, input_hash, sealed) == ("expired", "expired", None, None, True)


async def test_the_words_may_not_come_twice_and_the_header_must_be_this_requests(world):
    async with _client() as c:
        name = "d4424 mac 4972d"
        device = await _device(c, name=name)
        token = device["device_token"]
        agent = await _with_session(c, device)
        phone_id, der = await _register(c)
        await _pair(c, token, der)
        sid = await _setup_id(name)
        # an envelope AND the text of the same question: refused (the text would put the words on the server)
        both = _sealed_ask(agent, sid)
        both["summary"] = MARKER
        r = await _post_ask(c, device, both)
        assert r.status_code == 422 and MARKER not in r.text.replace("summary", ""), r.text
        # a terminal-only request with an envelope and a hash: nothing is signed, so no hash (a sealed one carries none either)
        t_hash = _sealed_ask(agent, sid)
        t_hash["terminal_only"] = True
        assert (await _post_ask(c, device, t_hash)).status_code == 422
        # a sealed question that is not terminal-only has something to sign: no hash, no question
        no_hash = _sealed_ask(agent, sid)
        del no_hash["input_hash"]
        assert (await _post_ask(c, device, no_hash)).status_code == 422
        # a header that is another request's: another setup · session · request id · window
        for over in ({"setup_id": "00000000-0000-0000-0000-000000000000"}, {"session_key": "s-other"}, {"command_id": "00000000-0000-0000-0000-000000000001"}, {"expires_at": 1_000}):
            bad = _sealed_ask(agent, sid)
            bad["envelope"].update(over)
            r = await _post_ask(c, device, bad)
            assert r.status_code == 422, (over, r.text)
        # a shape the server does not accept
        bad = _sealed_ask(agent, sid)
        bad["envelope"]["kind"] = "chat_line"
        assert (await _post_ask(c, device, bad)).status_code == 422
        none = (await _sql(fetch="SELECT count(*) FROM agent_permission_requests WHERE envelope IS NOT NULL"))[0][0]
        assert none == 0


async def test_a_request_as_text_still_works_the_old_way(world):
    async with _client() as c:
        device = await _device(c, name="d4424 mac 4972e")
        agent = await _with_session(c, device)
        body = _ask(agent)
        assert (await _post_ask(c, device, body)).status_code == 201
        tool, summary, _w, _p, envelope, _s = await _row(body["request_id"])
        assert tool == "Bash" and summary and envelope is None


async def test_the_database_keeps_a_sealed_row_whole(world):
    async with _client() as c:
        name = "d4424 mac 4972f"
        device = await _device(c, name=name)
        agent = await _with_session(c, device)
        body = _sealed_ask(agent, await _setup_id(name))
        made = await _post_ask(c, device, body)
        rid = made.json()["id"]
        plain = _ask(agent)
        pid = (await _post_ask(c, device, plain)).json()["id"]
    from sqlalchemy.exc import IntegrityError

    # an envelope only on a sealed row · a sealed row may lose its envelope (its question is over) but never gain text words by accident of NULLs
    for sql in (f"UPDATE agent_permission_requests SET envelope = '{{}}'::jsonb WHERE id = '{pid}'",  # not sealed
                f"UPDATE agent_permission_requests SET input_hash = NULL WHERE id = '{rid}'",
                f"UPDATE agent_permission_requests SET terminal_only = true WHERE id = '{rid}'",  # a terminal-only row has no hash (sealed or not) — this one still has its hash
                f"UPDATE agent_permission_requests SET sealed = false WHERE id = '{rid}'",  # neither text nor sealed
                f"UPDATE agent_permission_requests SET envelope = 'null'::jsonb WHERE id = '{rid}'",  # a JSON null is no envelope
                f"UPDATE agent_permission_requests SET envelope = '[]'::jsonb WHERE id = '{rid}'",  # nor is a list
                f"UPDATE agent_permission_requests SET summary = 'x' WHERE id = '{rid}'",  # a sealed row carries no word as text
                f"UPDATE agent_permission_requests SET tool = 'Bash' WHERE id = '{rid}'",
                f"UPDATE agent_permission_requests SET workdir = '~/w' WHERE id = '{rid}'",
                f"UPDATE agent_permission_requests SET preview = '{{\"op\": \"write\"}}'::jsonb WHERE id = '{rid}'"):
        with pytest.raises(IntegrityError):
            await _sql(sql)
    # a request holds its envelope exactly while it is pending: an ended row with one · a pending sealed row without one
    for sql in (f"UPDATE agent_permission_requests SET state = 'withdrawn', result_code = 'session_ended', input_hash = NULL WHERE id = '{rid}'",  # ended, envelope still there
                f"UPDATE agent_permission_requests SET envelope = NULL WHERE id = '{rid}'"):  # pending, envelope gone
        with pytest.raises(IntegrityError):
            await _sql(sql)
    await _sql(f"UPDATE agent_permission_requests SET envelope = NULL, state = 'withdrawn', result_code = 'session_ended', input_hash = NULL WHERE id = '{rid}'")  # the question is over: the row stays whole


async def test_a_sealed_row_is_never_a_network_question_the_second_stage_is_refused(world):
    async with _client() as c:
        name = "d4424 mac 4972g"
        device = await _device(c, name=name)
        token = device["device_token"]
        agent = await _with_session(c, device)
        body = _sealed_ask(agent, await _setup_id(name))
        assert (await _post_ask(c, device, body)).status_code == 201
        r = await c.post(f"/api/v2/desktop/relay/permission-requests/{body['request_id']}/confirm-host", json={"host": "gitlab.com", "expires_at": body["expires_at"]}, headers=_tok(token))
        assert r.status_code in (409, 422) and "gitlab" not in r.text, r.text  # fail closed: a sealed card has no second stage


async def _card(request_id):
    return (await _sql(fetch=f"SELECT state, result_code, envelope, input_hash, preview, sealed FROM agent_permission_requests WHERE request_id = '{request_id}'"))[0]


async def test_the_minute_sweep_lets_go_of_the_words_of_a_window_that_passed_without_waiting_for_a_report(world):
    from app.core.database import async_session_factory
    from app.services.agent_permissions import purge_open_cards

    async with _client() as c:
        name = "d4424 mac 4972h"
        device = await _device(c, name=name)
        token = device["device_token"]
        agent = await _with_session(c, device)
        phone_id, der = await _register(c)
        await _pair(c, token, der)
        sid = await _setup_id(name)
        sealed_ask, quiet_text = _sealed_ask(agent, sid), _ask(agent)
        lines = _ask(agent, tool="Edit", summary="notes/a.md", preview={"op": "edit", "blocks": [{"removed": ["a"], "added": ["b"], "removed_more": 0, "added_more": 0}], "blocks_more": 0, "replace_all": False, "withheld": None})
        for b in (sealed_ask, quiet_text, lines):
            assert (await _post_ask(c, device, b)).status_code == 201
        fresh = _sealed_ask(agent, sid)
        assert (await _post_ask(c, device, fresh)).status_code == 201
        for b in (sealed_ask, quiet_text, lines):
            await _sql(f"UPDATE agent_permission_requests SET expires_at = now() - interval '1 second' WHERE request_id = '{b['request_id']}'")
        async with async_session_factory() as s:  # no report of that computer, nobody reads a list: the cron's minute job
            assert await purge_open_cards(s) == 3  # the sealed card · the preview · and (0484) the plain text row — its words go with its question now; not the one still waiting
            await s.commit()
        state, code, envelope, input_hash, _p, sealed = await _card(sealed_ask["request_id"])
        assert (state, code, envelope, input_hash, sealed) == ("expired", "expired", None, None, True)  # the row stays whole
        assert (await _card(lines["request_id"]))[0:2] == ("expired", "expired") and (await _card(lines["request_id"]))[4] is None
        assert (await _card(lines["request_id"]))[3] == lines["input_hash"]  # a text row keeps its hash
        assert (await _card(quiet_text["request_id"]))[0] == "expired"  # (0484: a plain card past its window ends too — its words go)
        assert (await _card(fresh["request_id"]))[2] is not None
        async with async_session_factory() as s:
            assert await purge_open_cards(s) == 0  # idempotent


async def test_a_sealed_row_lets_go_of_its_hash_when_its_question_ends_and_not_before(world):
    from sqlalchemy.exc import IntegrityError

    async with _client() as c:
        name = "d4424 mac 4972i"
        device = await _device(c, name=name)
        token = device["device_token"]
        agent = await _with_session(c, device)
        phone_id, der = await _register(c)
        await _pair(c, token, der)
        sid = await _setup_id(name)
        a, b = _sealed_ask(agent, sid), _sealed_ask(agent, sid)
        assert (await _post_ask(c, device, a)).status_code == 201 and (await _post_ask(c, device, b)).status_code == 201
        assert (await _card(a["request_id"]))[3] == a["input_hash"]  # waiting: the hash is what the phone signs with
        with pytest.raises(IntegrityError):  # …and the database does not let a WAITING sealed row lose it
            await _sql(f"UPDATE agent_permission_requests SET input_hash = NULL WHERE request_id = '{a['request_id']}'")
        with pytest.raises(IntegrityError):  # a sealed row has no second stage
            await _sql(f"UPDATE agent_permission_requests SET stage = 'confirm' WHERE request_id = '{a['request_id']}'")
        [v1, v2] = sorted((await c.get(REQS, headers=_person(OWNER))).json()["requests"], key=lambda v: v["request_id"] != a["request_id"])
        ok = await c.post(f"{REQS}/{v1['id']}/answer", json=_answer(phone_id), headers=_person(OWNER))
        assert ok.status_code == 200, ok.text
        assert (await _card(a["request_id"]))[3] is None  # answered
        w = await c.post(f"/api/v2/desktop/relay/permission-requests/{b['request_id']}/withdraw", json={"reason": "answered_locally"}, headers=_tok(token))
        assert w.status_code == 200 and (await _card(b["request_id"]))[3] is None  # withdrawn


async def test_taking_off_the_last_phone_ends_the_sealed_cards_and_another_phone_keeps_them(world):
    async with _client() as c:
        name = "d4424 mac 4972j"
        device = await _device(c, name=name)
        token = device["device_token"]
        agent = await _with_session(c, device)
        p1, der1 = await _register(c, label="one")
        p2, der2 = await _register(c, label="two")
        await _pair(c, token, der1, der2)
        body = _sealed_ask(agent, await _setup_id(name))
        assert (await _post_ask(c, device, body)).status_code == 201
        r = await c.delete(f"{PHONES}/{p1}", headers=_person(OWNER))
        assert r.status_code in (200, 204), r.text
        assert (await _card(body["request_id"]))[0] == "pending" and (await _card(body["request_id"]))[2] is not None  # the person still has a phone on this computer
        r = await c.delete(f"{PHONES}/{p2}", headers=_person(OWNER))
        assert r.status_code in (200, 204), r.text
        state, code, envelope, input_hash, _p, sealed = await _card(body["request_id"])
        assert (state, code, envelope, input_hash, sealed) == ("withdrawn", "session_ended", None, None, True)


async def test_a_terminal_only_question_can_be_sealed_too_words_to_read_and_nothing_to_sign(world):
    async with _client() as c:
        name = "d4424 mac 4972t"
        device = await _device(c, name=name)
        token = device["device_token"]
        agent = await _with_session(c, device)
        phone_id, der = await _register(c)
        await _pair(c, token, der)
        sid = await _setup_id(name)
        body = _sealed_ask(agent, sid)
        del body["input_hash"]
        body["terminal_only"] = True
        made = await _post_ask(c, device, body)
        assert made.status_code == 201, made.text
        tool, summary, workdir, preview, envelope, state = await _row(body["request_id"])
        assert (tool, summary, workdir, preview) == (None, None, None, None) and envelope == body["envelope"] and state == "pending"
        assert (await _sql(fetch=f"SELECT sealed, terminal_only, input_hash FROM agent_permission_requests WHERE request_id = '{body['request_id']}'"))[0] == (True, True, None)
        # a phone paired with that computer is served the envelope — and nothing to press or sign
        [view] = (await c.get(REQS, headers=_person(OWNER))).json()["requests"]
        assert view["envelope"] == body["envelope"] and view["sealed"] is True and view["terminal_only"] is True and view["answerable"] is False
        assert view["input_hash"] is None and view["tool"] is None and view["summary"] is None
        # it cannot be answered from the phone
        no = await c.post(f"{REQS}/{view['id']}/answer", json=_answer(phone_id), headers=_person(OWNER))
        assert no.status_code == 409, no.text
        # the words go with the question like any other sealed card
        w = await c.post(f"/api/v2/desktop/relay/permission-requests/{body['request_id']}/withdraw", json={"reason": "answered_locally"}, headers=_tok(token))
        assert w.status_code == 200, w.text
        assert (await _row(body["request_id"]))[4] is None
        [done] = (await c.get(REQS, headers=_person(OWNER))).json()["requests"]
        assert done["envelope"] is None and done["sealed"] is True
        # a window that passes lets it go too (the minute sweep is the same one)
        late = _sealed_ask(agent, sid)
        del late["input_hash"]
        late["terminal_only"] = True
        assert (await _post_ask(c, device, late)).status_code == 201
        await _sql(f"UPDATE agent_permission_requests SET expires_at = now() - interval '1 second' WHERE request_id = '{late['request_id']}'")
        assert (await _post_ask(c, device, _sealed_ask(agent, sid))).status_code == 201
        assert (await _row(late["request_id"]))[4] is None


async def test_a_sealed_terminal_only_card_is_not_served_to_a_person_with_no_phone_paired_with_that_computer(world):
    async with _client() as c:
        name = "d4424 mac 4972u"
        device = await _device(c, name=name)
        agent = await _with_session(c, device)
        sid = await _setup_id(name)
        body = _sealed_ask(agent, sid)
        del body["input_hash"]
        body["terminal_only"] = True
        assert (await _post_ask(c, device, body)).status_code == 201
        views = (await c.get(REQS, headers=_person(OWNER))).json()["requests"]
        assert all(v["envelope"] is None for v in views), "no paired phone: the envelope is not served (it could be opened by nobody)"


async def test_the_downgrade_of_0480_leaves_a_sealed_terminal_only_row_that_0479s_rule_accepts(world):
    import importlib.util
    import pathlib

    mod_path = pathlib.Path(__file__).resolve().parents[1] / "alembic" / "versions" / "0480_sealed_terminal_only_card.py"
    spec = importlib.util.spec_from_file_location("m0480", mod_path)
    m = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(m)
    async with _client() as c:
        name = "d4424 mac 4972v"
        device = await _device(c, name=name)
        agent = await _with_session(c, device)
        body = _sealed_ask(agent, await _setup_id(name))
        del body["input_hash"]
        body["terminal_only"] = True
        assert (await _post_ask(c, device, body)).status_code == 201
    # what downgrade() does to such a row, then 0479's rule over it: it holds. HERMETIC: the table is shared with every other test (a row another file left — e.g. an ended plain row whose words
    # were released, legal under 0484's rule and not under 0479's — must not decide this test), so the UPDATE runs in a transaction that is rolled back and the rule is asked of THIS test's row only.
    from sqlalchemy import text
    from sqlalchemy.ext.asyncio import create_async_engine
    from sqlalchemy.pool import NullPool

    from tests.test_4424_desktop_setup_realdb import _ASYNC

    eng = create_async_engine(_ASYNC, poolclass=NullPool)
    try:
        async with eng.connect() as conn:
            trans = await conn.begin()
            try:
                await conn.execute(text(m._DOWNGRADE_SQL))
                bad = (await conn.execute(text(f"SELECT count(*) FROM agent_permission_requests WHERE request_id = '{body['request_id']}' AND NOT ({m._OLD_RULE})"))).scalar_one()
                assert bad == 0
                mine = (await conn.execute(text(f"SELECT count(*) FROM agent_permission_requests WHERE request_id = '{body['request_id']}'"))).scalar_one()
                assert mine == 1, "(the row of this test is the one that was asked)"
            finally:
                await trans.rollback()
    finally:
        await eng.dispose()


async def test_a_snapshot_that_no_longer_lists_the_last_phone_ends_the_sealed_cards(world):
    async with _client() as c:
        name = "d4424 mac 4972w"
        device = await _device(c, name=name)
        token = device["device_token"]
        agent = await _with_session(c, device)
        phone_id, der = await _register(c)
        await _pair(c, token, der)
        sid = await _setup_id(name)
        a = _sealed_ask(agent, sid)
        t = _sealed_ask(agent, sid)
        del t["input_hash"]
        t["terminal_only"] = True
        assert (await _post_ask(c, device, a)).status_code == 201 and (await _post_ask(c, device, t)).status_code == 201
        # the computer's next list of paired phones is empty: the person has no phone on it any more — a sealed card nobody can open does not wait out its window
        await _pair(c, token)
        for body in (a, t):
            state, code, envelope, input_hash, _p, sealed_ = await _card(body["request_id"])
            assert (state, code, envelope, input_hash, sealed_) == ("withdrawn", "session_ended", None, None, True), body["request_id"]


async def test_a_sealed_terminal_only_card_of_a_disconnected_computer_is_not_served(world):
    async with _client() as c:
        name = "d4424 mac 4972x"
        device = await _device(c, name=name)
        token = device["device_token"]
        agent = await _with_session(c, device)
        phone_id, der = await _register(c)
        await _pair(c, token, der)
        sid = await _setup_id(name)
        t = _sealed_ask(agent, sid)
        del t["input_hash"]
        t["terminal_only"] = True
        assert (await _post_ask(c, device, t)).status_code == 201
        assert [v["envelope"] is not None for v in (await c.get(REQS, headers=_person(OWNER))).json()["requests"]] == [True]
        await _sql(f"UPDATE desktop_setups SET revoked_at = now() WHERE id = '{sid}'")
        assert all(v["envelope"] is None for v in (await c.get(REQS, headers=_person(OWNER))).json()["requests"]), "the computer was disconnected: no envelope goes out for it"


async def test_the_real_downgrade_and_upgrade_of_0480_run_and_keep_a_sealed_terminal_only_row(world):
    """the migration's own downgrade() and upgrade() run against the test database (not only their SQL strings): down keeps the row as a words-less terminal-only card under 0479's rule, up restores 0480's."""
    import importlib.util
    import pathlib

    from alembic.operations import Operations
    from alembic.runtime.migration import MigrationContext
    from sqlalchemy import text
    from sqlalchemy.ext.asyncio import create_async_engine
    from sqlalchemy.pool import NullPool

    from tests.test_4424_desktop_setup_realdb import _ASYNC

    mod_path = pathlib.Path(__file__).resolve().parents[1] / "alembic" / "versions" / "0480_sealed_terminal_only_card.py"
    spec = importlib.util.spec_from_file_location("m0480c", mod_path)
    m = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(m)
    async with _client() as c:
        name = "d4424 mac 4972z"
        device = await _device(c, name=name)
        agent = await _with_session(c, device)
        body = _sealed_ask(agent, await _setup_id(name))
        del body["input_hash"]
        body["terminal_only"] = True
        assert (await _post_ask(c, device, body)).status_code == 201
    eng = create_async_engine(_ASYNC, poolclass=NullPool)

    def run(sync_conn, fn):
        with Operations.context(MigrationContext.configure(sync_conn)):
            fn()

    norm = lambda t: "".join(str(t).split())  # noqa: E731
    q_def = text("SELECT pg_get_constraintdef(oid) FROM pg_constraint WHERE conname = 'ck_agent_permission_requests_terminal_only_fields'")
    try:
        # ONE transaction that is rolled back (Postgres DDL is transactional): the shared test database is never left at the old schema, whatever fails in between, and the global rewrite of the downgrade touches nothing that stays
        async with eng.connect() as conn:
            trans = await conn.begin()
            try:
                before = norm((await conn.execute(q_def)).scalar_one())
                # HERMETIC: `downgrade()` VALIDATEs 0479's rule over the WHOLE shared table — a row another test file left (e.g. an ended plain row whose words were released: legal under 0484, not under 0479) would
                # fail it. Inside this transaction (rolled back below) only this test's row is kept; nothing of the others is touched for real.
                await conn.execute(text(f"DELETE FROM agent_permission_requests WHERE request_id <> '{body['request_id']}'"))
                await conn.run_sync(run, m.downgrade)
                down = norm((await conn.execute(q_def)).scalar_one())
                assert "terminal_onlyAND(input_hashISNULL)AND(NOTsealed)" in down and "terminal_onlyAND(input_hashISNULL)AND(NOTsealed)" not in before, "0479's rule is back (NOT sealed on the terminal-only branch too)"
                coupling = "(state='pending'::text)OR(envelopeISNULL)"
                assert coupling in before and coupling not in down, "0480's coupling of the envelope to a pending request is gone with the downgrade"
                row = (await conn.execute(text(f"SELECT sealed, envelope IS NULL, terminal_only FROM agent_permission_requests WHERE request_id = '{body['request_id']}'"))).one()
                assert tuple(row) == (False, True, True), "the sealed terminal-only row stays, as a terminal-only card with no words"
                await conn.run_sync(run, m.upgrade)
                after = norm((await conn.execute(q_def)).scalar_one())
                assert coupling in after and after != before, "0480's rule is back after the upgrade (not 0484's looser words rule: the database is at 0484 here, the test rolls back to it)"
            finally:
                await trans.rollback()
        async with eng.connect() as conn:
            assert norm((await conn.execute(q_def)).scalar_one()) == before, "nothing of this test stays in the database"
            kept = (await conn.execute(text(f"SELECT sealed FROM agent_permission_requests WHERE request_id = '{body['request_id']}'"))).scalar_one()
            assert kept is True
    finally:
        await eng.dispose()


async def test_the_model_and_the_migration_state_the_same_rule_and_the_downgrade_runs_the_sql(world):
    import importlib.util
    import inspect
    import pathlib

    from app.models.agent_permission import AgentPermissionRequest

    mod_path = pathlib.Path(__file__).resolve().parents[1] / "alembic" / "versions" / "0484_agent_permission_ended_words.py"  # (0484 restates the rule: the one the models carry now)
    spec = importlib.util.spec_from_file_location("m0484b", mod_path)
    m = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(m)
    ck = next(c for c in AgentPermissionRequest.__table__.constraints if getattr(c, "name", None) == "ck_agent_permission_requests_terminal_only_fields")
    norm = lambda t: "".join(str(t).split())  # noqa: E731
    assert norm(ck.sqltext) == norm(m._NEW_RULE), "a schema made from the models carries the rule the migrations leave"
    assert "_DOWNGRADE_SQL" in inspect.getsource(m.downgrade) and "NOT sealed" in m._OLD_RULE


async def test_the_minute_sweep_ends_a_card_whose_person_lost_every_phone_by_a_path_that_does_not_check(world):
    from app.core.database import async_session_factory
    from app.services.agent_permissions import end_orphan_cards

    async with _client() as c:
        name = "d4424 mac 4972y"
        device = await _device(c, name=name)
        token = device["device_token"]
        agent = await _with_session(c, device)
        p1, der1 = await _register(c, label="one")
        p2, der2 = await _register(c, label="two")
        await _pair(c, token, der1, der2)
        sid = await _setup_id(name)
        body = _sealed_ask(agent, sid)
        assert (await _post_ask(c, device, body)).status_code == 201
        async with async_session_factory() as s:
            assert await end_orphan_cards(s) == 0  # the person has two live phones
        # two removals that each saw the other's pair standing (concurrent) and an account reclaim that revokes keys, as the rows they leave: every pair gone / every key revoked, no card ended
        await _sql(f"UPDATE remote_device_pairings SET removed_at = now() WHERE setup_id = '{sid}'")
        assert (await _card(body["request_id"]))[0] == "pending" and (await _card(body["request_id"]))[2] is not None
        async with async_session_factory() as s:
            assert await end_orphan_cards(s) == 1
            await s.commit()
        state, code, envelope, input_hash, _p, sealed_ = await _card(body["request_id"])
        assert (state, code, envelope, input_hash, sealed_) == ("withdrawn", "session_ended", None, None, True)
        async with async_session_factory() as s:
            assert await end_orphan_cards(s) == 0  # idempotent
        # revoked keys instead of removed pairs
        again = _sealed_ask(agent, sid)
        t = _sealed_ask(agent, sid)
        del t["input_hash"]
        t["terminal_only"] = True
        await _sql(f"UPDATE remote_device_pairings SET removed_at = NULL WHERE setup_id = '{sid}'")
        assert (await _post_ask(c, device, again)).status_code == 201 and (await _post_ask(c, device, t)).status_code == 201
        await _sql(f"UPDATE remote_devices SET revoked_at = now() WHERE id IN ('{p1}', '{p2}')")
        async with async_session_factory() as s:
            assert await end_orphan_cards(s) == 2
            await s.commit()
        assert (await _card(again["request_id"]))[2] is None and (await _card(t["request_id"]))[2] is None


async def test_a_person_who_never_paired_a_phone_keeps_the_plain_preview_card_through_the_minute_sweep(world):
    from app.core.database import async_session_factory
    from app.services.agent_permissions import end_orphan_cards

    async with _client() as c:
        name = "d4424 mac 4972m"
        device = await _device(c, name=name)
        agent = await _with_session(c, device)  # no phone is ever registered or paired for this person
        lines = _ask(agent, tool="Edit", summary="notes/a.md", preview={"op": "edit", "blocks": [{"removed": ["a"], "added": ["b"], "removed_more": 0, "added_more": 0}], "blocks_more": 0, "replace_all": False, "withheld": None})
        plain = _ask(agent)
        assert (await _post_ask(c, device, lines)).status_code == 201 and (await _post_ask(c, device, plain)).status_code == 201
        async with async_session_factory() as s:
            assert await end_orphan_cards(s) == 0  # nothing was lost for this person: no phone was ever taken away from them
            await s.commit()
        for body in (lines, plain):
            state, code, envelope, input_hash, preview, sealed_ = await _card(body["request_id"])
            assert state == "pending" and code is None, body["request_id"]
        assert (await _card(lines["request_id"]))[4] is not None, "the preview of the plain card is still there (it ends by a window · an answer · a withdrawal, as it always did)"


async def test_a_sealed_card_of_a_disconnected_computer_is_ended_by_the_minute_sweep(world):
    from app.core.database import async_session_factory
    from app.services.agent_permissions import end_orphan_cards

    async with _client() as c:
        name = "d4424 mac 4972n"
        device = await _device(c, name=name)
        token = device["device_token"]
        agent = await _with_session(c, device)
        phone_id, der = await _register(c)
        await _pair(c, token, der)
        sid = await _setup_id(name)
        a = _sealed_ask(agent, sid)
        t = _sealed_ask(agent, sid)
        del t["input_hash"]
        t["terminal_only"] = True
        assert (await _post_ask(c, device, a)).status_code == 201 and (await _post_ask(c, device, t)).status_code == 201
        async with async_session_factory() as s:
            assert await end_orphan_cards(s) == 0  # the person's phone is paired and the computer is connected
        await _sql(f"UPDATE desktop_setups SET revoked_at = now() WHERE id = '{sid}'")  # the computer was disconnected: the pair rows stay
        async with async_session_factory() as s:
            assert await end_orphan_cards(s) == 2
            await s.commit()
        for body in (a, t):
            state, code, envelope, input_hash, _p, sealed_ = await _card(body["request_id"])
            assert (state, code, envelope, input_hash, sealed_) == ("withdrawn", "session_ended", None, None, True)


async def test_the_minute_cron_keeps_its_earlier_purges_when_the_orphan_sweep_fails(world, monkeypatch):
    import app.routers.cron as cron_module
    import app.services.agent_permissions as perms
    from httpx import ASGITransport, AsyncClient
    from sqlalchemy import text as sql_text

    from app.main import app

    monkeypatch.setattr(cron_module, "CRON_SECRET", "test-cron-secret")
    async with _client() as c:
        name = "d4424 mac 4972o"
        device = await _device(c, name=name)
        token = device["device_token"]
        agent = await _with_session(c, device)
        phone_id, der = await _register(c)
        await _pair(c, token, der)
        sid = await _setup_id(name)
        late = _sealed_ask(agent, sid)
        assert (await _post_ask(c, device, late)).status_code == 201
        await _sql(f"UPDATE agent_permission_requests SET expires_at = now() - interval '1 second' WHERE request_id = '{late['request_id']}'")

    async def boom(db):
        await db.execute(sql_text("SELECT 1/0"))  # a statement that aborts the transaction it runs in

    monkeypatch.setattr(perms, "end_orphan_cards", boom)
    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as client:
        r = await client.post("/api/v2/internal/cron/changes-purge", headers={"Authorization": "Bearer test-cron-secret"})
    assert r.status_code == 200, r.text
    assert r.json()["data"]["orphan_cards_ended"] is None and r.json()["data"]["cards_ended"] == 1, r.text
    state, code, envelope, input_hash, _p, sealed_ = await _card(late["request_id"])
    assert (state, code, envelope) == ("expired", "expired", None), "the window sweep that ran BEFORE the failing one was committed"
