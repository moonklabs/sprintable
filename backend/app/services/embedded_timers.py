"""story 4826 (공개 2-③ (나)) — the scheduled jobs of the app's own server.

A hosted deployment gets its periodic work from the cloud scheduler: it calls `/api/v2/internal/cron/<route>` with `Authorization: Bearer <CRON_SECRET>` on the schedule
of `infra/cloud-scheduler/jobs.json`. The app's own (embedded) server has no cloud, so here the server calls ITS OWN routes: the same app, in this process, with the same
bearer — the same auth, the same database session, the same answer as the cloud scheduler's call. Nothing about a job changes; only who knocks.

Which jobs: the 15 in `LOCAL_JOBS` — the work that lets agent runs, approval requests, hand-offs and recurring recipes finish by themselves, the retention sweeps and the shared
worker tick. The other 12 of the manifest are hosted-only (plan limits, payments, the onboarding funnel, GA4, hosted ops checks, the phone relay, account purge) and are
NOT removed from the cloud scheduler: `EXCLUDED` names each with the reason, and `tests/test_4826_embedded_timers.py` fails when a job of the manifest is in neither.

How a job runs:
- every job has a loop of its own (a slow `publication-commands` tick — it may take half an hour — never holds back a ten-minute sweep), one lap at a time per job;
- right after start each job looks at when it last ran (the database's clock, `embedded_timer_runs`): a job whose interval has passed runs ONCE however many laps the closed
  app missed; the jobs' first looks are staggered, so a start is not a stampede; after that, one lap per interval;
- a job with a prerequisite of its own asks the SAME check the feature makes before every lap and skips the lap when it is not met (one debug line, no call, no «last run»):
  `embed-backlog` needs Vertex credentials (without them every pending row would count a retry and fail for good five laps on); `refresh-channel-tokens` needs a channel
  connection that is due. A job with no prerequisite of its own (the 13 others — including `publication-commands`, whose tick also carries the shared work queue and the 30-day
  sweeps, so it must never wait for a channel) always runs; each of them finds nothing to do on an empty table;
- a lap that fails, answers an error or passes its deadline is logged and the loop goes on (never takes the server down); a loop that itself ends with an error (a bug) is logged and
  started again after a pause, the other loops untouched; cancelling stops every loop.

Only the app's own server starts this (`start_embedded_timers`: `settings.is_embedded` — switch + secret, never Cloud Run — and the explicit `embedded_timers_enabled` setting, default on). `EMBEDDED_TIMER_SPEEDUP`
(a number ≥ 1, read only there) divides every interval and delay so a lap of every job can be watched in a minute; unset = the cloud scheduler's own intervals.
"""
from __future__ import annotations

import asyncio
import logging
import math
import os
import time
from dataclasses import dataclass
from typing import Any, Awaitable, Callable

from sqlalchemy import text

logger = logging.getLogger(__name__)

CRON_PREFIX = "/api/v2/internal/cron/"
START_DELAY_SEC = 20.0  # after the app is up, before the first look at what is due
STAGGER_SEC = 3.0  # each job's first look comes this much after the previous job's — a start is not a stampede
RESTART_PAUSE_SEC = 60.0  # a loop that ended with an error (a bug) is started again after this (or its own interval if shorter)
DEFAULT_DEADLINE_SEC = 180.0  # the cloud scheduler's default `attempt_deadline`
MAX_SPEEDUP = 100_000.0

Precondition = Callable[[Any], Awaitable["str | None"]]  # (db session) -> None when the lap may run, else why it is skipped


@dataclass(frozen=True)
class TimerJob:
    route: str  # the cron route (the job's name in `infra/cloud-scheduler/jobs.json`)
    method: str
    every_seconds: int  # the cloud scheduler's interval for this job
    deadline_seconds: float = DEFAULT_DEADLINE_SEC  # its `attempt_deadline`
    precondition: "Precondition | None" = None  # None: no prerequisite of its own — always runs

    @property
    def name(self) -> str:
        return self.route


async def _embedding_ready(db: Any) -> "str | None":
    """`embed-backlog`: the same check `embed_text` makes (`embedding_client.has_credentials`) — it can block on the credentials lookup, so off the loop."""
    from app.services import embedding_client

    if await asyncio.to_thread(embedding_client.has_credentials):
        return None
    return "no Vertex credentials (GOOGLE_APPLICATION_CREDENTIALS or Application Default Credentials) — the check embed_text makes"


async def _refresh_due(db: Any) -> "str | None":
    """`refresh-channel-tokens`: the same query the job itself starts from — a channel connection whose token is due for a refresh."""
    from datetime import datetime, timezone

    from app.services.channel_connection import list_connections_due_for_refresh

    due = await list_connections_due_for_refresh(db, now=datetime.now(timezone.utc))
    return None if due else "no channel connection is due for a token refresh"


# interval = the cloud scheduler's (`infra/cloud-scheduler/jobs.json`): */10 → 600 s, */5 → 300 s, hourly → 3600 s, every 6 h → 21600 s, daily → 86400 s, every minute → 60 s
LOCAL_JOBS: tuple[TimerJob, ...] = (
    # let what is running finish by itself
    TimerJob("a2a-task-deadline-sweep", "GET", 600),
    TimerJob("agent-run-timeout-sweep", "GET", 600),
    TimerJob("agent-session-recovery", "GET", 600),
    TimerJob("hitl-timeouts", "GET", 600),
    TimerJob("workflow-sla", "GET", 600),
    TimerJob("workflow-handoff-watchdog", "GET", 300),
    TimerJob("recipe-repeat-tick", "GET", 600),
    # upkeep
    TimerJob("expire-stale-events", "GET", 86400),
    TimerJob("assets-grace-hard-delete", "GET", 86400),
    # the shared worker tick: publication commands + the shared work queue (retro synthesis, attachment conversion, …) + the 30-day sweeps + reference backfill — never waits for a channel
    TimerJob("publication-commands", "POST", 60, deadline_seconds=1800.0),
    # database only, no prerequisite of their own
    TimerJob("detect-unclosed-loops", "POST", 3600),
    TimerJob("score-hypotheses", "POST", 3600),
    TimerJob("unattached-snapshot", "POST", 86400),
    # with a prerequisite
    TimerJob("embed-backlog", "POST", 3600, precondition=_embedding_ready),
    TimerJob("refresh-channel-tokens", "GET", 21600, deadline_seconds=300.0, precondition=_refresh_due),
)

# the jobs of the manifest that stay with the hosted deployment (NOT removed from the cloud scheduler)
EXCLUDED: dict[str, str] = {
    "au-usage-warn": "hosted plan limit (AU) warnings",
    "storage-usage-warn": "hosted plan limit (storage) warning mail",
    "billing-payment-attempts": "hosted payments (Toss)",
    "toss-billing-maintenance": "hosted payments (Toss)",
    "toss-daily-reconciliation": "hosted payments (Toss)",
    "onboarding-abandoned-sweep": "hosted sign-up funnel",
    "onboarding-reminder-sweep": "hosted sign-up reminder mail",
    "score-ga4-outcomes": "needs a GA4 connection",
    "entity-references-orphan-check": "hosted operations check (read-only, log)",
    "zero-referenced-entities-check": "hosted operations check (read-only, log)",
    "clock-edit-scrub": "phone relay — off in local mode (story 4829)",
    "account-purge": "hosted account-deletion grace (a local install has one owner)",
}


def speedup() -> float:
    """`EMBEDDED_TIMER_SPEEDUP`: a finite number ≥ 1 (≤ MAX_SPEEDUP) divides every interval and delay; unset, empty or anything else = 1 (the cloud scheduler's own intervals)."""
    raw = os.environ.get("EMBEDDED_TIMER_SPEEDUP", "").strip()
    if not raw:
        return 1.0
    try:
        v = float(raw)
    except ValueError:
        return 1.0
    return min(v, MAX_SPEEDUP) if math.isfinite(v) and v >= 1.0 else 1.0


async def _seconds_since_last_run(name: str) -> "float | None":
    """Seconds since the job last ran by the DATABASE's clock (None: it never ran) — two clocks are never compared."""
    from app.core.database import async_session_factory

    async with async_session_factory() as db:
        row = (await db.execute(
            text("SELECT EXTRACT(EPOCH FROM (now() - last_run_at)) FROM embedded_timer_runs WHERE job_name = :n"), {"n": name},
        )).first()
    return None if row is None else float(row[0])


async def _write_last_run(name: str, status: "int | None", ms: int) -> None:
    from app.core.database import async_session_factory

    async with async_session_factory() as db:
        await db.execute(
            text(
                "INSERT INTO embedded_timer_runs (job_name, last_run_at, last_status, last_ms) VALUES (:n, now(), :s, :ms) "
                "ON CONFLICT (job_name) DO UPDATE SET last_run_at = now(), last_status = :s, last_ms = :ms"
            ),
            {"n": name, "s": status, "ms": ms},
        )
        await db.commit()


async def _call_cron(app: Any, job: TimerJob) -> int:
    """The job's route, called in this process through the app itself with the bearer the cloud scheduler would send (same auth · same session · same answer)."""
    import httpx

    from app.routers import cron as cron_module

    headers = {"Authorization": f"Bearer {cron_module.CRON_SECRET}"} if cron_module.CRON_SECRET else {}
    transport = httpx.ASGITransport(app=app, raise_app_exceptions=False)
    async with httpx.AsyncClient(transport=transport, base_url="http://127.0.0.1", timeout=job.deadline_seconds) as client:
        response = await asyncio.wait_for(client.request(job.method, CRON_PREFIX + job.route, headers=headers), timeout=job.deadline_seconds)
    return response.status_code


async def _lap(app: Any, job: TimerJob, *, call: Callable[[Any, TimerJob], Awaitable[int]] = _call_cron) -> str:
    """One lap of one job: «skipped» when its prerequisite is not met, else the call and the record of it. Never raises (a cancel excepted)."""
    if job.precondition is not None:
        from app.core.database import async_session_factory

        async with async_session_factory() as db:
            why = await job.precondition(db)
        if why:
            logger.debug("embedded timer: skip %s — %s", job.name, why)
            return "skipped"
    started = time.monotonic()
    status: "int | None" = None
    try:
        status = await call(app, job)
    except asyncio.CancelledError:
        raise
    except asyncio.TimeoutError:
        logger.warning("embedded timer: %s passed its %ss deadline", job.name, job.deadline_seconds)
    except Exception:  # noqa: BLE001 — a failed lap is logged, the loop goes on
        logger.warning("embedded timer: %s could not be called", job.name, exc_info=True)
    ms = int((time.monotonic() - started) * 1000)
    if status is not None and status < 400:
        logger.info("embedded timer: ran %s -> %s in %d ms", job.name, status, ms)
    elif status is not None:
        logger.warning("embedded timer: %s answered %s in %d ms", job.name, status, ms)
    try:
        await _write_last_run(job.name, status, ms)
    except asyncio.CancelledError:
        raise
    except Exception:  # noqa: BLE001
        logger.warning("embedded timer: the last run of %s could not be written", job.name, exc_info=True)
    return "ran"


async def _job_loop(app: Any, job: TimerJob, index: int, *, sleep: Callable[[float], Awaitable[Any]] = asyncio.sleep,
                    call: Callable[[Any, TimerJob], Awaitable[int]] = _call_cron) -> None:
    k = speedup()
    interval = job.every_seconds / k
    await sleep((START_DELAY_SEC + index * STAGGER_SEC) / k)
    try:
        since = await _seconds_since_last_run(job.name)
    except asyncio.CancelledError:
        raise
    except Exception:  # noqa: BLE001 — not knowing the last run is «never ran»: one lap now, then the interval
        logger.warning("embedded timer: the last run of %s could not be read", job.name, exc_info=True)
        since = None
    # catch-up: the interval passed while the app was closed → one lap now (however many were missed); else wait out the rest of it
    await sleep(0.0 if since is None else max(0.0, interval - since))
    while True:
        try:
            await _lap(app, job, call=call)
        except asyncio.CancelledError:
            raise
        except Exception:  # noqa: BLE001 — never ends the loop
            logger.warning("embedded timer: a lap of %s failed", job.name, exc_info=True)
        await sleep(interval)


async def _supervised(app: Any, job: TimerJob, index: int, *, sleep: Callable[[float], Awaitable[Any]] = asyncio.sleep) -> None:
    """One job's loop, kept alive. A failed lap never gets this far (`_lap` logs it and the loop waits for the next interval); this is for the loop itself ending with an error —
    a bug. It is logged and that ONE loop is started again after a short pause; the other jobs are not touched (a dead loop must not silently end retro synthesis,
    attachment conversion or the 30-day sweeps for a person who has no way to see it). Cancelling ends it."""
    pause = min(job.every_seconds, RESTART_PAUSE_SEC) / speedup()
    while True:
        try:
            await _job_loop(app, job, index)
        except asyncio.CancelledError:
            raise
        except Exception:  # noqa: BLE001 — one loop's failure never ends the others
            logger.error("embedded timer: the loop of %s ended with an error — started again in %.0f s", job.name, pause, exc_info=True)
        await sleep(pause)


async def run_embedded_timers(app: Any) -> None:
    """Every job's loop, until cancelled (then every loop is cancelled and waited for)."""
    tasks = [asyncio.create_task(_supervised(app, job, i), name=f"embedded-timer:{job.name}") for i, job in enumerate(LOCAL_JOBS)]
    try:
        await asyncio.gather(*tasks)
    finally:
        for t in tasks:
            t.cancel()
        await asyncio.gather(*tasks, return_exceptions=True)


def start_embedded_timers(app: Any) -> "asyncio.Task | None":
    """Called by the app's lifespan. Starts the timers only on the app's own server (`settings.is_embedded`) and only while the explicit setting `embedded_timers_enabled`
    is on (default on; the test configuration turns it off, so no test runs 15 loops behind it — a loop that crosses the tests' event loops would mix their futures
    into the shared pool). None otherwise."""
    from app.core.config import settings

    if not settings.is_embedded or not settings.embedded_timers_enabled:
        return None
    logger.info("embedded timers: %d jobs (speedup %s)", len(LOCAL_JOBS), speedup())
    return asyncio.create_task(run_embedded_timers(app), name="embedded-timers")
