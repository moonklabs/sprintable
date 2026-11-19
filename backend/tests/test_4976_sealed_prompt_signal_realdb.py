"""story 4976 (A3 · Kadir 871 ⓓ) — the signal that a Mac OPENS a sealed instruction: the computer says it with each startable list (`sealed_prompt: true`, next to `computer_press`), the server keeps it in the
setup's `capabilities` and the session view tells it (`sealed_prompt`, told while the computer is heard like `instruct_now`) so a sealed instruction is never made for a Mac whose app cannot open one (the card-sealing mark a phone pins
is said by an app from before too). Each test goes red without the line it names."""
from __future__ import annotations

import pytest

from tests.test_4424_desktop_setup_realdb import (  # noqa: F401 — fixtures (autouse ones apply here too)
    _addresses,
    _client,
    _dispose_global_engine_after_test,
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
        assert (await _view(c, agent))["sealed_prompt"] is False, "an app from before says nothing: a sealed instruction is not made for it"
        # both words in one list: both kept (one write — the second does not start from the old value)
        put = await c.put("/api/v2/desktop/relay/startable", json={"startable": [], "computer_press": True, "sealed_prompt": True}, headers=tok)
        assert put.status_code == 200, put.text
        assert await _caps(d["setup_id"]) == ["computer_press", "move", "sealed_prompt"]
        assert (await _view(c, agent))["sealed_prompt"] is True
        # a list with only one of them takes the other out, and leaves the creation word
        assert (await c.put("/api/v2/desktop/relay/startable", json={"startable": [], "computer_press": True}, headers=tok)).status_code == 200
        assert await _caps(d["setup_id"]) == ["computer_press", "move"]
        assert (await _view(c, agent))["sealed_prompt"] is False
        assert (await c.put("/api/v2/desktop/relay/startable", json={"startable": [], "sealed_prompt": True}, headers=tok)).status_code == 200
        assert await _caps(d["setup_id"]) == ["move", "sealed_prompt"], "the press word went out, this one came in"
        assert (await c.put("/api/v2/desktop/relay/startable", json={"startable": []}, headers=tok)).status_code == 200
        assert await _caps(d["setup_id"]) == ["move"]


async def test_the_word_is_the_boolean_true_and_nothing_else(world):
    async with _client() as c:
        _phone, devs = await _computer(c, 1, says_press=False)
        tok = _tok(devs[0][0]["device_token"])
        for bad in (False, "true", 1, "yes"):
            r = await c.put("/api/v2/desktop/relay/startable", json={"startable": [], "sealed_prompt": bad}, headers=tok)
            assert r.status_code == 422, (bad, r.text)
        assert await _caps(devs[0][0]["setup_id"]) in (None, [])
