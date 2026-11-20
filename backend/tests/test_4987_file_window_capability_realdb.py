"""story 4987 (P7 · the 10-minute files window) — the signal that a Mac accepts a files request signed by a WINDOW key: the computer says it with each startable list (`file_window: true`, next to `computer_press` and
`sealed_prompt`), the server keeps it in the setup's `capabilities` and tells the phone (the session view's `file_window`, told while the computer is heard like `sealed_prompt`; the startable view's `computers[].file_window`),
so a phone asks for a window only of a Mac that can give one. The server never knows whether a window is OPEN (a files request is a sealed envelope it carries unread): this word is all it keeps. Each test goes red without the line it names."""
from __future__ import annotations

import pytest

from tests.test_4424_desktop_setup_realdb import (  # noqa: F401 — fixtures (autouse ones apply here too)
    OWNER,
    _addresses,
    _client,
    _dispose_global_engine_after_test,
    _person,
    _sql,
    anyio_backend,
    world,
)
from tests.test_4529_desktop_relay_realdb import _tok
from tests.test_4534_desktop_commands_realdb import _remote_control_on  # noqa: F401
from tests.test_4734_computer_clock_realdb import _clean_onboarding_events, _computer  # noqa: F401

pytestmark = pytest.mark.anyio

from tests.test_4534_relay_limit_words_realdb import _view  # noqa: E402


async def _caps(sid):
    return (await _sql(fetch=f"SELECT capabilities FROM desktop_setups WHERE id = '{sid}'"))[0][0]


async def test_the_word_is_kept_next_to_the_others_shown_in_the_view_and_taken_out_when_a_list_comes_without_it(world):
    async with _client() as c:
        _phone, devs = await _computer(c, 1, says_press=False)
        (d, _a) = devs[0]
        agent = d["agents"][0]["member_id"]
        tok = _tok(d["device_token"])
        await _sql(f"UPDATE desktop_setups SET capabilities = '[\"move\"]'::jsonb WHERE id = '{d['setup_id']}'")
        assert (await _view(c, agent))["file_window"] is False, "an app from before says nothing: a phone asks no window of it"
        # all three words in one list: all kept (one write — a later word does not start from the old value)
        put = await c.put("/api/v2/desktop/relay/startable", json={"startable": [], "computer_press": True, "sealed_prompt": True, "file_window": True}, headers=tok)
        assert put.status_code == 200, put.text
        assert await _caps(d["setup_id"]) == ["computer_press", "file_window", "move", "sealed_prompt"]
        assert (await _view(c, agent))["file_window"] is True
        # a list without it takes it out and leaves the others
        assert (await c.put("/api/v2/desktop/relay/startable", json={"startable": [], "computer_press": True, "sealed_prompt": True}, headers=tok)).status_code == 200
        assert await _caps(d["setup_id"]) == ["computer_press", "move", "sealed_prompt"]
        assert (await _view(c, agent))["file_window"] is False
        # the word alone: the other two went out, this one came in, the creation word stays
        assert (await c.put("/api/v2/desktop/relay/startable", json={"startable": [], "file_window": True}, headers=tok)).status_code == 200
        assert await _caps(d["setup_id"]) == ["file_window", "move"]
        assert (await c.put("/api/v2/desktop/relay/startable", json={"startable": []}, headers=tok)).status_code == 200
        assert await _caps(d["setup_id"]) == ["move"]


async def test_the_word_is_the_boolean_true_and_nothing_else(world):
    async with _client() as c:
        _phone, devs = await _computer(c, 1, says_press=False)
        tok = _tok(devs[0][0]["device_token"])
        for bad in (False, "true", 1, "yes", [], {}):
            r = await c.put("/api/v2/desktop/relay/startable", json={"startable": [], "file_window": bad}, headers=tok)
            assert r.status_code == 422, (bad, r.text)
        assert await _caps(devs[0][0]["setup_id"]) in (None, [])


async def test_a_computer_not_heard_says_nothing_about_it_not_even_its_last_word(world):
    """the view tells `file_window` only while the computer is heard (the same gate as `sealed_prompt`) — a quiet computer reads null, never a stale true (and never a made-up false)."""
    async with _client() as c:
        _phone, devs = await _computer(c, 1, says_press=False)
        (d, _a) = devs[0]
        agent = d["agents"][0]["member_id"]
        assert (await c.put("/api/v2/desktop/relay/startable", json={"startable": [], "file_window": True}, headers=_tok(d["device_token"]))).status_code == 200
        assert (await _view(c, agent))["file_window"] is True, "heard: the word is told"
        await _sql(f"UPDATE desktop_device_tokens SET last_used_at = now() - interval '5 minutes' WHERE setup_id = '{d['setup_id']}'")
        assert (await _view(c, agent))["file_window"] is None, "not heard: not said"


async def test_the_word_does_not_disturb_the_creation_mark_of_the_sealed_instruction_and_a_report_that_is_not_applied_changes_nothing(world):
    """`note_capabilities` is one write for all the words: the sealed-instruction mark (`sealed_prompts_at`) stands as before, and a numbered report a newer one has already covered says nothing new about the Mac."""
    async with _client() as c:
        _phone, devs = await _computer(c, 1, says_press=False)
        (d, _a) = devs[0]
        tok = _tok(d["device_token"])
        assert (await c.put("/api/v2/desktop/relay/startable", json={"startable": [], "seq": 5, "sealed_prompt": True, "file_window": True}, headers=tok)).status_code == 200
        mark = (await _sql(fetch=f"SELECT sealed_prompts_at FROM desktop_setups WHERE id = '{d['setup_id']}'"))[0][0]
        assert mark is not None
        # an older report (seq 4) that says nothing is ignored: the words of seq 5 stand
        late = await c.put("/api/v2/desktop/relay/startable", json={"startable": [], "seq": 4}, headers=tok)
        assert late.status_code == 200 and late.json()["applied"] is False
        assert await _caps(d["setup_id"]) == ["file_window", "sealed_prompt"]
        # a newer one without the words takes them out; the creation mark stays (one way, as before)
        assert (await c.put("/api/v2/desktop/relay/startable", json={"startable": [], "seq": 6}, headers=tok)).status_code == 200
        assert await _caps(d["setup_id"]) in ([], None)
        assert (await _sql(fetch=f"SELECT sealed_prompts_at FROM desktop_setups WHERE id = '{d['setup_id']}'"))[0][0] == mark


async def test_the_phones_startable_list_says_file_window_per_computer_only_the_one_that_said_it(world):
    """the startable list (`computers[]`) tells the word per entry, like `computer_press`: a phone asks a window only of the Mac that said it — and a list without it takes it out again."""
    async with _client() as c:
        phone, devs = await _computer(c, 2, says_press=False)
        (d0, _a0), (d1, _a1) = devs

        async def seen():
            r = await c.get(f"/api/v2/desktop/startable?phone_key_id={phone}", headers=_person(OWNER))
            assert r.status_code == 200, r.text
            return {e["setup_id"]: e for e in r.json()["computers"]}

        assert [e["file_window"] for e in (await seen()).values()] == [False, False], "an app from before says nothing: no window asked"
        assert (await c.put("/api/v2/desktop/relay/startable", json={"startable": [], "file_window": True}, headers=_tok(d0["device_token"]))).status_code == 200
        entries = await seen()
        assert [entries[d["setup_id"]]["file_window"] for d, _a in devs] == [True, False], "only the setup whose computer said it"
        assert (await c.put("/api/v2/desktop/relay/startable", json={"startable": []}, headers=_tok(d0["device_token"]))).status_code == 200
        assert (await seen())[d0["setup_id"]]["file_window"] is False


async def test_an_agent_with_no_computer_reads_null_the_key_is_there_and_says_nothing(world):
    """the view of an agent that has no (live) computer still carries the key, null — a phone reads «no word» and never a missing field."""
    async with _client() as c:
        _phone, devs = await _computer(c, 1, says_press=False)
        (d, _a) = devs[0]
        agent = d["agents"][0]["member_id"]
        assert (await c.put("/api/v2/desktop/relay/startable", json={"startable": [], "file_window": True}, headers=_tok(d["device_token"]))).status_code == 200
        await _sql(f"UPDATE desktop_setups SET revoked_at = now() WHERE id = '{d['setup_id']}'")
        view = await _view(c, agent)
        assert "file_window" in view and view["file_window"] is None
        assert view["sealed_prompt"] is None, "the same as its neighbour"
