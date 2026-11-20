"""story 4986 (P7 AC3 server side + AC4) — the usage entry's `label`: the name a person gave an account on the computer. It is display text and nothing else: the door and the reader judge it by the SAME table as the host
(`desktop_usage.label_problem` ↔ desktop-electron `claude-account-labels.ts`), a report without one CLEARS the stored one (the host speaks for the entry), an older report never covers a newer name, one account's name is
never another's, a bad label stops the WHOLE report (no half write), the table holds its length, and a row someone wrote by hand with a bad label still shows its numbers — without the name. Each test goes red without the line it names."""
from __future__ import annotations

from datetime import datetime, timedelta, timezone

import pytest

from app.services.desktop_usage import LABEL_MAX, label_problem
from tests.test_4424_desktop_setup_realdb import (  # noqa: F401 — fixtures (autouse ones apply here too)
    _addresses,
    _client,
    _dispose_global_engine_after_test,
    _sql,
    anyio_backend,
    world,
)
from tests.test_4529_desktop_relay_realdb import _tok
from tests.test_4534_desktop_commands_realdb import _remote_control_on  # noqa: F401 — autouse: the org's «원격 제어» is on
from tests.test_4981_usage_get_realdb import PUT, _computer, _entry, _read, _say

pytestmark = pytest.mark.anyio

# the host's table (desktop-electron/test/claude-account-labels.test.ts): the same cases, the same answers — a day the two tables differ is a day this file and that one disagree
GOOD = ["회사 계정", "work", "a" * LABEL_MAX, "한" * LABEL_MAX, "😀" * LABEL_MAX, "a b", "회사-1"]
BAD = [
    ("", "empty"), ("a" * (LABEL_MAX + 1), "too_long"), ("😀" * (LABEL_MAX + 1), "too_long"),
    ("a/b", "bad_chars"), ("a\\b", "bad_chars"), ("a\nb", "bad_chars"), ("a\u0000b", "bad_chars"), ("a\u202eb", "bad_chars"), ("a\u2066b", "bad_chars"),
    ("a\u200bb", "bad_chars"), ("\ufeffa", "bad_chars"), (" a", "bad_chars"), ("a ", "bad_chars"), ("a\u2028b", "bad_chars"), ("a\u0085b", "bad_chars"),
]


def test_00_the_rule_is_the_hosts_table_good_ones_pass_and_each_bad_one_says_why():
    for t in GOOD:
        assert label_problem(t) is None, repr(t)
    for t, why in BAD:
        assert label_problem(t) == why, repr(t)
    for t in (None, 5, ["a"], {"a": 1}):
        assert label_problem(t) == "empty", repr(t)           # (not a text: not a label)


async def _label_of(c, agent, account="a1b2c3d4e5f6"):
    r = await _read(c, agent)
    assert r.status_code == 200, r.text
    (u,) = [u for u in r.json()["usage"] if u["account"] == account]
    return u["label"]


async def test_01_a_label_is_kept_and_shown_with_its_account_and_a_report_without_one_clears_it(world):
    async with _client() as c:
        device, agent = await _computer(c, "d4986 mac label")
        await _say(c, device, _entry(label="회사 계정"))
        assert await _label_of(c, agent) == "회사 계정"
        await _say(c, device, _entry(label="개인"))                                    # a new name replaces the old
        assert await _label_of(c, agent) == "개인"
        await _say(c, device, _entry())                                                # the host says no name (the person removed it): it is gone here too
        assert await _label_of(c, agent) is None


async def test_02_two_accounts_of_one_cli_keep_their_own_names(world):
    async with _client() as c:
        device, agent = await _computer(c, "d4986 mac two")
        await _say(c, device, _entry(account="aaaaaaaaaaaa", label="회사 계정"), _entry(account="bbbbbbbbbbbb", label="개인"))
        assert await _label_of(c, agent, "aaaaaaaaaaaa") == "회사 계정"
        assert await _label_of(c, agent, "bbbbbbbbbbbb") == "개인"
        await _say(c, device, _entry(account="aaaaaaaaaaaa", label="회사 계정", pct=64))   # one account's later report does not touch the other's name
        assert await _label_of(c, agent, "bbbbbbbbbbbb") == "개인"


async def test_03_an_older_report_never_covers_a_newer_name(world):
    async with _client() as c:
        device, agent = await _computer(c, "d4986 mac older")
        await _say(c, device, _entry(seen_ago=10, label="새 이름"))
        await _say(c, device, _entry(seen_ago=600, label="옛 이름"))                       # a late request about an earlier moment
        assert await _label_of(c, agent) == "새 이름"
        await _say(c, device, _entry(seen_ago=600))                                       # … and a late one WITHOUT a name does not clear it either
        assert await _label_of(c, agent) == "새 이름"


@pytest.mark.parametrize("bad", [t for t, _ in BAD])
async def test_04_a_bad_label_stops_the_whole_report_nothing_of_it_is_written(world, bad):
    async with _client() as c:
        device, agent = await _computer(c, "d4986 mac bad")
        body = {"usage": [_entry(account="aaaaaaaaaaaa", pct=11), _entry(account="bbbbbbbbbbbb", pct=22, label=bad)]}
        r = await c.put(PUT, json=body, headers=_tok(device["device_token"]))
        assert r.status_code == 422, r.text
        assert await _sql(fetch=f"SELECT count(*) FROM desktop_usage WHERE setup_id = '{device['setup_id']}'") == [(0,)]   # not even the good entry (no half write)


@pytest.mark.parametrize("bad", [5, True, ["a"], {"a": 1}, 1.5])
async def test_05_a_label_that_is_not_a_text_is_refused(world, bad):
    async with _client() as c:
        device, _agent = await _computer(c, "d4986 mac type")
        r = await c.put(PUT, json={"usage": [_entry(label=bad)]}, headers=_tok(device["device_token"]))
        assert r.status_code == 422, r.text


async def test_06_the_table_holds_the_length_and_the_reader_leaves_a_bad_name_out_but_keeps_the_numbers(world):
    async with _client() as c:
        device, agent = await _computer(c, "d4986 mac reader")
        await _say(c, device, _entry(account="aaaaaaaaaaaa", pct=33), _entry(account="bbbbbbbbbbbb", pct=44))
        sid = device["setup_id"]
        with pytest.raises(Exception):                                                    # the table itself: 41 characters, and an empty text, are refused
            await _sql(f"UPDATE desktop_usage SET label = '{'x' * 41}' WHERE setup_id = '{sid}' AND account = 'aaaaaaaaaaaa'")
        with pytest.raises(Exception):
            await _sql(f"UPDATE desktop_usage SET label = '' WHERE setup_id = '{sid}' AND account = 'aaaaaaaaaaaa'")
        # a row written by hand with a name the door would never let in (a slash passes the table's length check): the reader leaves the NAME out, never the numbers, never a 500
        await _sql(f"UPDATE desktop_usage SET label = '/Users/me/.claude' WHERE setup_id = '{sid}' AND account = 'aaaaaaaaaaaa'")
        await _sql(f"UPDATE desktop_usage SET label = 'ok name' WHERE setup_id = '{sid}' AND account = 'bbbbbbbbbbbb'")
        r = await _read(c, agent)
        assert r.status_code == 200, r.text
        by = {u["account"]: u for u in r.json()["usage"]}
        assert by["aaaaaaaaaaaa"]["label"] is None and by["aaaaaaaaaaaa"]["windows"][0]["used_percent"] == 33
        assert by["bbbbbbbbbbbb"]["label"] == "ok name"


async def test_07_the_name_is_not_in_any_log(world, caplog):
    import logging
    caplog.set_level(logging.DEBUG)
    async with _client() as c:
        device, _agent = await _computer(c, "d4986 mac log")
        await _say(c, device, _entry(label="비밀스러운 이름"))
    assert "비밀스러운 이름" not in caplog.text
