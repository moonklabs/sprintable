"""story #4590 (E-2선 · Mirko's contract v1.14 판 2 · Yuna `4590-terminal-only-card.md` · PO 23:52Z) — a permission question only that
computer's terminal can answer reaches the list as a card with nothing to sign.

The report carries `terminal_only: true` and no input hash (with one → 422); without it the hash, tool and summary stay required (→ 422).
Its row is on the approvals list (the head count agrees with the cards) but never answerable, never on the badge, and rings no bell
(the notice is the phone's push). Answering it is refused (409 terminal_only) with no command going down. The DM strip reads it from
the session view (`ask_terminal_only`). The database itself keeps an answerable row whole (0445's CHECK).
"""
from __future__ import annotations

import uuid

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


def _terminal_ask(agent, **extra):
    body = _ask(agent, terminal_only=True, **extra)
    del body["input_hash"]
    return body


async def _bells(member):
    return await _sql(fetch=("SELECT payload FROM events WHERE recipient_id = :m AND event_type = 'dispatched' "
                             "AND payload->>'event_type' = 'agent.permission_request'"), params={"m": member})


async def test_the_report_carries_a_hash_only_when_it_is_answerable(world):
    async with _client() as c:
        device = await _device(c, name="d4424 mac 4590a")
        agent = await _with_session(c, device)
        with_hash = await _post_ask(c, device, _ask(agent, terminal_only=True))
        assert with_hash.status_code == 422, with_hash.text  # nothing to sign → no hash
        for missing in ("input_hash", "tool", "summary"):
            body = _ask(agent)
            del body[missing]
            r = await _post_ask(c, device, body)
            assert r.status_code == 422, (missing, r.text)  # an answerable question keeps all three
        bare = _terminal_ask(agent)
        # Mirko ⓐ (the daemon's own body): no summary → no masked · truncated keys either; the model's defaults take them
        del bare["tool"], bare["summary"], bare["masked"], bare["truncated"]
        assert (await _post_ask(c, device, bare)).status_code == 201  # tool · summary only when read
        assert (await _sql(fetch="SELECT count(*) FROM agent_permission_requests "
                                 f"WHERE setup_id = '{device['setup_id']}'"))[0][0] == 1


async def test_a_terminal_only_question_is_listed_but_never_answerable_badged_or_pushed(world):
    async with _client() as c:
        device = await _device(c, name="d4424 mac 4590b")
        agent = await _with_session(c, device)
        phone_id, der = await _register(c)
        await _pair(c, device["device_token"], der)  # a paired phone, reachable computer: an ordinary row would be answerable
        bare = _terminal_ask(agent)
        del bare["tool"], bare["summary"]
        made = await _post_ask(c, device, bare)
        assert made.status_code == 201, made.text

        [view] = (await c.get(REQS, headers=_person(OWNER))).json()["requests"]
        assert (view["state"], view["terminal_only"], view["answerable"], view["device_reachable"]) == ("pending", True, False, True)
        assert (view["tool"], view["tool_name"], view["summary"]) == (None, None, None)
        assert (view["session_key"], view["input_hash"]) == (None, None)
        badge = await c.get("/api/v2/gates/designated-pending-count", headers=_person(OWNER))
        assert badge.status_code == 200 and badge.json()["count"] == 0, badge.text
        assert await _bells(OWNER_TM) == []  # no notice → no push

        refused = await c.post(f"{REQS}/{view['id']}/answer", json=_answer(phone_id), headers=_person(OWNER))
        assert refused.status_code == 409 and refused.json()["error"]["code"] == "terminal_only", refused.text
        assert (await _sql(fetch=f"SELECT count(*) FROM desktop_commands WHERE setup_id = '{device['setup_id']}'"))[0][0] == 0
        assert (await _sql(fetch=f"SELECT state FROM agent_permission_requests WHERE id = '{view['id']}'"))[0][0] == "pending"

        # positive control on the same device: an ordinary question is badged and rings
        assert (await _post_ask(c, device, _ask(agent))).status_code == 201
        assert (await c.get("/api/v2/gates/designated-pending-count", headers=_person(OWNER))).json()["count"] == 1
        assert len(await _bells(OWNER_TM)) == 1
        listed = (await c.get(REQS, headers=_person(OWNER))).json()["requests"]
        assert sorted(r["terminal_only"] for r in listed) == [False, True]  # the list counts both


async def test_a_read_tool_is_named_and_the_strip_says_terminal_only(world):
    async with _client() as c:
        device = await _device(c, name="d4424 mac 4590c")
        agent = await _with_session(c, device)
        url = f"/api/v2/agents/{agent}/desktop-session"
        body = _terminal_ask(agent)
        made = await _post_ask(c, device, body)
        assert made.status_code == 201, made.text
        [view] = (await c.get(REQS, headers=_person(OWNER))).json()["requests"]
        assert (view["tool"], view["tool_name"], view["summary"]) == ("Bash", {"ko": "Bash", "en": "Bash"}, "npm install --save ••••(가림)")
        seen = (await c.get(url, headers=_person(OWNER))).json()
        assert (seen["state"], seen["ask_terminal_only"]) == ("waiting_permission", True), seen

        # the terminal answered it: the daemon withdraws, and the strip goes back to the ordinary line
        w = await c.post(f"/api/v2/desktop/relay/permission-requests/{body['request_id']}/withdraw", json={"reason": "answered_locally"},
                         headers=_tok(device["device_token"]))
        assert w.status_code == 200, w.text
        assert (await c.get(url, headers=_person(OWNER))).json()["ask_terminal_only"] is False
        # negative control: an ordinary question waiting is not terminal-only — the strip keeps its inbox line
        assert (await _post_ask(c, device, _ask(agent))).status_code == 201
        seen = (await c.get(url, headers=_person(OWNER))).json()
        assert (seen["pending_permission_request_id"] is not None, seen["ask_terminal_only"]) == (True, False), seen
        # Mirko ⓒ: answerable → terminal-only posts the new row before withdrawing the old one — both pending for a moment, and the
        # strip already says terminal-only (any pending terminal-only row of the session, not «the one»)
        assert (await _post_ask(c, device, _terminal_ask(agent))).status_code == 201
        assert (await c.get(url, headers=_person(OWNER))).json()["ask_terminal_only"] is True


async def test_an_answerable_question_withdrawn_as_terminal_only(world):
    """Mirko ②: the daemon withdraws an answerable row with `terminal_only` and reports a new terminal-only one."""
    async with _client() as c:
        device = await _device(c, name="d4424 mac 4590d")
        agent = await _with_session(c, device)
        body = _ask(agent)
        assert (await _post_ask(c, device, body)).status_code == 201
        w = await c.post(f"/api/v2/desktop/relay/permission-requests/{body['request_id']}/withdraw", json={"reason": "terminal_only"},
                         headers=_tok(device["device_token"]))
        assert w.status_code == 200, w.text
        row = await _sql(fetch=f"SELECT state, result_code FROM agent_permission_requests WHERE request_id = '{body['request_id']}'")
        assert tuple(row[0]) == ("withdrawn", "terminal_only")
        bad = await c.post(f"/api/v2/desktop/relay/permission-requests/{body['request_id']}/withdraw", json={"reason": "nope"},
                           headers=_tok(device["device_token"]))
        assert bad.status_code == 422


async def test_the_database_keeps_an_answerable_row_whole(world):
    async with _client() as c:
        device = await _device(c, name="d4424 mac 4590e")
        agent = await _with_session(c, device)
        made = await _post_ask(c, device, _ask(agent))
        rid = made.json()["id"]
    from sqlalchemy.exc import IntegrityError

    for sql in (f"UPDATE agent_permission_requests SET input_hash = NULL WHERE id = '{rid}'",
                f"UPDATE agent_permission_requests SET tool = NULL WHERE id = '{rid}'",
                f"UPDATE agent_permission_requests SET terminal_only = true WHERE id = '{rid}'"):  # a hash on a terminal-only row
        with pytest.raises(IntegrityError):
            await _sql(sql)
    assert uuid.UUID(rid)
