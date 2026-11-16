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
        # a terminal-only request has no card to seal
        t_only = _sealed_ask(agent, sid)
        del t_only["input_hash"]
        t_only["terminal_only"] = True
        assert (await _post_ask(c, device, t_only)).status_code == 422
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
                f"UPDATE agent_permission_requests SET terminal_only = true, input_hash = NULL WHERE id = '{rid}'",  # a terminal-only row is never sealed
                f"UPDATE agent_permission_requests SET sealed = false WHERE id = '{rid}'"):  # neither text nor sealed
        with pytest.raises(IntegrityError):
            await _sql(sql)
    await _sql(f"UPDATE agent_permission_requests SET envelope = NULL WHERE id = '{rid}'")  # the question is over: the row stays whole
