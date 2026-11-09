"""story 4826 (공개 2-③ (나)) — the app's own server runs the scheduled jobs itself.

No database here (the realdb file next to it covers the last-run table, the refresh query and a call through the real app):
- the list of 15 jobs agrees with `infra/cloud-scheduler/jobs.json` (route · method · interval · deadline) and, together with the 12 left to the hosted deployment, is the
  whole manifest — a job added to the manifest fails here until someone decides «timer or hosted-only»
- the loop: catch-up (only a job whose interval passed, once however many were missed) · staggered start · one lap at a time per job · a failed lap never ends the loop
- a lap: a prerequisite that is not met = no call and no «last run»; a failure, an error answer and a deadline are logged, never raised; a cancel passes through
- the bearer: the call carries `Authorization: Bearer <CRON_SECRET>` and is refused without it
- only the app's own server starts the timers
"""
from __future__ import annotations

import asyncio
import json
import logging
import re
from contextlib import asynccontextmanager
from pathlib import Path
from unittest.mock import AsyncMock, PropertyMock, patch

import pytest
from fastapi import FastAPI, Request  # module level: with postponed annotations FastAPI resolves `Request` from the module's globals

from app.services import embedded_timers as et
from app.services.embedded_timers import EXCLUDED, LOCAL_JOBS, TimerJob

MANIFEST = json.loads((Path(__file__).resolve().parents[2] / "infra" / "cloud-scheduler" / "jobs.json").read_text(encoding="utf-8"))
BY_NAME = {j["name"]: j for j in MANIFEST["jobs"]}


@pytest.fixture
def anyio_backend():
    return "asyncio"


def _interval(schedule: str) -> int:
    """the period of the (simple) cron expressions the manifest uses"""
    minute, hour, dom, mon, dow = schedule.split()
    assert (dom, mon, dow) == ("*", "*", "*"), schedule
    if (minute, hour) == ("*", "*"):
        return 60
    if hour == "*":
        m = re.fullmatch(r"\*/(\d+)", minute)
        return int(m.group(1)) * 60 if m else 3600
    m = re.fullmatch(r"\*/(\d+)", hour)
    if m:
        return int(m.group(1)) * 3600
    return 86400


def _deadline(job: dict) -> float:
    return float((job.get("attempt_deadline") or MANIFEST["defaults"]["attempt_deadline"]).rstrip("s"))


# ─── the list ────────────────────────────────────────────────────────────────

def test_fifteen_local_jobs_and_twelve_left_to_the_hosted_deployment() -> None:
    assert len(LOCAL_JOBS) == 15
    assert len(EXCLUDED) == 12
    assert all(reason.strip() for reason in EXCLUDED.values())


def test_every_local_job_agrees_with_the_manifest() -> None:
    for job in LOCAL_JOBS:
        m = BY_NAME[job.route]
        assert m["route"] == job.route
        assert m["method"] == job.method, job.route
        assert _interval(m["schedule"]) == job.every_seconds, job.route
        assert _deadline(m) == job.deadline_seconds, job.route


def test_local_and_hosted_only_together_are_the_whole_manifest() -> None:
    local = {j.route for j in LOCAL_JOBS}
    assert len(local) == len(LOCAL_JOBS)  # no job twice
    assert not (local & set(EXCLUDED)), "a job is both in the timer and hosted-only"
    assert local | set(EXCLUDED) == set(BY_NAME), "a manifest job is neither in the timer nor named hosted-only (or the reverse)"


def test_only_two_jobs_have_a_prerequisite_and_publication_commands_is_not_one_of_them() -> None:
    with_check = {j.route for j in LOCAL_JOBS if j.precondition is not None}
    assert with_check == {"embed-backlog", "refresh-channel-tokens"}
    # its tick also carries the shared work queue and the 30-day sweeps — it must never wait for a channel
    pub = next(j for j in LOCAL_JOBS if j.route == "publication-commands")
    assert pub.precondition is None and pub.every_seconds == 60


# ─── the speed-up knob ───────────────────────────────────────────────────────

@pytest.mark.parametrize("raw,expected", [
    (None, 1.0), ("", 1.0), ("  ", 1.0), ("1", 1.0), ("60", 60.0), ("2.5", 2.5),
    ("0", 1.0), ("-5", 1.0), ("0.5", 1.0), ("abc", 1.0), ("nan", 1.0), ("inf", 1.0), ("1e12", et.MAX_SPEEDUP),
])
def test_speedup_is_defensive(monkeypatch, raw, expected) -> None:
    if raw is None:
        monkeypatch.delenv("EMBEDDED_TIMER_SPEEDUP", raising=False)
    else:
        monkeypatch.setenv("EMBEDDED_TIMER_SPEEDUP", raw)
    assert et.speedup() == expected


# ─── the loop ────────────────────────────────────────────────────────────────

class _Stop(Exception):
    pass


async def _run_loop(job: TimerJob, index: int, *, since, laps: int, lap_effect=None, monkeypatch) -> tuple[list[float], list[str]]:
    """run `_job_loop` with a fake clock: record every sleep, stop after `laps` laps. Returns (sleeps, laps)."""
    sleeps: list[float] = []
    ran: list[str] = []

    async def fake_sleep(s: float) -> None:
        sleeps.append(s)
        if len(ran) >= laps:
            raise asyncio.CancelledError

    async def fake_since(name: str):
        if isinstance(since, Exception):
            raise since
        return since

    async def fake_lap(app, j, *, call=None):
        ran.append(j.route)
        if lap_effect is not None:
            await lap_effect()
        return "ran"

    monkeypatch.delenv("EMBEDDED_TIMER_SPEEDUP", raising=False)
    monkeypatch.setattr(et, "_seconds_since_last_run", fake_since)
    monkeypatch.setattr(et, "_lap", fake_lap)
    with pytest.raises(asyncio.CancelledError):
        await et._job_loop(object(), job, index, sleep=fake_sleep)
    return sleeps, ran


JOB = TimerJob("hitl-timeouts", "GET", 600)


@pytest.mark.anyio
async def test_a_job_that_never_ran_runs_once_after_its_staggered_start(monkeypatch) -> None:
    sleeps, ran = await _run_loop(JOB, 4, since=None, laps=2, monkeypatch=monkeypatch)
    assert sleeps[0] == et.START_DELAY_SEC + 4 * et.STAGGER_SEC  # staggered by the job's place
    assert sleeps[1] == 0.0  # due now → a lap now
    assert ran == ["hitl-timeouts", "hitl-timeouts"] and sleeps[2:] == [600, 600]  # then one lap per interval (a sleep after each lap)


@pytest.mark.anyio
async def test_a_job_that_ran_recently_waits_out_the_rest_of_its_interval(monkeypatch) -> None:
    sleeps, ran = await _run_loop(JOB, 0, since=100.0, laps=1, monkeypatch=monkeypatch)
    assert sleeps[1] == pytest.approx(500.0)  # 600 − 100: not due yet, no lap before that
    assert ran == ["hitl-timeouts"]


@pytest.mark.anyio
async def test_many_missed_intervals_are_one_lap_not_many(monkeypatch) -> None:
    sleeps, ran = await _run_loop(JOB, 0, since=600.0 * 50, laps=1, monkeypatch=monkeypatch)
    assert sleeps[1] == 0.0  # due → one lap now
    assert ran == ["hitl-timeouts"]  # one, not fifty
    assert sleeps[2:] == [600]  # and the next after a normal interval, not a burst


@pytest.mark.anyio
async def test_not_knowing_the_last_run_counts_as_never_ran(monkeypatch) -> None:
    sleeps, ran = await _run_loop(JOB, 0, since=RuntimeError("db down"), laps=1, monkeypatch=monkeypatch)
    assert sleeps[1] == 0.0 and ran == ["hitl-timeouts"]


@pytest.mark.anyio
async def test_a_lap_that_raises_does_not_end_the_loop(monkeypatch) -> None:
    calls = {"n": 0}

    async def boom():
        calls["n"] += 1
        if calls["n"] == 1:
            raise RuntimeError("lap exploded")

    sleeps, ran = await _run_loop(JOB, 0, since=None, laps=3, lap_effect=boom, monkeypatch=monkeypatch)
    assert len(ran) == 3  # the loop went on to the 2nd and 3rd lap


@pytest.mark.anyio
async def test_a_lap_that_stalls_anywhere_is_logged_and_the_loop_goes_on(monkeypatch, caplog) -> None:
    """the deadline is for the WHOLE lap (prerequisite check · call · record), not only the HTTP call: a stall in any of them is cut off and the next lap comes"""
    monkeypatch.setattr(et, "LAP_GRACE_SEC", 0.05)
    laps = {"n": 0}
    sleeps: list[float] = []

    async def fake_sleep(s: float) -> None:
        sleeps.append(s)
        if laps["n"] >= 2:
            raise asyncio.CancelledError

    async def fake_since(name):
        return None

    async def stalled_lap(app, j, *, call=None):
        laps["n"] += 1
        await asyncio.Event().wait()  # never finishes

    monkeypatch.delenv("EMBEDDED_TIMER_SPEEDUP", raising=False)
    monkeypatch.setattr(et, "_seconds_since_last_run", fake_since)
    monkeypatch.setattr(et, "_lap", stalled_lap)
    job = TimerJob("hitl-timeouts", "GET", 600, deadline_seconds=0.05)
    with caplog.at_level(logging.WARNING, logger=et.logger.name), pytest.raises(asyncio.CancelledError):
        await asyncio.wait_for(et._job_loop(object(), job, 0, sleep=fake_sleep), 5)
    assert laps["n"] == 2  # the first stalled lap did not hold the loop: the second came
    assert any("did not finish within" in r.getMessage() for r in caplog.records)


@pytest.mark.anyio
async def test_a_stalled_read_of_the_last_run_counts_as_never_ran(monkeypatch) -> None:
    monkeypatch.setattr(et, "LAP_GRACE_SEC", 0.05)
    sleeps: list[float] = []
    ran: list[str] = []

    async def fake_sleep(s: float) -> None:
        sleeps.append(s)
        if ran:
            raise asyncio.CancelledError

    async def stalled_since(name):
        await asyncio.Event().wait()

    async def fake_lap(app, j, *, call=None):
        ran.append(j.route)

    monkeypatch.delenv("EMBEDDED_TIMER_SPEEDUP", raising=False)
    monkeypatch.setattr(et, "_seconds_since_last_run", stalled_since)
    monkeypatch.setattr(et, "_lap", fake_lap)
    with pytest.raises(asyncio.CancelledError):
        await asyncio.wait_for(et._job_loop(object(), JOB, 0, sleep=fake_sleep), 5)
    assert sleeps[1] == 0.0 and ran == ["hitl-timeouts"]  # not knowing = due now


@pytest.mark.anyio
async def test_a_job_never_overlaps_itself(monkeypatch) -> None:
    live = {"now": 0, "max": 0}

    async def slow():
        live["now"] += 1
        live["max"] = max(live["max"], live["now"])
        await asyncio.sleep(0)
        live["now"] -= 1

    await _run_loop(JOB, 0, since=None, laps=3, lap_effect=slow, monkeypatch=monkeypatch)
    assert live["max"] == 1


@pytest.mark.anyio
async def test_the_speedup_divides_the_start_and_the_interval(monkeypatch) -> None:
    sleeps: list[float] = []
    ran: list[str] = []

    async def fake_sleep(s: float) -> None:
        sleeps.append(s)
        if ran:
            raise asyncio.CancelledError

    async def fake_since(name):
        return None

    async def fake_lap(app, j, *, call=None):
        ran.append(j.route)

    monkeypatch.setenv("EMBEDDED_TIMER_SPEEDUP", "60")
    monkeypatch.setattr(et, "_seconds_since_last_run", fake_since)
    monkeypatch.setattr(et, "_lap", fake_lap)
    with pytest.raises(asyncio.CancelledError):
        await et._job_loop(object(), JOB, 2, sleep=fake_sleep)
    assert sleeps[0] == pytest.approx((et.START_DELAY_SEC + 2 * et.STAGGER_SEC) / 60)
    assert sleeps[2] == pytest.approx(600 / 60)


@pytest.mark.anyio
async def test_cancelling_stops_every_loop(monkeypatch) -> None:
    started: list[str] = []
    cancelled: list[str] = []

    async def forever(app, job, index, **kw):
        started.append(job.route)
        try:
            await asyncio.sleep(3600)
        except asyncio.CancelledError:
            cancelled.append(job.route)
            raise

    monkeypatch.setattr(et, "_job_loop", forever)
    task = asyncio.create_task(et.run_embedded_timers(object()))
    await asyncio.sleep(0.05)
    assert len(started) == 15  # one loop per job
    task.cancel()
    with pytest.raises(asyncio.CancelledError):
        await task
    assert sorted(cancelled) == sorted(j.route for j in LOCAL_JOBS)


# ─── a lap ───────────────────────────────────────────────────────────────────

class _FakeSession:
    pass


@pytest.fixture
def lap_env(monkeypatch):
    """the database is not needed for a lap: a fake session factory, a recorded last-run write, a recorded call"""
    @asynccontextmanager
    async def fake_factory():
        yield _FakeSession()

    writes: list[tuple] = []

    async def fake_write(name, status, ms):
        writes.append((name, status, ms))

    monkeypatch.setattr("app.core.database.async_session_factory", fake_factory)
    monkeypatch.setattr(et, "_write_last_run", fake_write)
    return writes


@pytest.mark.anyio
async def test_a_lap_without_its_prerequisite_makes_no_call_and_writes_no_last_run(lap_env, caplog) -> None:
    calls: list[str] = []

    async def call(app, job):
        calls.append(job.route)
        return 200

    async def not_ready(db):
        return "nothing to do — test"

    job = TimerJob("embed-backlog", "POST", 3600, precondition=not_ready)
    with caplog.at_level(logging.DEBUG, logger=et.logger.name):
        assert await et._lap(object(), job, call=call) == "skipped"
    assert calls == [] and lap_env == []  # no call · the interval is not restarted by a skip
    assert any("skip embed-backlog" in r.getMessage() and "nothing to do" in r.getMessage() for r in caplog.records)


@pytest.mark.anyio
async def test_a_lap_with_its_prerequisite_met_calls_and_records(lap_env, caplog) -> None:
    calls: list[str] = []

    async def call(app, job):
        calls.append(job.route)
        return 200

    async def ready(db):
        return None

    job = TimerJob("embed-backlog", "POST", 3600, precondition=ready)
    with caplog.at_level(logging.INFO, logger=et.logger.name):
        assert await et._lap(object(), job, call=call) == "ran"
    assert calls == ["embed-backlog"]
    assert [(n, s) for n, s, _ in lap_env] == [("embed-backlog", 200)]
    assert any("ran embed-backlog -> 200" in r.getMessage() for r in caplog.records)


@pytest.mark.anyio
async def test_a_job_without_a_prerequisite_always_calls(lap_env) -> None:
    calls: list[str] = []

    async def call(app, job):
        calls.append(job.route)
        return 200

    assert await et._lap(object(), JOB, call=call) == "ran"
    assert calls == ["hitl-timeouts"]


@pytest.mark.anyio
async def test_an_error_answer_is_logged_and_recorded_not_raised(lap_env, caplog) -> None:
    async def call(app, job):
        return 500

    with caplog.at_level(logging.WARNING, logger=et.logger.name):
        assert await et._lap(object(), JOB, call=call) == "ran"
    assert [(n, s) for n, s, _ in lap_env] == [("hitl-timeouts", 500)]
    assert any("hitl-timeouts answered 500" in r.getMessage() for r in caplog.records)


@pytest.mark.anyio
async def test_a_call_that_raises_is_logged_not_raised(lap_env, caplog) -> None:
    async def call(app, job):
        raise RuntimeError("connection refused")

    with caplog.at_level(logging.WARNING, logger=et.logger.name):
        assert await et._lap(object(), JOB, call=call) == "ran"
    assert [(n, s) for n, s, _ in lap_env] == [("hitl-timeouts", None)]
    assert any("could not be called" in r.getMessage() for r in caplog.records)


@pytest.mark.anyio
async def test_a_deadline_is_logged_not_raised(lap_env, caplog) -> None:
    async def call(app, job):
        raise asyncio.TimeoutError

    with caplog.at_level(logging.WARNING, logger=et.logger.name):
        assert await et._lap(object(), JOB, call=call) == "ran"
    assert any("passed its" in r.getMessage() and "deadline" in r.getMessage() for r in caplog.records)


@pytest.mark.anyio
async def test_a_failing_last_run_write_does_not_raise(lap_env, monkeypatch, caplog) -> None:
    async def bad_write(name, status, ms):
        raise RuntimeError("db down")

    monkeypatch.setattr(et, "_write_last_run", bad_write)

    async def call(app, job):
        return 200

    with caplog.at_level(logging.WARNING, logger=et.logger.name):
        assert await et._lap(object(), JOB, call=call) == "ran"
    assert any("could not be written" in r.getMessage() for r in caplog.records)


@pytest.mark.anyio
async def test_a_cancel_during_the_call_passes_through(lap_env) -> None:
    async def call(app, job):
        raise asyncio.CancelledError

    with pytest.raises(asyncio.CancelledError):
        await et._lap(object(), JOB, call=call)
    assert lap_env == []


# ─── the two prerequisites ───────────────────────────────────────────────────

@pytest.mark.anyio
async def test_embed_backlog_waits_for_the_credentials_embed_text_itself_asks(monkeypatch) -> None:
    from app.services import embedding_client

    monkeypatch.setattr(embedding_client, "has_credentials", lambda: False)
    assert "credentials" in (await et._embedding_ready(None))
    monkeypatch.setattr(embedding_client, "has_credentials", lambda: True)
    assert await et._embedding_ready(None) is None


def test_embed_text_asks_the_same_credential_check(monkeypatch) -> None:
    """`embed_text` and the timer must not drift apart: with the check false `embed_text` answers None WITHOUT trying Vertex"""
    from app.services import embedding_client

    monkeypatch.setattr(embedding_client, "has_credentials", lambda: False)
    assert embedding_client.embed_text("hello") is None


def test_the_credential_check_is_the_env_file_or_adc(monkeypatch) -> None:
    from app.services import embedding_client

    monkeypatch.delenv("GOOGLE_APPLICATION_CREDENTIALS", raising=False)
    monkeypatch.setattr(embedding_client, "_has_adc", lambda: False)
    assert embedding_client.has_credentials() is False
    monkeypatch.setenv("GOOGLE_APPLICATION_CREDENTIALS", "/nonexistent/creds.json")
    assert embedding_client.has_credentials() is True
    monkeypatch.delenv("GOOGLE_APPLICATION_CREDENTIALS")
    monkeypatch.setattr(embedding_client, "_has_adc", lambda: True)
    assert embedding_client.has_credentials() is True


@pytest.mark.anyio
async def test_refresh_waits_for_a_connection_that_is_due(monkeypatch) -> None:
    import app.services.channel_connection as cc

    monkeypatch.setattr(cc, "list_connections_due_for_refresh", AsyncMock(return_value=[]))
    assert "no channel connection" in (await et._refresh_due(object()))
    monkeypatch.setattr(cc, "list_connections_due_for_refresh", AsyncMock(return_value=[object()]))
    assert await et._refresh_due(object()) is None


# ─── the call ────────────────────────────────────────────────────────────────

def _cron_app():
    """a tiny app with the cron routes' own guard — `verify_cron` — so the bearer is checked by the real function"""
    from app.routers.cron import verify_cron

    app = FastAPI()

    @app.get("/api/v2/internal/cron/hitl-timeouts")
    async def hitl(request: Request):
        verify_cron(request)
        return {"ok": True}

    @app.post("/api/v2/internal/cron/embed-backlog")
    async def embed(request: Request):
        verify_cron(request)
        return {"ok": True, "host": request.headers.get("host")}

    return app


@pytest.mark.anyio
async def test_the_call_carries_the_cron_bearer_and_the_method_of_the_job(monkeypatch) -> None:
    monkeypatch.setattr("app.routers.cron.CRON_SECRET", "s3cret-for-4826-test")
    app = _cron_app()
    assert await et._call_cron(app, TimerJob("hitl-timeouts", "GET", 600)) == 200
    assert await et._call_cron(app, TimerJob("embed-backlog", "POST", 3600)) == 200
    # the right method matters: a GET to a POST-only route is refused by the router
    assert await et._call_cron(app, TimerJob("embed-backlog", "GET", 3600)) == 405


@pytest.mark.anyio
async def test_the_guard_refuses_a_call_without_the_bearer_so_the_header_is_what_lets_it_in(monkeypatch) -> None:
    import httpx

    monkeypatch.setattr("app.routers.cron.CRON_SECRET", "the-real-one")
    app = _cron_app()
    transport = httpx.ASGITransport(app=app, raise_app_exceptions=False)
    async with httpx.AsyncClient(transport=transport, base_url="http://127.0.0.1") as c:
        assert (await c.get(et.CRON_PREFIX + "hitl-timeouts")).status_code == 401
        assert (await c.get(et.CRON_PREFIX + "hitl-timeouts", headers={"Authorization": "Bearer nope"})).status_code == 401
    assert await et._call_cron(app, TimerJob("hitl-timeouts", "GET", 600)) == 200  # the timer's own call carries the right one


@pytest.mark.anyio
async def test_the_call_uses_the_loopback_host_the_embedded_host_guard_allows() -> None:
    import httpx
    from starlette.middleware.trustedhost import TrustedHostMiddleware

    app = _cron_app()
    app.add_middleware(TrustedHostMiddleware, allowed_hosts=["127.0.0.1"])  # the embedded server's own guard
    with patch("app.routers.cron.CRON_SECRET", "s"):
        assert await et._call_cron(app, TimerJob("hitl-timeouts", "GET", 600)) == 200
    transport = httpx.ASGITransport(app=app, raise_app_exceptions=False)
    async with httpx.AsyncClient(transport=transport, base_url="http://localhost") as c:
        assert (await c.get("/api/v2/internal/cron/hitl-timeouts")).status_code == 400  # the guard is real: `localhost` would be refused


@pytest.mark.anyio
async def test_the_call_ends_at_its_deadline() -> None:
    app = FastAPI()

    @app.get("/api/v2/internal/cron/hitl-timeouts")
    async def slow():
        await asyncio.sleep(5)

    with patch("app.routers.cron.CRON_SECRET", ""):
        with pytest.raises(asyncio.TimeoutError):
            await et._call_cron(app, TimerJob("hitl-timeouts", "GET", 600, deadline_seconds=0.2))


# ─── who starts it ───────────────────────────────────────────────────────────

def _embedded(value: bool):
    from app.core.config import Settings

    return patch.object(Settings, "is_embedded", new_callable=PropertyMock, return_value=value)


def _enabled(value: bool):
    from app.core.config import settings

    return patch.object(settings, "embedded_timers_enabled", value)


def test_the_test_configuration_turns_the_setting_off() -> None:
    """tests/conftest.py sets EMBEDDED_TIMERS_ENABLED=false before the settings are read — no test runs 15 loops behind it unless it turns the setting on itself"""
    from app.core.config import settings

    assert settings.embedded_timers_enabled is False


@pytest.mark.anyio
async def test_not_started_on_a_hosted_server_even_when_the_setting_is_on() -> None:
    with _embedded(False), _enabled(True):
        assert et.start_embedded_timers(object()) is None


@pytest.mark.anyio
async def test_not_started_on_the_apps_own_server_when_the_setting_is_off() -> None:
    with _embedded(True), _enabled(False):
        assert et.start_embedded_timers(object()) is None


@pytest.mark.anyio
async def test_started_on_the_apps_own_server_with_the_setting_on(monkeypatch) -> None:
    started = asyncio.Event()

    async def fake_run(app):
        started.set()
        await asyncio.sleep(3600)

    monkeypatch.setattr(et, "run_embedded_timers", fake_run)
    with _embedded(True), _enabled(True):
        task = et.start_embedded_timers(object())
    assert task is not None
    await asyncio.wait_for(started.wait(), 1)
    task.cancel()
    with pytest.raises(asyncio.CancelledError):
        await task


@pytest.mark.anyio
async def test_one_loop_dying_is_logged_and_restarted_and_the_others_keep_running(monkeypatch, caplog) -> None:
    """a job's loop itself ending with an error (a bug — a failed lap never gets this far) must not end the other 14: it is logged and only that loop is started again"""
    monkeypatch.setenv("EMBEDDED_TIMER_SPEEDUP", "100000")  # the pause before the restart, shortened
    starts: dict[str, int] = {}
    cancelled: list[str] = []

    async def loop(app, job, index, **kw):
        starts[job.route] = starts.get(job.route, 0) + 1
        if index == 0 and starts[job.route] == 1:
            raise RuntimeError("one loop died")
        try:
            await asyncio.sleep(3600)
        except asyncio.CancelledError:
            cancelled.append(job.route)
            raise

    monkeypatch.setattr(et, "_job_loop", loop)
    dead = LOCAL_JOBS[0].route
    with caplog.at_level(logging.ERROR, logger=et.logger.name):
        task = asyncio.create_task(et.run_embedded_timers(object()))
        for _ in range(100):
            await asyncio.sleep(0.02)
            if starts.get(dead, 0) >= 2:
                break
        assert starts[dead] == 2  # the dead loop was started again — once
        assert cancelled == []  # nobody else was touched
        assert all(starts[j.route] == 1 for j in LOCAL_JOBS[1:])  # the other 14 never restarted
        assert not task.done()
        task.cancel()
        with pytest.raises(asyncio.CancelledError):
            await task
    assert sorted(cancelled) == sorted(j.route for j in LOCAL_JOBS)  # and cancelling still stops all 15
    assert any(f"the loop of {dead} ended with an error" in r.getMessage() for r in caplog.records)


@pytest.mark.anyio
async def test_the_restart_waits_a_pause_first(monkeypatch) -> None:
    sleeps: list[float] = []

    async def fake_sleep(s: float) -> None:
        sleeps.append(s)
        raise asyncio.CancelledError

    async def dying(app, job, index, **kw):
        raise RuntimeError("boom")

    monkeypatch.delenv("EMBEDDED_TIMER_SPEEDUP", raising=False)
    monkeypatch.setattr(et, "_job_loop", dying)
    with pytest.raises(asyncio.CancelledError):
        await et._supervised(object(), TimerJob("hitl-timeouts", "GET", 600), 0, sleep=fake_sleep)
    assert sleeps == [et.RESTART_PAUSE_SEC]  # 60 s (its own interval 600 is longer)
    sleeps.clear()
    with pytest.raises(asyncio.CancelledError):
        await et._supervised(object(), TimerJob("workflow-handoff-watchdog", "GET", 30), 0, sleep=fake_sleep)
    assert sleeps == [30]  # a shorter interval of its own wins


def _fake_engine(monkeypatch):
    from unittest.mock import MagicMock

    fake = MagicMock()
    fake.dispose = AsyncMock()
    monkeypatch.setattr("app.core.database.engine", fake)


def _quiet_pubsub(monkeypatch):
    async def fake_listen():
        await asyncio.Event().wait()

    monkeypatch.setattr("app.services.pg_pubsub.listen_loop", fake_listen)


@pytest.mark.anyio
async def test_lifespan_with_the_app_on_starts_every_loop_and_off_cancels_them_all(monkeypatch) -> None:
    """the real lifespan: on the app's own server with the setting on, starting the app puts the 15 loops up; stopping it cancels every one"""
    from unittest.mock import MagicMock

    from app.main import lifespan

    _fake_engine(monkeypatch)
    _quiet_pubsub(monkeypatch)
    started: list[str] = []
    cancelled: list[str] = []

    async def loop(app, job, index, **kw):
        started.append(job.route)
        try:
            await asyncio.sleep(3600)
        except asyncio.CancelledError:
            cancelled.append(job.route)
            raise

    monkeypatch.setattr(et, "_job_loop", loop)
    with _embedded(True), _enabled(True):
        async with lifespan(MagicMock()):
            await asyncio.sleep(0.05)
            assert sorted(started) == sorted(j.route for j in LOCAL_JOBS) and len(started) == 15
            assert cancelled == []
    assert sorted(cancelled) == sorted(j.route for j in LOCAL_JOBS)  # the app stopped → every loop cancelled


@pytest.mark.anyio
async def test_lifespan_starts_no_loop_when_the_setting_is_off_or_the_server_is_hosted(monkeypatch) -> None:
    from unittest.mock import MagicMock

    from app.main import lifespan

    _fake_engine(monkeypatch)
    _quiet_pubsub(monkeypatch)
    started: list[str] = []

    async def loop(app, job, index, **kw):
        started.append(job.route)
        await asyncio.sleep(3600)

    monkeypatch.setattr(et, "_job_loop", loop)
    for embedded, enabled in ((True, False), (False, True), (False, False)):
        with _embedded(embedded), _enabled(enabled):
            async with lifespan(MagicMock()):
                await asyncio.sleep(0.05)
    assert started == []


def test_the_lifespan_starts_and_stops_the_timers() -> None:
    """the wiring in `app/main.py`: started after the other loops, cancelled and awaited in the `finally` like them"""
    src = (Path(__file__).resolve().parents[1] / "app" / "main.py").read_text(encoding="utf-8")
    assert src.count("start_embedded_timers(app)") == 1
    assert src.count("embedded_timers_task.cancel()") == 1
    assert src.count("await embedded_timers_task") == 1
