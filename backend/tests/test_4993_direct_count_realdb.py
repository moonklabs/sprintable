"""story 4993 (P3b) — HOW MANY, nothing else: a computer's running totals of its same-network direct road (`PUT /api/v2/desktop/relay/direct-count`, `{epoch, commands, doors}`) — kept as the greater of what is
there and what came (a report again changes nothing), per run of the host, bounded, swept, and never anything but numbers. Each test goes red without the line it names."""
from __future__ import annotations

import logging
import uuid
from datetime import timedelta

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
from tests.test_4534_desktop_commands_realdb import _remote_control_on  # noqa: F401 — the autouse fixture that turns the organization's remote control on
from tests.test_4993_desktop_direct_realdb import MARK, _setup

pytestmark = pytest.mark.anyio


def _put(c, device, body=None, raw=None, headers=None):
    kw = {"content": raw} if raw is not None else {"json": body}
    h = {**_tok(device["device_token"]), **({"content-type": "application/json"} if raw is not None else {})}
    return c.put("/api/v2/desktop/relay/direct-count", headers=h if headers is None else headers, **kw)


async def _rows(sid):
    return [tuple(r) for r in await _sql(fetch=f"SELECT epoch, commands, doors FROM desktop_direct_counts WHERE setup_id = '{sid}' ORDER BY epoch")]


E1, E2 = "run-aaaaaaaa", "run-bbbbbbbb"


async def test_01_a_report_makes_a_row_and_the_same_report_again_changes_nothing(world):
    async with _client() as c:
        device, _a, _p, sid = await _setup(c, "d4993b mac a")
        r = await _put(c, device, {"epoch": E1, "commands": 3, "doors": 2})
        assert r.status_code == 200 and r.json() == {"ok": True}, r.text
        assert await _rows(sid) == [(E1, 3, 2)]
        assert (await _put(c, device, {"epoch": E1, "commands": 3, "doors": 2})).status_code == 200
        assert await _rows(sid) == [(E1, 3, 2)]


async def test_02_the_greater_total_is_kept_a_lower_one_never_lowers_it_and_each_number_is_judged_alone(world):
    async with _client() as c:
        device, _a, _p, sid = await _setup(c, "d4993b mac b")
        await _put(c, device, {"epoch": E1, "commands": 5, "doors": 2})
        await _put(c, device, {"epoch": E1, "commands": 4, "doors": 3})  # an older report that arrives late: commands lower, doors higher
        assert await _rows(sid) == [(E1, 5, 3)]
        await _put(c, device, {"epoch": E1, "commands": 9, "doors": 0})
        assert await _rows(sid) == [(E1, 9, 3)]


async def test_03_each_run_of_the_host_is_a_row_of_its_own(world):
    async with _client() as c:
        device, _a, _p, sid = await _setup(c, "d4993b mac c")
        await _put(c, device, {"epoch": E1, "commands": 1, "doors": 1})
        await _put(c, device, {"epoch": E2, "commands": 7, "doors": 4})
        assert await _rows(sid) == [(E1, 1, 1), (E2, 7, 4)]


async def test_04_a_report_is_numbers_and_a_run_name_and_nothing_else_and_never_echoed(world):
    async with _client() as c:
        device, _a, _p, sid = await _setup(c, "d4993b mac d")
        good = {"epoch": E1, "commands": 1, "doors": 1}
        for bad in ({**good, "phone": MARK}, {**good, "address": f"10.0.0.1:{MARK}"}, {"epoch": E1, "commands": 1}, {"commands": 1, "doors": 1}, {**good, "commands": -1}, {**good, "doors": -1},
                    {**good, "commands": 1_000_000_001}, {**good, "doors": 1_000_000_001}, {**good, "commands": "1"}, {**good, "doors": "1"}, {**good, "commands": 1.5}, {**good, "doors": 1.5}, {**good, "commands": True}, {**good, "doors": True}, {**good, "doors": None}, {**good, "epoch": "short"}, {**good, "epoch": "x" * 65},
                    {**good, "epoch": "has space   "}, {**good, "epoch": "../../etc/pass"}, {**good, "epoch": MARK + "!"}, [good], "x"):
            r = await _put(c, device, bad)
            assert r.status_code == 422 and MARK not in r.text, (bad, r.text)
        assert await _rows(sid) == []
        assert (await _put(c, device, {**good, "commands": 1_000_000_000, "doors": 0})).status_code == 200  # the greatest total a computer may say


async def test_05_a_report_is_judged_by_size_before_it_is_parsed_with_or_without_a_length(world):
    async with _client() as c:
        device, _a, _p, sid = await _setup(c, "d4993b mac e")
        r = await _put(c, device, raw=b'{"epoch": "' + b"x" * 600 + b'"}')
        assert r.status_code == 413 and r.json()["error"]["code"] == "direct_count_too_large"

        async def chunks():  # no content-length: the stream itself is bounded
            yield b'{"padding": "'
            for _ in range(3):
                yield b"x" * 256
            yield b'"}'

        h = {**_tok(device["device_token"]), "content-type": "application/json"}
        r = await c.put("/api/v2/desktop/relay/direct-count", content=chunks(), headers=h)
        assert r.status_code == 413 and r.json()["error"]["code"] == "direct_count_too_large"
        assert await _rows(sid) == []


async def test_06_only_a_computers_own_device_token_writes_and_only_into_its_own_rows(world):
    async with _client() as c:
        device, _a, _p, sid = await _setup(c, "d4993b mac f")
        other, _a2, _p2, sid2 = await _setup(c, "d4993b mac f2")
        assert (await _put(c, device, {"epoch": E1, "commands": 1, "doors": 1}, headers={})).status_code in (401, 403, 422)
        assert (await _put(c, device, {"epoch": E1, "commands": 1, "doors": 1}, headers={"x-desktop-device-token": "nonsense"})).status_code == 401
        agent_key = {"Authorization": f"Bearer {device['agents'][0]['api_key']}"}
        assert (await _put(c, device, {"epoch": E1, "commands": 1, "doors": 1}, headers=agent_key)).status_code in (401, 403)
        assert await _rows(sid) == [] and await _rows(sid2) == []
        await _put(c, device, {"epoch": E1, "commands": 2, "doors": 2})
        await _put(c, other, {"epoch": E1, "commands": 9, "doors": 9})
        assert await _rows(sid) == [(E1, 2, 2)] and await _rows(sid2) == [(E1, 9, 9)], "the same run name on two computers is two rows"


async def test_07_remote_control_off_refuses_the_report_like_every_device_call(world):
    async with _client() as c:
        device, _a, _p, sid = await _setup(c, "d4993b mac g")
        await _sql(f"UPDATE organizations SET remote_control_enabled_at = NULL WHERE id = (SELECT org_id FROM desktop_setups WHERE id = '{sid}')")
        r = await _put(c, device, {"epoch": E1, "commands": 1, "doors": 1})
        assert (r.status_code, r.json()["error"]["code"] if "error" in r.json() else r.json()["detail"]["code"]) == (409, "remote_control_off"), r.text
        assert await _rows(sid) == []


async def test_08_a_computer_keeps_the_newest_twenty_runs_only(world):
    async with _client() as c:
        device, _a, _p, sid = await _setup(c, "d4993b mac h")
        for i in range(22):
            assert (await _put(c, device, {"epoch": f"run-{i:08d}", "commands": i, "doors": i})).status_code == 200
            await _sql(f"UPDATE desktop_direct_counts SET updated_at = now() - interval '{30 - i} seconds' WHERE setup_id = '{sid}' AND epoch = 'run-{i:08d}'")
        rows = await _rows(sid)
        assert len(rows) == 20 and rows[0][0] == "run-00000002" and rows[-1][0] == "run-00000021", rows


async def test_09_a_run_not_reported_for_thirty_days_goes_in_the_minute_job_and_a_fresh_one_stays(world, monkeypatch):
    from httpx import ASGITransport, AsyncClient

    from app.main import app
    from app.routers import cron as cron_module

    monkeypatch.setattr(cron_module, "CRON_SECRET", "test-cron-secret")
    async with _client() as c:
        device, _a, _p, sid = await _setup(c, "d4993b mac i")
        await _put(c, device, {"epoch": E1, "commands": 1, "doors": 1})
        await _put(c, device, {"epoch": E2, "commands": 2, "doors": 2})
        await _sql(f"UPDATE desktop_direct_counts SET updated_at = now() - interval '31 days' WHERE setup_id = '{sid}' AND epoch = '{E1}'")
        await _sql(f"UPDATE desktop_direct_counts SET updated_at = now() - interval '29 days' WHERE setup_id = '{sid}' AND epoch = '{E2}'")
    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as client:
        r = await client.post("/api/v2/internal/cron/changes-purge", headers={"Authorization": "Bearer test-cron-secret"})
    assert r.status_code == 200 and r.json()["data"]["direct_counts_purged"] == 1, r.text
    assert await _rows(sid) == [(E2, 2, 2)]


async def test_10_the_sweep_takes_exactly_the_runs_past_thirty_days(world):
    from app.core.database import async_session_factory
    from app.services.desktop_direct import purge_counts

    async with _client() as c:
        device, _a, _p, sid = await _setup(c, "d4993b mac j")
        await _put(c, device, {"epoch": E1, "commands": 1, "doors": 1})
        async with async_session_factory() as s:
            assert await purge_counts(s) == 0
            await s.commit()
        await _sql(f"UPDATE desktop_direct_counts SET updated_at = now() - interval '31 days' WHERE setup_id = '{sid}'")
        async with async_session_factory() as s:
            assert await purge_counts(s) == 1
            await s.commit()
        assert await _rows(sid) == []


async def test_11_the_rows_go_with_the_computers_row_and_the_table_holds_numbers_only(world):
    cols = {r[0] for r in await _sql(fetch="SELECT column_name FROM information_schema.columns WHERE table_name = 'desktop_direct_counts'")}
    assert cols == {"setup_id", "epoch", "commands", "doors", "updated_at"}, cols
    async with _client() as c:
        device, _a, _p, sid = await _setup(c, "d4993b mac k")
        await _put(c, device, {"epoch": E1, "commands": 1, "doors": 1})
        assert len(await _rows(sid)) == 1
        await _sql(f"DELETE FROM desktop_setups WHERE id = '{sid}'")
        assert await _rows(sid) == []


async def test_12_the_numbers_cannot_be_negative_in_the_table_itself(world):
    async with _client() as c:
        _d, _a, _p, sid = await _setup(c, "d4993b mac l")
        with pytest.raises(Exception):
            await _sql(f"INSERT INTO desktop_direct_counts (setup_id, epoch, commands, doors) VALUES ('{sid}', 'run-negative', -1, 0)")


async def test_13_nothing_of_a_report_reaches_a_log_line(world, caplog):
    caplog.set_level(logging.DEBUG)
    async with _client() as c:
        device, _a, _p, sid = await _setup(c, "d4993b mac m")
        await _put(c, device, {"epoch": E1, "commands": 1, "doors": 1, "address": MARK})
        await _put(c, device, {"epoch": E1, "commands": 1, "doors": 1})
        assert MARK not in caplog.text and E1 not in caplog.text


async def test_14_one_computers_report_never_prunes_another_computers_runs(world):
    async with _client() as c:
        a, _a, _p, sid_a = await _setup(c, "d4993b mac n")
        b, _a2, _p2, sid_b = await _setup(c, "d4993b mac n2")
        for i in range(20):
            await _put(c, a, {"epoch": f"run-{i:08d}", "commands": i, "doors": i})
        assert len(await _rows(sid_a)) == 20
        await _put(c, b, {"epoch": "run-zzzzzzzz", "commands": 1, "doors": 1})
        assert len(await _rows(sid_a)) == 20 and await _rows(sid_b) == [("run-zzzzzzzz", 1, 1)]


async def test_15_a_report_that_comes_again_refreshes_the_runs_time_so_a_living_host_is_never_swept(world):
    async with _client() as c:
        device, _a, _p, sid = await _setup(c, "d4993b mac o")
        await _put(c, device, {"epoch": E1, "commands": 1, "doors": 1})
        await _sql(f"UPDATE desktop_direct_counts SET updated_at = now() - interval '29 days' WHERE setup_id = '{sid}'")
        await _put(c, device, {"epoch": E1, "commands": 2, "doors": 1})
        age = (await _sql(fetch=f"SELECT now() - updated_at FROM desktop_direct_counts WHERE setup_id = '{sid}'"))[0][0]
        assert age < timedelta(minutes=1), age


async def test_16_a_report_with_no_length_is_cut_at_the_limit_while_it_is_read_parsing_is_never_reached(world, monkeypatch):
    from app.services import desktop_direct as dd

    def never(*_a, **_k):
        raise AssertionError("a body past the limit reached the parser")

    monkeypatch.setattr(dd, "parse_count", never)

    async def chunks():
        yield b'{"padding": "'
        for _ in range(3):
            yield b"x" * 256
        yield b'"}'

    async with _client() as c:
        device, _a, _p, _sid = await _setup(c, "d4993b mac p")
        r = await c.put("/api/v2/desktop/relay/direct-count", content=chunks(), headers={**_tok(device["device_token"]), "content-type": "application/json"})
        assert r.status_code == 413 and r.json()["error"]["code"] == "direct_count_too_large", r.text


async def test_17_reports_of_new_runs_that_arrive_together_never_leave_the_computer_past_twenty_runs(world):
    import asyncio

    async with _client() as c:
        device, _a, _p, sid = await _setup(c, "d4993b mac q")
        for i in range(19):
            await _put(c, device, {"epoch": f"run-{i:08d}", "commands": i, "doors": i})
        rs = await asyncio.gather(*(_put(c, device, {"epoch": f"new-{i:08d}", "commands": 1, "doors": 1}) for i in range(6)))
        assert [r.status_code for r in rs] == [200] * 6, [r.text for r in rs]
        assert len(await _rows(sid)) == 20, len(await _rows(sid))
