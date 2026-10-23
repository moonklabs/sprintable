"""story #4734 (B) — the signal that a Mac takes the press of the WHOLE computer: the computer says it with each startable list (`computer_press: true`), the server keeps it in the setup's
`capabilities` (next to what the setup's app could take at its creation) and the phone's list tells it per entry, so the screen offers one [모든 세션 종료] only for a Mac that can take the
`computer` mark (an older Mac rejects the new key). Each test goes red without the line it names."""
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
from tests.test_4734_computer_clock_realdb import _computer

pytestmark = pytest.mark.anyio


async def _entries(c, phone):
    r = await c.get(f"/api/v2/desktop/startable?phone_key_id={phone}", headers=_person(OWNER))
    assert r.status_code == 200, r.text
    return {e["setup_id"]: e for e in r.json()["computers"]}


async def _caps(sid):
    return (await _sql(fetch=f"SELECT capabilities FROM desktop_setups WHERE id = '{sid}'"))[0][0]


async def test_the_computers_list_says_computer_press_per_entry_kept_in_capabilities_and_taken_out_when_a_list_comes_without_it(world):
    async with _client() as c:
        phone, devs = await _computer(c, 2)
        (d0, _a0), (d1, _a1) = devs
        await _sql(f"UPDATE desktop_setups SET capabilities = '[\"move\"]'::jsonb WHERE id = '{d0['setup_id']}'")
        seen = await _entries(c, phone)
        assert [seen[d["setup_id"]]["computer_press"] for d, _a in devs] == [False, False], "an app from before says nothing: not offered"
        put = await c.put("/api/v2/desktop/relay/startable", json={"startable": [], "computer_press": True}, headers=_tok(d0["device_token"]))
        assert put.status_code == 200, put.text
        seen = await _entries(c, phone)
        assert [seen[d["setup_id"]]["computer_press"] for d, _a in devs] == [True, False], "only the setup whose computer said it"
        assert await _caps(d0["setup_id"]) == ["computer_press", "move"], "the word is kept next to what the setup's app could take"
        # a list without it (an app that went back) takes it out again — and leaves the other word
        assert (await c.put("/api/v2/desktop/relay/startable", json={"startable": []}, headers=_tok(d0["device_token"]))).status_code == 200
        assert (await _entries(c, phone))[d0["setup_id"]]["computer_press"] is False
        assert await _caps(d0["setup_id"]) == ["move"]


async def test_the_word_is_the_boolean_true_and_nothing_else(world):
    async with _client() as c:
        _phone, devs = await _computer(c, 1)
        tok = _tok(devs[0][0]["device_token"])
        for bad in (False, "true", 1, None, "yes"):
            r = await c.put("/api/v2/desktop/relay/startable", json={"startable": [], "computer_press": bad}, headers=tok)
            assert r.status_code == (200 if bad is None else 422), (bad, r.text)
        assert await _caps(devs[0][0]["setup_id"]) in (None, [])


async def test_a_stale_numbered_list_changes_nothing_about_the_signal(world):
    async with _client() as c:
        phone, devs = await _computer(c, 1)
        d = devs[0][0]
        tok = _tok(d["device_token"])
        assert (await c.put("/api/v2/desktop/relay/startable", json={"startable": [], "seq": 5, "computer_press": True}, headers=tok)).json()["applied"] is True
        late = await c.put("/api/v2/desktop/relay/startable", json={"startable": [], "seq": 3}, headers=tok)  # a late request that lacks the word
        assert late.json()["applied"] is False
        assert (await _entries(c, phone))[d["setup_id"]]["computer_press"] is True, "the ignored report did not take the word away"
        assert (await c.put("/api/v2/desktop/relay/startable", json={"startable": [], "seq": 6}, headers=tok)).json()["applied"] is True
        assert (await _entries(c, phone))[d["setup_id"]]["computer_press"] is False, "a newer list without it does"
        assert (await c.put("/api/v2/desktop/relay/startable", json={"startable": [], "seq": 4, "computer_press": True}, headers=tok)).json()["applied"] is False
        assert (await _entries(c, phone))[d["setup_id"]]["computer_press"] is False, "…and a late one WITH it does not give it back"
