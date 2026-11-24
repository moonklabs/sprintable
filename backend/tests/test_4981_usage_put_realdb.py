"""story 4981 (연결 ③) — `PUT /api/v2/desktop/relay/usage`: the computer says how much of each agent limit window it has used. Closed numbers only, for ONE computer (the device token's own), older reports never
cover newer ones, counted per verified device before anything is written, a closed computer refused, nothing logged. Each test goes red without the line it names."""
from __future__ import annotations

import logging
from datetime import datetime, timedelta, timezone

import pytest

from tests.test_4424_desktop_setup_realdb import (  # noqa: F401 — fixtures (autouse ones apply here too)
    _addresses,
    _client,
    _dispose_global_engine_after_test,
    _sql,
    anyio_backend,
    world,
)
from tests.test_4529_desktop_relay_realdb import _device as _make_device
from tests.test_4529_desktop_relay_realdb import _tok
from tests.test_4534_desktop_commands_realdb import _remote_control_on  # noqa: F401 — an autouse fixture: the org's «원격 제어» is on (the whole device line is off while it is off — 409, token kept)

pytestmark = pytest.mark.anyio

URL = "/api/v2/desktop/relay/usage"


def _iso(dt: datetime) -> str:
    return dt.astimezone(timezone.utc).isoformat()


def _win(kind="five_hour", pct=63, minutes=300, resets_in=3600, **extra):
    return {"kind": kind, "minutes": minutes, "used_percent": pct, "resets_at": _iso(datetime.now(timezone.utc) + timedelta(seconds=resets_in)) if resets_in is not None else None, **extra}


ACCT = "a1b2c3d4e5f6"  # the host's opaque id of a settings folder


def _entry(runtime="claude", seen_ago=0, windows=None, account=ACCT, **extra):
    return {"runtime": runtime, "account": account, "seen_at": _iso(datetime.now(timezone.utc) - timedelta(seconds=seen_ago)), "state": "windows", "windows": windows if windows is not None else [_win()], **extra}


def _word(runtime="claude", why="api_key", seen_ago=0, account=ACCT):
    return {"runtime": runtime, "account": account, "seen_at": _iso(datetime.now(timezone.utc) - timedelta(seconds=seen_ago)), "state": "unavailable", "why": why}


async def _device(c, name):
    return await _make_device(c, name=name)


async def _put(c, device, *entries, headers=None):
    return await c.put(URL, json={"usage": list(entries)}, headers=headers or _tok(device["device_token"]))


async def _rows(setup_id):
    return await _sql(fetch=f"SELECT runtime, state, why, windows, seen_at, account FROM desktop_usage WHERE setup_id = '{setup_id}' ORDER BY runtime, account")


async def test_01_the_closed_numbers_are_kept_per_cli_and_the_computer_counts_as_heard_from(world):
    async with _client() as c:
        d = await _device(c, "d4981 mac usage")
        await _sql(f"UPDATE desktop_device_tokens SET last_heard_at = NULL WHERE setup_id = '{d['setup_id']}'")
        r = await _put(c, d, _entry("claude", windows=[_win("five_hour", 63, 300), _win("seven_day", 41, 10_080, 86_400)]), _entry("codex", windows=[_win("five_hour", 9, 300)]))
        assert r.status_code == 200 and r.json() == {"ok": True, "written": 2}, r.text
        rows = {row[0]: row for row in await _rows(d["setup_id"])}
        assert set(rows) == {"claude", "codex"}
        assert [(w["kind"], w["used_percent"], w["minutes"]) for w in rows["claude"][3]] == [("five_hour", 63, 300), ("seven_day", 41, 10_080)]
        assert rows["codex"][1] == "windows" and rows["codex"][2] is None
        heard = await _sql(fetch=f"SELECT last_heard_at IS NOT NULL FROM desktop_device_tokens WHERE setup_id = '{d['setup_id']}' AND revoked_at IS NULL")
        assert heard == [(True,)]                                                              # the computer spoke


async def test_02_the_word_unavailable_carries_its_reason_and_no_numbers_and_numbers_replace_it(world):
    async with _client() as c:
        d = await _device(c, "d4981 mac word")
        assert (await _put(c, d, _word("claude", "not_read", seen_ago=30))).status_code == 200
        assert [(r[0], r[1], r[2], r[3]) for r in await _rows(d["setup_id"])] == [("claude", "unavailable", "not_read", [])]
        assert (await _put(c, d, _entry("claude", seen_ago=0))).status_code == 200
        (row,) = await _rows(d["setup_id"])
        assert row[1] == "windows" and row[2] is None and row[3][0]["used_percent"] == 63        # the numbers take the place of the word


@pytest.mark.parametrize("bad", [
    {"usage": []},                                                                        # an empty report says nothing
    {"usage": [_entry("claude"), _entry("claude")]},                                      # one entry per CLI and account
    {"usage": [_entry("claude", account=f"acct{i:04d}xyz") for i in range(9)]},          # at most eight entries
    {"usage": [_entry(account="")]}, {"usage": [_entry(account="ABCDEFGH1234")]}, {"usage": [_entry(account="short")]},             # an account id is 8–32 of a-z 0-9 …
    {"usage": [_entry(account="a" * 33)]}, {"usage": [_entry(account="/Users/me/.claude")]}, {"usage": [_entry(account="me@example.com")]},   # … never a path or a name
    {"usage": [{k: v for k, v in _entry().items() if k != "account"}]},                  # and it is required
    {"usage": [_entry("gemini")]},                                                        # a CLI this server does not know
    {"usage": [_entry(windows=[_win(pct=101)])]}, {"usage": [_entry(windows=[_win(pct=-1)])]},
    {"usage": [_entry(windows=[_win(pct=63.5)])]}, {"usage": [_entry(windows=[_win(pct="63")])]}, {"usage": [_entry(windows=[_win(pct=True)])]},   # a whole number as written
    {"usage": [_entry(windows=[_win(minutes=0)])]}, {"usage": [_entry(windows=[_win(minutes=525_601)])]}, {"usage": [_entry(windows=[_win(minutes=1.5)])]},
    {"usage": [_entry(windows=[_win(kind="monthly")])]},                                  # a word of the closed list
    {"usage": [_entry(windows=[])]},                                                      # `windows` with no numbers
    {"usage": [_entry(windows=[_win()] * 5)]},                                            # at most four windows
    {"usage": [_entry(why="api_key")]},                                                   # numbers and a reason
    {"usage": [{**_word(), "windows": [_win()]}]},                                        # a reason and numbers
    {"usage": [{**_word(), "why": None}]}, {"usage": [{**_word(), "why": "because"}]},   # the word without a closed reason
    {"usage": [_entry(windows=[_win(session_id="abc")])]},                                # nothing but the closed fields: an extra one on a window …
    {"usage": [_entry(cwd="/Users/x/secret")]},                                           # … on an entry …
    {"usage": [_entry()], "account": "me@example.com"},                                   # … on the report
    {"usage": [_entry(windows=[{**_win(), "resets_at": "2030-01-01T00:00:00"}])]},        # a time with no zone
    {"usage": [{**_entry(), "seen_at": "yesterday"}]},
    {"usage": "x"}, {}, [],
])
async def test_03_nothing_but_the_closed_shape_gets_in(world, bad):
    async with _client() as c:
        d = await _device(c, "d4981 mac closed")
        r = await c.put(URL, json=bad, headers=_tok(d["device_token"]))
        assert r.status_code == 422, (bad, r.status_code, r.text)
        assert await _rows(d["setup_id"]) == []                                           # nothing was written


async def test_04_a_reset_time_further_ahead_than_a_window_can_be_is_refused_and_a_future_seen_at_is_cut_to_now(world):
    async with _client() as c:
        d = await _device(c, "d4981 mac horizon")
        r = await _put(c, d, _entry(windows=[_win(resets_in=401 * 86_400)]))
        assert r.status_code == 422 and "usage_reset_out_of_range" in r.text, r.text
        assert await _rows(d["setup_id"]) == []
        assert (await _put(c, d, _entry(windows=[_win(resets_in=399 * 86_400)]))).status_code == 200      # a long but possible one passes
        assert (await _put(c, d, _entry(seen_ago=-86_400))).status_code == 200                              # the host's clock a day ahead
        (row,) = await _rows(d["setup_id"])
        assert row[4] <= datetime.now(timezone.utc)                                                          # never stored as a time in the future


async def test_05_an_older_report_never_covers_a_newer_one_and_an_equal_one_does(world):
    async with _client() as c:
        d = await _device(c, "d4981 mac order")
        assert (await _put(c, d, _entry(seen_ago=10, windows=[_win(pct=50)]))).json()["written"] == 1
        late = await _put(c, d, _entry(seen_ago=300, windows=[_win(pct=10)]))                                # a late request carrying an older view
        assert late.status_code == 200 and late.json()["written"] == 0
        assert (await _rows(d["setup_id"]))[0][3][0]["used_percent"] == 50
        assert (await _put(c, d, _entry(seen_ago=5, windows=[_win(pct=55)]))).json()["written"] == 1         # a newer one replaces
        assert (await _rows(d["setup_id"]))[0][3][0]["used_percent"] == 55
        late_heard = await _sql(fetch=f"SELECT last_heard_at FROM desktop_device_tokens WHERE setup_id = '{d['setup_id']}' AND revoked_at IS NULL")
        assert late_heard[0][0] is not None                                                                  # an ignored report is still the computer speaking


async def test_06_a_report_writes_only_the_computer_whose_token_it_carries(world):
    async with _client() as c:
        a = await _device(c, "d4981 mac A")
        b = await _device(c, "d4981 mac B")
        assert (await _put(c, a, _entry(windows=[_win(pct=11)]))).status_code == 200
        assert (await _put(c, b, _entry(windows=[_win(pct=22)]))).status_code == 200
        assert (await _rows(a["setup_id"]))[0][3][0]["used_percent"] == 11 and (await _rows(b["setup_id"]))[0][3][0]["used_percent"] == 22
        # the body names no computer; one that tries to (an id of another) is not a field of the report
        r = await c.put(URL, json={"usage": [_entry()], "setup_id": b["setup_id"]}, headers=_tok(a["device_token"]))
        assert r.status_code == 422
        assert (await c.put(URL, json={"usage": [_entry()]}, headers=_tok("sdt_" + "x" * 43))).status_code in (401, 403)   # no such token
        assert (await c.put(URL, json={"usage": [_entry()]})).status_code in (401, 403, 422)                                  # no token


async def test_07_a_revoked_token_and_a_closed_computer_are_refused_and_write_nothing(world):
    async with _client() as c:
        d = await _device(c, "d4981 mac revoked")
        await _sql(f"UPDATE desktop_device_tokens SET revoked_at = now() WHERE setup_id = '{d['setup_id']}'")
        assert (await _put(c, d, _entry())).status_code in (401, 403)
        assert await _rows(d["setup_id"]) == []
        e = await _device(c, "d4981 mac closed")
        await _sql(f"UPDATE desktop_setups SET revoked_at = now() WHERE id = '{e['setup_id']}'")
        r = await _put(c, e, _entry())
        assert r.status_code in (401, 403, 409), r.text
        assert await _rows(e["setup_id"]) == []


async def test_08_counted_per_verified_device_before_anything_is_written(world):
    async with _client() as c:
        a = await _device(c, "d4981 mac limit A")
        b = await _device(c, "d4981 mac limit B")
        for i in range(20):
            r = await _put(c, a, _entry(seen_ago=100 - i))
            assert r.status_code == 200, (i, r.text)
        r = await _put(c, a, _entry(seen_ago=0, windows=[_win(pct=99)]))
        assert r.status_code == 429 and "RATE_LIMITED" in r.text and int(r.headers["retry-after"]) >= 1
        assert (await _rows(a["setup_id"]))[0][3][0]["used_percent"] != 99                                    # the refused one wrote nothing
        assert (await _put(c, b, _entry())).status_code == 200                                               # another computer has its own count
        # an unverified header never counts for another: bad tokens do not use up a real device's allowance
        for _ in range(25):
            await c.put(URL, json={"usage": [_entry()]}, headers=_tok("sdt_" + "y" * 43))
        assert (await _put(c, b, _entry())).status_code == 200


async def test_09_nothing_of_the_body_is_logged(world, caplog):
    async with _client() as c:
        d = await _device(c, "d4981 mac quiet")
        marker = datetime.now(timezone.utc) + timedelta(seconds=123_457)
        with caplog.at_level(logging.DEBUG):
            r = await _put(c, d, _entry(windows=[_win(pct=77, resets_in=123_457)]))
        assert r.status_code == 200
        text = "\n".join(rec.getMessage() for rec in caplog.records)
        assert "used_percent" not in text and _iso(marker)[:16] not in text and "123457" not in text


async def test_10_the_rows_go_with_the_computer(world):
    async with _client() as c:
        d = await _device(c, "d4981 mac cascade")
        assert (await _put(c, d, _entry("claude"), _entry("codex"))).status_code == 200
        assert len(await _rows(d["setup_id"])) == 2
        await _sql(f"DELETE FROM desktop_setups WHERE id = '{d['setup_id']}'")
        assert await _rows(d["setup_id"]) == []


async def test_11_the_database_itself_refuses_a_shape_the_door_would_not_let_in(world):
    async with _client() as c:
        d = await _device(c, "d4981 mac check")
        sid = d["setup_id"]
        for sql in (
            f"INSERT INTO desktop_usage (setup_id, runtime, account, state, why, windows, seen_at) VALUES ('{sid}', 'claude', '/Users/me/.claude', 'unavailable', 'api_key', '[]', now())",   # an account that is a path (not an opaque id)
            f"INSERT INTO desktop_usage (setup_id, runtime, account, state, why, windows, seen_at) VALUES ('{sid}', 'claude', 'SHORT', 'unavailable', 'api_key', '[]', now())",
            f"INSERT INTO desktop_usage (setup_id, runtime, account, state, why, windows, seen_at) VALUES ('{sid}', 'not-a-cli', 'a1b2c3d4e5f6', 'windows', NULL, '[{{}}]', now())",       # a CLI outside the closed list (story 5008: `gemini` is in the registry now — the list is migration 0497's names — so a name nobody has)
            f"INSERT INTO desktop_usage (setup_id, runtime, account, state, why, windows, seen_at) VALUES ('{sid}', 'claude', 'a1b2c3d4e5f6', 'windows', 'api_key', '[{{}}]', now())",  # numbers with a reason
            f"INSERT INTO desktop_usage (setup_id, runtime, account, state, why, windows, seen_at) VALUES ('{sid}', 'claude', 'a1b2c3d4e5f6', 'windows', NULL, '[]', now())",         # numbers with none
            f"INSERT INTO desktop_usage (setup_id, runtime, account, state, why, windows, seen_at) VALUES ('{sid}', 'claude', 'a1b2c3d4e5f6', 'unavailable', NULL, '[]', now())",     # the word with no reason
            f"INSERT INTO desktop_usage (setup_id, runtime, account, state, why, windows, seen_at) VALUES ('{sid}', 'claude', 'a1b2c3d4e5f6', 'unavailable', 'api_key', '[{{}}]', now())",  # the word with numbers
            f"INSERT INTO desktop_usage (setup_id, runtime, account, state, why, windows, seen_at) VALUES ('{sid}', 'claude', 'a1b2c3d4e5f6', 'windows', NULL, '[{{}},{{}},{{}},{{}},{{}}]', now())",  # five windows
        ):
            with pytest.raises(Exception):
                await _sql(sql)
        assert await _rows(sid) == []


async def test_12_the_service_itself_refuses_a_computer_that_was_closed_while_the_request_ran(world):
    """the token door judges first; this is the second guard for a computer closed between that check and the write (the same request) — called on the service with the setup row the request had loaded"""
    from sqlalchemy import select

    from app.core.database import async_session_factory
    from app.models.desktop_setup import DesktopSetup
    from app.services import desktop_usage
    from app.services.desktop_relay import DesktopRelayError

    async with _client() as c:
        d = await _device(c, "d4981 mac race")
        async with async_session_factory() as s:
            setup = (await s.execute(select(DesktopSetup).where(DesktopSetup.id == d["setup_id"]))).scalar_one()
            await _sql(f"UPDATE desktop_setups SET revoked_at = now() WHERE id = '{d['setup_id']}'")        # closed after the request loaded `setup`
            report = desktop_usage.UsageReport.model_validate({"usage": [_entry()]})
            with pytest.raises(DesktopRelayError) as e:
                await desktop_usage.apply_usage(s, setup, report)
            assert e.value.status == 409 and e.value.code == "device_disconnected"
        assert await _rows(d["setup_id"]) == []


async def test_13_two_logins_of_one_cli_on_one_computer_are_two_rows_and_a_login_is_replaced_only_by_itself(world):
    async with _client() as c:
        d = await _device(c, "d4981 mac accounts")
        assert (await _put(c, d, _entry("claude", account="aaaaaaaa1111", windows=[_win(pct=10)]), _entry("claude", account="bbbbbbbb2222", windows=[_win(pct=90)]))).json()["written"] == 2
        rows = {r[5]: r[3][0]["used_percent"] for r in await _rows(d["setup_id"])}
        assert rows == {"aaaaaaaa1111": 10, "bbbbbbbb2222": 90}                                        # one did not cover the other
        assert (await _put(c, d, _entry("claude", account="aaaaaaaa1111", windows=[_win(pct=11)]))).json()["written"] == 1
        rows = {r[5]: r[3][0]["used_percent"] for r in await _rows(d["setup_id"])}
        assert rows == {"aaaaaaaa1111": 11, "bbbbbbbb2222": 90}                                        # a login is replaced by its own newer report only


async def test_14_a_computer_keeps_at_most_eight_rows_the_longest_unseen_go_first(world):
    async with _client() as c:
        d = await _device(c, "d4981 mac cap")
        assert (await _put(c, d, *[_entry("claude", account=f"acct{i:04d}old", seen_ago=1000 - i) for i in range(8)])).status_code == 200
        assert len(await _rows(d["setup_id"])) == 8
        assert (await _put(c, d, _entry("codex", account="newcodexacct1", seen_ago=0))).status_code == 200
        rows = await _rows(d["setup_id"])
        assert len(rows) == 8                                                                          # the table did not grow
        assert "newcodexacct1" in {r[5] for r in rows} and "acct0000old" not in {r[5] for r in rows}   # the one seen longest ago went


async def test_15_reports_that_arrive_together_never_leave_the_computer_with_more_than_eight_rows(world):
    import asyncio

    async with _client() as c:
        d = await _device(c, "d4981 mac race rows")
        batches = [[_entry("claude", account=f"r{b}acct{i:04d}xx", seen_ago=100 - b) for i in range(8)] for b in range(6)]
        results = await asyncio.gather(*[_put(c, d, *batch) for batch in batches])
        assert all(r.status_code == 200 for r in results), [r.text for r in results if r.status_code != 200]
        rows = await _rows(d["setup_id"])
        assert len(rows) <= 8                                                                           # the cap held under six reports at once


def test_16_source_pin_a_computers_reports_are_taken_one_at_a_time_by_an_advisory_lock():
    import pathlib

    src = (pathlib.Path(__file__).resolve().parents[1] / "app" / "services" / "desktop_usage.py").read_text(encoding="utf-8")
    assert 'pg_advisory_xact_lock(func.hashtext(f"desktop_usage:{setup.id}"))' in src
    assert src.index("pg_advisory_xact_lock") < src.index("DesktopSetup.id == setup.id")                  # before the row is read and before anything is counted


async def test_17_a_usage_report_never_renews_the_streams_tick_the_5853_rule_still_refuses_a_dead_stream(world):
    """Kadir 5854 ①: the report stamps `last_heard_at` only. A presence host whose stream died 30 min ago and which keeps sending numbers must still be refused a command (409), as before the report."""
    from tests.test_4979_last_heard_realdb import _age, _cmd, _grant_command, _post, _setup

    async with _client() as c:
        device, agent, phone, conv = await _setup(c, "d4981 mac dead stream usage")
        await _grant_command()
        assert (await c.post("/api/v2/desktop/relay/presence", headers=_tok(device["device_token"]))).status_code == 200
        await _age(device["setup_id"], used=1800, heard=5, presence=5)                                  # the stream's tick 30 min old; the computer itself fresh
        assert (await _post(c, agent, _cmd("send_prompt", phone, conv=conv))).status_code == 409
        before = await _sql(fetch=f"SELECT last_used_at FROM desktop_device_tokens WHERE setup_id = '{device['setup_id']}' AND revoked_at IS NULL")
        assert (await _put(c, device, _entry())).status_code == 200
        after = await _sql(fetch=f"SELECT last_used_at, last_heard_at FROM desktop_device_tokens WHERE setup_id = '{device['setup_id']}' AND revoked_at IS NULL")
        assert after[0][0] == before[0][0]                                                               # the tick was NOT renewed
        r = await _post(c, agent, _cmd("send_prompt", phone, conv=conv))
        assert r.status_code == 409 and "device_unreachable" in r.text, r.text                           # …so a command is still refused


async def test_18_the_report_stamps_only_the_token_it_came_with(world):
    async with _client() as c:
        d = await _device(c, "d4981 mac token")
        await _sql(f"INSERT INTO desktop_device_tokens (id, setup_id, token_hash, issued_at) VALUES (gen_random_uuid(), '{d['setup_id']}', 'second-token-of-d', now())")
        await _sql(f"UPDATE desktop_device_tokens SET last_heard_at = NULL WHERE setup_id = '{d['setup_id']}'")
        assert (await _put(c, d, _entry())).status_code == 200
        rows = {h: heard for h, heard in await _sql(fetch=f"SELECT token_hash, last_heard_at IS NOT NULL FROM desktop_device_tokens WHERE setup_id = '{d['setup_id']}' AND revoked_at IS NULL")}
        assert rows.pop("second-token-of-d") is False and list(rows.values()) == [True]


def test_19_source_pin_the_setup_is_read_with_a_row_lock_and_the_report_does_not_touch_the_tick():
    import pathlib

    from sqlalchemy import select
    from sqlalchemy.dialects import postgresql

    from app.models.desktop_setup import DesktopSetup

    src = (pathlib.Path(__file__).resolve().parents[1] / "app" / "services" / "desktop_usage.py").read_text(encoding="utf-8")
    assert "with_for_update(key_share=True)" in src
    assert "touch_heard(db, setup.id, token)" in src and "touch_device(" not in src.replace("`touch_device", "")
    sql = str(select(DesktopSetup).with_for_update(key_share=True).compile(dialect=postgresql.dialect()))
    assert "FOR NO KEY UPDATE" in sql                                                                    # what that call really renders (the mode the disconnect's UPDATE takes)


async def test_20_a_disconnect_waits_for_a_usage_report_that_is_still_open_and_goes_through_when_it_ends(world):
    """Kadir 5854 low, two real connections: the report's transaction holds the computer's row, so a disconnect cannot slip in between its read and its writes."""
    from sqlalchemy import select, text, update
    from sqlalchemy.exc import DBAPIError

    from app.core.database import async_session_factory
    from app.models.desktop_setup import DesktopSetup
    from app.services import desktop_usage

    async with _client() as c:
        d = await _device(c, "d4981 mac lock")
        async with async_session_factory() as a, async_session_factory() as b:
            setup = (await a.execute(select(DesktopSetup).where(DesktopSetup.id == d["setup_id"]))).scalar_one()
            report = desktop_usage.UsageReport.model_validate({"usage": [_entry()]})
            await desktop_usage.apply_usage(a, setup, report)                                            # the report's transaction is OPEN (not committed)
            await b.execute(text("SET LOCAL lock_timeout = '400ms'"))
            with pytest.raises(DBAPIError):
                await b.execute(update(DesktopSetup).where(DesktopSetup.id == d["setup_id"]).values(revoked_at=datetime.now(timezone.utc)))   # the disconnect has to wait → times out here
            await b.rollback()
            await a.commit()                                                                              # the report ends …
            await b.execute(update(DesktopSetup).where(DesktopSetup.id == d["setup_id"]).values(revoked_at=datetime.now(timezone.utc)))        # … and the disconnect goes through
            await b.commit()
        assert len(await _rows(d["setup_id"])) == 1


async def test_21_a_request_that_read_the_computer_while_it_was_open_is_refused_when_the_disconnect_committed_before_its_report(world):
    """Kadir 5854 low (a): the request's own session read the computer (open), a disconnect then COMMITTED, and only after that the report is applied in that same open transaction —
    the service must judge the computer as it is NOW (the row re-read), never the `revoked_at` the request saw earlier. Nothing is written, and the computer is not counted as heard."""
    from sqlalchemy import select

    from app.core.database import async_session_factory
    from app.models.desktop_setup import DesktopSetup
    from app.services import desktop_usage
    from app.services.desktop_relay import DesktopRelayError

    async with _client() as c:
        d = await _device(c, "d4981 mac open then closed")
        await _sql(f"UPDATE desktop_device_tokens SET last_heard_at = NULL WHERE setup_id = '{d['setup_id']}'")
        async with async_session_factory() as s:
            setup = (await s.execute(select(DesktopSetup).where(DesktopSetup.id == d["setup_id"]))).scalar_one()
            assert setup.revoked_at is None                                                                # what the request saw while the computer was open
            await _sql(f"UPDATE desktop_setups SET revoked_at = now() WHERE id = '{d['setup_id']}'")        # the disconnect commits (another connection)
            report = desktop_usage.UsageReport.model_validate({"usage": [_entry()]})
            with pytest.raises(DesktopRelayError) as e:
                await desktop_usage.apply_usage(s, setup, report, d["device_token"])
            assert e.value.status == 409 and e.value.code == "device_disconnected"
            await s.rollback()
        assert await _rows(d["setup_id"]) == []
        assert (await _sql(fetch=f"SELECT last_heard_at IS NULL FROM desktop_device_tokens WHERE setup_id = '{d['setup_id']}' AND revoked_at IS NULL"))[0][0] is True   # …and it was not counted as heard


async def test_22_a_usage_report_never_stamps_last_presence_at(world):
    """Kadir 5854 low (b): a report is the computer speaking (`last_heard_at`) but it is NOT a presence — `last_presence_at` is what makes the 5853 rule apply to a host, so only the host's own presence call may set it."""
    async with _client() as c:
        d = await _device(c, "d4981 mac no presence")
        sid = d["setup_id"]
        await _sql(f"UPDATE desktop_device_tokens SET last_presence_at = NULL, last_heard_at = NULL WHERE setup_id = '{sid}' AND revoked_at IS NULL")
        assert (await _put(c, d, _entry())).status_code == 200
        heard, presence = (await _sql(fetch=f"SELECT last_heard_at IS NOT NULL, last_presence_at IS NULL FROM desktop_device_tokens WHERE setup_id = '{sid}' AND revoked_at IS NULL"))[0]
        assert heard is True and presence is True                                                            # heard — yes; presence — still none
        await _sql(f"UPDATE desktop_device_tokens SET last_presence_at = now() - interval '1 hour' WHERE setup_id = '{sid}' AND revoked_at IS NULL")
        before = (await _sql(fetch=f"SELECT last_presence_at FROM desktop_device_tokens WHERE setup_id = '{sid}' AND revoked_at IS NULL"))[0][0]
        assert (await _put(c, d, _entry(), _word(runtime="codex", account="cccccccccccc"))).status_code == 200
        assert (await _sql(fetch=f"SELECT last_presence_at FROM desktop_device_tokens WHERE setup_id = '{sid}' AND revoked_at IS NULL"))[0][0] == before   # an old presence is not renewed by a report

