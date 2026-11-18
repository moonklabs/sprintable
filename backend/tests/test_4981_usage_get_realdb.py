"""story 4981 (연결 ③ · PR 3) — `GET /api/v2/agents/{agent}/desktop-usage`: what a person sees of the agent usage numbers of the computer that agent runs on. The reader is whoever may see the agent's session (the same
`can_view` as `desktop-session` — no new role), a person's session (an agent key is 403), the numbers are the host's own words with its «seen_at», and a computer other than the agent's own, another organization's, a
disconnected one — or any at all while the organization's «원격 제어» is off — is never in it. Each test goes red without the line it names."""
from __future__ import annotations

from datetime import datetime, timedelta, timezone

import pytest

from tests.test_4424_desktop_setup_realdb import (  # noqa: F401 — fixtures (autouse ones apply here too)
    ORG,
    OWNER,
    OWNER_TM,
    PLAIN,
    OUTSIDER,
    _addresses,
    _client,
    _dispose_global_engine_after_test,
    _person,
    _sql,
    anyio_backend,
    world,
)
from tests.test_4529_desktop_relay_realdb import _device, _tok
from tests.test_4534_desktop_commands_realdb import _remote_control_on  # noqa: F401 — autouse: the org's «원격 제어» is on

pytestmark = pytest.mark.anyio

PUT = "/api/v2/desktop/relay/usage"


def _iso(dt: datetime) -> str:
    return dt.astimezone(timezone.utc).isoformat()


def _entry(runtime="claude", account="a1b2c3d4e5f6", pct=63, seen_ago=30, **extra):
    now = datetime.now(timezone.utc)
    return {"runtime": runtime, "account": account, "seen_at": _iso(now - timedelta(seconds=seen_ago)), "state": "windows",
            "windows": [{"kind": "five_hour", "minutes": 300, "used_percent": pct, "resets_at": _iso(now + timedelta(hours=2))}], **extra}


async def _say(c, device, *entries):
    r = await c.put(PUT, json={"usage": list(entries)}, headers=_tok(device["device_token"]))
    assert r.status_code == 200, r.text


async def _read(c, agent, headers=None):
    return await c.get(f"/api/v2/agents/{agent}/desktop-usage", headers=headers or _person(OWNER))


async def _computer(c, name):
    device = await _device(c, name=name)
    return device, device["agents"][0]["member_id"]


async def test_01_the_person_who_may_see_the_agent_sees_its_computers_numbers_with_when_they_were_seen(world):
    async with _client() as c:
        device, agent = await _computer(c, "d4981 mac read")
        await _say(c, device, _entry("claude", "aaaaaaaaaaaa", 63), _entry("claude", "bbbbbbbbbbbb", 12), _entry("codex", "cccccccccccc", 7, seen_ago=90))
        r = await _read(c, agent)
        assert r.status_code == 200, r.text
        v = r.json()
        assert set(v) == {"agent_id", "remote_control", "setup_id", "device_name", "connected", "usage"}              # the closed list of keys
        assert v["agent_id"] == agent and v["setup_id"] == device["setup_id"] and v["remote_control"] is True
        assert [(u["runtime"], u["account"]) for u in v["usage"]] == [("claude", "aaaaaaaaaaaa"), ("claude", "bbbbbbbbbbbb"), ("codex", "cccccccccccc")]
        first = v["usage"][0]
        assert set(first) == {"runtime", "account", "state", "why", "windows", "seen_at"}
        assert first["state"] == "windows" and first["windows"][0]["used_percent"] == 63 and first["windows"][0]["kind"] == "five_hour"
        assert datetime.fromisoformat(first["seen_at"]) < datetime.now(timezone.utc)


async def test_02_the_word_unavailable_comes_with_its_reason_and_no_numbers(world):
    async with _client() as c:
        device, agent = await _computer(c, "d4981 mac word read")
        await _say(c, device, {"runtime": "claude", "account": "aaaaaaaaaaaa", "seen_at": _iso(datetime.now(timezone.utc)), "state": "unavailable", "why": "not_read"})
        (u,) = (await _read(c, agent)).json()["usage"]
        assert (u["state"], u["why"], u["windows"]) == ("unavailable", "not_read", [])


async def test_03_nobody_else_sees_it_a_person_without_access_to_the_agent_an_outsider_and_an_agent_key(world):
    async with _client() as c:
        device, agent = await _computer(c, "d4981 mac who")
        await _say(c, device, _entry())
        r = await _read(c, agent, _person(PLAIN))                                                                  # an org member with no access to the agent's project
        assert (r.status_code, r.json()["error"]["code"]) == (404, "agent_not_found")                              # the very answer of the session read
        r = await _read(c, agent, _person(OUTSIDER))                                                               # another organization's admin, asking in this org
        assert r.status_code in (403, 404), r.text
        r = await _read(c, agent, {"Authorization": f"Bearer {device['agents'][0]['api_key']}", "X-Org-Id": str(ORG)})
        assert (r.status_code, r.json()["error"]["code"]) == (403, "person_session_required")
        assert (await c.get(f"/api/v2/agents/{agent}/desktop-usage")).status_code in (401, 403)                    # no login


async def test_04_the_same_check_as_the_session_read_gives_the_same_answer(world):
    async with _client() as c:
        _device_a, agent = await _computer(c, "d4981 mac same")
        for who in (OWNER, PLAIN):
            s = await c.get(f"/api/v2/agents/{agent}/desktop-session", headers=_person(who))
            u = await _read(c, agent, _person(who))
            assert s.status_code == u.status_code, (who, s.status_code, u.status_code)                              # visible to the one exactly when visible to the other


async def test_05_only_the_agents_own_computer_is_in_it_never_another_computers_numbers(world):
    async with _client() as c:
        a, agent_a = await _computer(c, "d4981 mac A")
        b, _agent_b = await _computer(c, "d4981 mac B")
        await _say(c, a, _entry(account="aaaaaaaaaaaa", pct=11))
        await _say(c, b, _entry(account="bbbbbbbbbbbb", pct=99))
        v = (await _read(c, agent_a)).json()
        assert v["setup_id"] == a["setup_id"] and [u["account"] for u in v["usage"]] == ["aaaaaaaaaaaa"]
        assert [w["used_percent"] for u in v["usage"] for w in u["windows"]] == [11]                    # (the numbers themselves — not a text search: the times in the same text carry random digits, a «99» among them was the one flake)


async def test_06_a_computer_that_never_said_anything_has_no_rows_and_an_agent_with_no_computer_is_empty_not_an_error(world):
    async with _client() as c:
        _device_a, agent = await _computer(c, "d4981 mac quiet")
        v = (await _read(c, agent)).json()
        assert v["usage"] == [] and v["setup_id"] is not None
        r = await c.get("/api/v2/agents/d4424000-0000-0000-0000-000000000016/desktop-usage", headers=_person(OWNER))   # EXISTING: an agent with a key but no computer here
        assert r.status_code in (200, 404)
        if r.status_code == 200:
            assert r.json()["usage"] == [] and r.json()["setup_id"] is None


async def test_07_connected_follows_the_same_shown_rule_as_the_rest_and_the_numbers_stay_with_their_seen_at(world):
    async with _client() as c:
        device, agent = await _computer(c, "d4981 mac connected")
        await _say(c, device, _entry(seen_ago=600))
        await _sql(f"UPDATE desktop_device_tokens SET last_used_at = now(), last_heard_at = now() WHERE setup_id = '{device['setup_id']}'")   # its stream ticked and it spoke just now (the usage report itself no longer counts as a tick — Kadir 5854)
        assert (await _read(c, agent)).json()["connected"] is True
        await _sql(f"UPDATE desktop_device_tokens SET last_used_at = now() - interval '1 hour', last_heard_at = now() - interval '1 hour' WHERE setup_id = '{device['setup_id']}'")
        v = (await _read(c, agent)).json()
        assert v["connected"] is False and len(v["usage"]) == 1                                                       # disconnected: the last numbers stay, with the time they were seen


async def test_08_with_remote_control_off_nothing_of_the_computer_is_told(world):
    async with _client() as c:
        device, agent = await _computer(c, "d4981 mac off")
        await _say(c, device, _entry())
        await _sql(f"UPDATE organizations SET remote_control_enabled_at = NULL WHERE id = '{ORG}'")
        v = (await _read(c, agent)).json()
        assert v["remote_control"] is False and v["usage"] == [] and v["setup_id"] is None


async def test_09_a_disconnected_setup_is_not_told(world):
    async with _client() as c:
        device, agent = await _computer(c, "d4981 mac gone")
        await _say(c, device, _entry())
        await _sql(f"UPDATE desktop_setups SET revoked_at = now() WHERE id = '{device['setup_id']}'")
        v = (await _read(c, agent)).json()
        assert v["usage"] == [] and v["setup_id"] is None


async def test_10_the_read_changes_nothing_and_leaks_no_path_or_agent(world):
    async with _client() as c:
        device, agent = await _computer(c, "d4981 mac pure")
        await _say(c, device, _entry())
        before = await _sql(fetch=f"SELECT runtime, account, seen_at, reported_at FROM desktop_usage WHERE setup_id = '{device['setup_id']}'")
        text = (await _read(c, agent)).text
        after = await _sql(fetch=f"SELECT runtime, account, seen_at, reported_at FROM desktop_usage WHERE setup_id = '{device['setup_id']}'")
        assert before == after
        for leaked in ("/Users", ".claude", "member_id", "agents"):
            assert leaked not in text


async def test_11_a_row_that_the_door_would_not_have_let_in_is_left_out_and_never_leaks_an_extra_key(world):
    """Kadir 5854 · PR 3 condition: the read judges each stored row by the door's own model again — the table's CHECK holds only the outer shape, so a row written some other way can carry an odd element."""
    import json

    async with _client() as c:
        device, agent = await _computer(c, "d4981 mac odd rows")
        await _say(c, device, _entry("claude", "aaaaaaaaaaaa", 63))
        sid = device["setup_id"]
        odd = {
            "claude|bbbbbbbbbbbb": [{"kind": "five_hour", "minutes": 300, "used_percent": 5, "resets_at": None, "secret": "sk-leak"}],    # an extra key
            "claude|cccccccccccc": [{"kind": "five_hour", "minutes": 300, "used_percent": 500, "resets_at": None}],                         # out of range
            "codex|dddddddddddd": [{"kind": "monthly", "minutes": 300, "used_percent": 5, "resets_at": None}],                              # a word not on the list
            "codex|eeeeeeeeeeee": [{"kind": "five_hour", "minutes": 300, "used_percent": "5", "resets_at": None}],                          # a number as text
            "codex|ffffffffffff": [5],                                                                                                      # not an object at all
        }
        for key, windows in odd.items():
            runtime, account = key.split("|")
            await _sql(f"INSERT INTO desktop_usage (setup_id, runtime, account, state, why, windows, seen_at) VALUES ('{sid}', '{runtime}', '{account}', 'windows', NULL, '{json.dumps(windows)}', now())")
        r = await _read(c, agent)
        assert r.status_code == 200, r.text
        assert [u["account"] for u in r.json()["usage"]] == ["aaaaaaaaaaaa"]                              # only the row that passes the door's model
        assert "sk-leak" not in r.text and "secret" not in r.text


async def test_12_what_is_returned_is_built_from_the_models_fields_not_from_the_stored_json(world):
    async with _client() as c:
        device, agent = await _computer(c, "d4981 mac built")
        await _say(c, device, _entry("codex", "aaaaaaaaaaaa", 40))
        (u,) = (await _read(c, agent)).json()["usage"]
        assert set(u["windows"][0]) == {"kind", "minutes", "used_percent", "resets_at"} and u["windows"][0]["used_percent"] == 40
        assert u["seen_at"].endswith("+00:00") and u["windows"][0]["resets_at"].endswith("+00:00")        # one clock for every reader


async def test_13_the_read_is_bounded_by_the_same_cap_as_the_door_even_if_the_table_holds_more(world):
    async with _client() as c:
        device, agent = await _computer(c, "d4981 mac bound")
        sid = device["setup_id"]
        for i in range(12):                                                                            # written some other way than the door (the door keeps at most eight)
            await _sql(f"INSERT INTO desktop_usage (setup_id, runtime, account, state, why, windows, seen_at) VALUES ('{sid}', 'claude', 'acct{i:04d}xyz', 'windows', NULL, "
                       f"'[{{\"kind\": \"five_hour\", \"minutes\": 300, \"used_percent\": {i}, \"resets_at\": null}}]', now())")
        usage = (await _read(c, agent)).json()["usage"]
        assert len(usage) == 8


async def test_14_odd_rows_that_sort_first_do_not_hide_the_good_ones_behind_the_cap(world):
    async with _client() as c:
        device, agent = await _computer(c, "d4981 mac hide")
        sid = device["setup_id"]
        await _say(c, device, _entry("codex", "zzgoodaccount1", 77), _entry("codex", "zzgoodaccount2", 78))
        for i in range(10):                                                                            # ten odd rows (an extra key) that sort BEFORE the good ones
            await _sql(f"INSERT INTO desktop_usage (setup_id, runtime, account, state, why, windows, seen_at) VALUES ('{sid}', 'claude', 'aaodd{i:04d}xy', 'windows', NULL, "
                       f"'[{{\"kind\": \"five_hour\", \"minutes\": 300, \"used_percent\": 1, \"resets_at\": null, \"extra\": 1}}]', now() - interval '1 hour')")  # (older than the good ones, so the door's own row cap keeps those)
        usage = (await _read(c, agent)).json()["usage"]
        assert [u["account"] for u in usage] == ["zzgoodaccount1", "zzgoodaccount2"]                   # both good rows come back
