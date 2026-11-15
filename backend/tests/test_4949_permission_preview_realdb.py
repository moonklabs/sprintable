"""story 4949 — the preview of a file tool's input reaches the approving person only while its question waits: stored with the report, served on a
pending request, gone from the row when the request is answered, withdrawn or (on the computer's next report) past its window — and in no
notice. A body over the limits is refused (422)."""
from __future__ import annotations

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

PREVIEW = {"op": "edit", "blocks": [{"removed": ["const a = 1;"], "added": ["const a = 2;", "const b = 3;"], "removed_more": 0, "added_more": 4}],
           "blocks_more": 0, "replace_all": False, "withheld": None}


def _write_ask(agent, **extra):
    return _ask(agent, tool="Edit", summary="notes/a.md", masked=False, preview=PREVIEW, **extra)


async def _stored(request_id):
    return (await _sql(fetch=f"SELECT preview FROM agent_permission_requests WHERE request_id = '{request_id}'"))[0][0]


async def test_a_pending_request_serves_its_preview_and_an_answer_empties_the_row(world):
    async with _client() as c:
        device = await _device(c, name="d4424 mac 4949a")
        token = device["device_token"]
        agent = await _with_session(c, device)
        phone_id, der = await _register(c)
        await _pair(c, token, der)
        body = _write_ask(agent)
        made = await _post_ask(c, device, body)
        assert made.status_code == 201, made.text
        assert await _stored(body["request_id"]) == PREVIEW
        [view] = (await c.get(REQS, headers=_person(OWNER))).json()["requests"]
        assert view["state"] == "pending" and view["preview"] == PREVIEW
        # answered: the lines are no longer kept, and the list serves none
        ok = await c.post(f"{REQS}/{view['id']}/answer", json=_answer(phone_id), headers=_person(OWNER))
        assert ok.status_code == 200, ok.text
        assert await _stored(body["request_id"]) is None
        [done] = (await c.get(REQS, headers=_person(OWNER))).json()["requests"]
        assert done["state"] == "answered" and done["preview"] is None


async def test_a_request_without_a_preview_serves_none_and_a_withdrawal_empties_the_row(world):
    async with _client() as c:
        device = await _device(c, name="d4424 mac 4949b")
        token = device["device_token"]
        agent = await _with_session(c, device)
        phone_id, der = await _register(c)
        await _pair(c, token, der)  # a paired phone: the rows are answerable, so the lines are served
        plain = _ask(agent)
        assert (await _post_ask(c, device, plain)).status_code == 201
        with_lines = _write_ask(agent)
        assert (await _post_ask(c, device, with_lines)).status_code == 201
        views = {v["request_id"]: v for v in (await c.get(REQS, headers=_person(OWNER))).json()["requests"]}
        assert views[plain["request_id"]]["preview"] is None and views[with_lines["request_id"]]["preview"] == PREVIEW
        w = await c.post(f"/api/v2/desktop/relay/permission-requests/{with_lines['request_id']}/withdraw", json={"reason": "answered_locally"}, headers=_tok(token))
        assert w.json()["state"] == "withdrawn"
        assert await _stored(with_lines["request_id"]) is None
        views = {v["request_id"]: v for v in (await c.get(REQS, headers=_person(OWNER))).json()["requests"]}
        assert views[with_lines["request_id"]]["preview"] is None


async def test_the_lines_are_served_only_on_a_row_that_can_be_answered_the_same_condition_as_the_input_hash(world):  # security lens 4949 · item 2
    async with _client() as c:
        device = await _device(c, name="d4424 mac 4949g")
        token, sid = device["device_token"], device["setup_id"]
        agent = await _with_session(c, device)
        body = _write_ask(agent)
        assert (await _post_ask(c, device, body)).status_code == 201
        async def view():
            [v] = (await c.get(REQS, headers=_person(OWNER))).json()["requests"]
            return v
        v = await view()
        assert (v["answerable"], v["preview"], v["input_hash"]) == (False, None, None)  # no phone paired with that computer: nothing can be decided
        assert await _stored(body["request_id"]) == PREVIEW  # (held, not served)
        phone_id, der = await _register(c)
        await _pair(c, token, der)
        v = await view()
        assert (v["answerable"], v["preview"] == PREVIEW, v["input_hash"] is not None) == (True, True, True)
        await _sql(f"UPDATE desktop_device_tokens SET last_used_at = now() - interval '5 minutes' WHERE setup_id = '{sid}'")
        v = await view()
        assert (v["answerable"], v["preview"]) == (False, None)  # the computer has not been heard from
        await _sql(f"UPDATE desktop_device_tokens SET last_used_at = now() WHERE setup_id = '{sid}'")
        assert (await view())["preview"] == PREVIEW
        await _sql(f"UPDATE organizations SET remote_control_enabled_at = NULL WHERE id = '{ORG}'")
        v = await view()
        assert (v["answerable"], v["preview"]) == (False, None)  # remote control off: nothing can be answered


async def test_the_list_is_never_cached_and_a_refused_preview_does_not_come_back_in_the_refusal(world):  # security lens 4949 · item 5
    async with _client() as c:
        device = await _device(c, name="d4424 mac 4949h")
        agent = await _with_session(c, device)
        listed = await c.get(REQS, headers=_person(OWNER))
        assert listed.status_code == 200 and listed.headers.get("cache-control") == "private, no-store"
        marker = "ECHO-MARKER-4949"
        too_long = {**PREVIEW, "blocks": [{"removed": [], "added": [marker + "x" * 130], "removed_more": 0, "added_more": 0}]}
        r = await _post_ask(c, device, _ask(agent, tool="Edit", summary="a.md", masked=False, preview=too_long))
        assert r.status_code == 422
        assert marker not in r.text and '"input"' not in r.text, r.text[:300]


async def test_a_request_past_its_window_is_not_served_and_the_next_report_of_that_computer_lets_go_of_its_lines(world):
    async with _client() as c:
        device = await _device(c, name="d4424 mac 4949c")
        agent = await _with_session(c, device)
        quiet = _write_ask(agent)
        made = (await _post_ask(c, device, quiet)).json()
        await _sql(f"UPDATE agent_permission_requests SET expires_at = now() - interval '1 second' WHERE id = '{made['id']}'")
        [view] = (await c.get(REQS, headers=_person(OWNER))).json()["requests"]
        assert view["state"] == "expired" and view["preview"] is None  # never served past its window
        assert await _stored(quiet["request_id"]) == PREVIEW  # the computer went quiet: still held …
        assert (await _post_ask(c, device, _ask(agent))).status_code == 201  # … until its next report
        assert await _stored(quiet["request_id"]) is None


async def test_an_idempotent_retry_of_an_existing_request_also_lets_go_of_a_quiet_ones_lines(world):  # codex 4949 · security
    async with _client() as c:
        device = await _device(c, name="d4424 mac 4949f")
        agent = await _with_session(c, device)
        quiet = _write_ask(agent)
        made = (await _post_ask(c, device, quiet)).json()
        live = _ask(agent)
        assert (await _post_ask(c, device, live)).status_code == 201
        await _sql(f"UPDATE agent_permission_requests SET expires_at = now() - interval '1 second' WHERE id = '{made['id']}'")
        assert await _stored(quiet["request_id"]) == PREVIEW
        assert (await _post_ask(c, device, live)).status_code in (200, 201)  # the same request_id again: the early return
        assert await _stored(quiet["request_id"]) is None


async def test_a_preview_over_the_limits_or_in_a_shape_that_cannot_be_is_refused(world):
    async with _client() as c:
        device = await _device(c, name="d4424 mac 4949d")
        agent = await _with_session(c, device)
        for bad in (
            {**PREVIEW, "blocks": [{"removed": [], "added": ["x"] * 13}]},
            {**PREVIEW, "blocks": [{"removed": [], "added": ["x" * 121]}]},
            {**PREVIEW, "blocks": [{"removed": ["x"], "added": []}] * 4},
            {"op": "write", "blocks": [{"removed": ["x"], "added": ["y"]}]},
            {"op": "write", "blocks": [], "withheld": "sensitive_path", "replace_all": True},
            {**PREVIEW, "content": "the whole file"},
            {**PREVIEW, "blocks": [{"removed": [], "added": ["one\ntwo"]}]},
        ):
            r = await _post_ask(c, device, _ask(agent, tool="Edit" if bad["op"] == "edit" else "Write", summary="a.md", masked=False, preview=bad))
            assert r.status_code == 422, (bad, r.text)
        # a preview of anything that is not a Claude file tool's input (a Bash command's text) is refused — and a kind that is not the tool's
        assert (await _post_ask(c, device, _ask(agent, preview=PREVIEW))).status_code == 422
        assert (await _post_ask(c, device, _ask(agent, tool="Write", summary="a.md", masked=False, preview=PREVIEW))).status_code == 422
        body = _ask(agent, terminal_only=True, preview=PREVIEW)
        del body["input_hash"]
        assert (await _post_ask(c, device, body)).status_code == 422  # nothing is pressed on a phone for a terminal-only question
        withheld = {"op": "write", "blocks": [], "blocks_more": 0, "replace_all": False, "withheld": "sensitive_path"}
        assert (await _post_ask(c, device, _ask(agent, tool="Write", summary=".env.local", masked=False, preview=withheld))).status_code == 201
        assert (await _sql(fetch="SELECT count(*) FROM agent_permission_requests WHERE preview IS NOT NULL"))[0][0] == 1


async def test_the_lines_of_a_file_are_in_no_notice(world):
    async with _client() as c:
        device = await _device(c, name="d4424 mac 4949e")
        token = device["device_token"]
        agent = await _with_session(c, device)
        phone_id, der = await _register(c)
        await _pair(c, token, der)
        marker = {**PREVIEW, "blocks": [{"removed": [], "added": ["MARKER-LINE-4949-not-in-any-notice"], "removed_more": 0, "added_more": 0}]}
        assert (await _post_ask(c, device, _ask(agent, tool="Edit", summary="a.md", masked=False, preview=marker))).status_code == 201
        events = await _sql(fetch="SELECT payload::text FROM events WHERE recipient_id = :m", params={"m": OWNER_TM})  # the recipient by id (a member NAMED «Owner» exists in other orgs of a shared test database)
        assert events  # the bell line was sent …
        assert all("MARKER-LINE-4949" not in row[0] for row in events)  # … and carries only the agent and the tool
