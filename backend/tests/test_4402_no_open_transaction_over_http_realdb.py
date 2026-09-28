"""story #4402 — no DB transaction is left open while waiting on external HTTP (real PG, pg_stat_activity).

AC1a (root): FastAPI 0.136 runs `get_db`'s teardown only after the BackgroundTasks, and the commit before response only
touches sessions that wrote. A handler that commits and then reads left that read transaction idle in transaction for the
whole background work. The session dependencies now end it as the first background task (only when there is background
work — a request without any is unchanged, so the #4389 read-request pin holds).

AC1b: route_dispatch_event reads everything first, ends its transaction, then POSTs (up to ~33 s per webhook).

«Idle in transaction» is read from pg_stat_activity through a separate autocommit connection, while the slow work is running.
"""

import asyncio
import os
import uuid

import pytest

_REAL_DB_URL = os.getenv("PARITY_TEST_DATABASE_URL") or os.getenv("ALEMBIC_DATABASE_URL")

pytestmark = [
    pytest.mark.skipif(not _REAL_DB_URL, reason="통합 테스트는 실 PG(PARITY/ALEMBIC_DATABASE_URL) 필요"),
    pytest.mark.anyio,
]


@pytest.fixture
def anyio_backend():
    return "asyncio"


@pytest.fixture(autouse=True)
async def _dispose_global_engines_after_test():
    yield
    from app.core.database import engine, read_engine
    await engine.dispose()
    await read_engine.dispose()


def _async_url() -> str:
    url = _REAL_DB_URL
    for prefix in ("postgresql+psycopg2://", "postgresql+asyncpg://", "postgresql://"):
        if url.startswith(prefix):
            return "postgresql+asyncpg://" + url[len(prefix):]
    return url


class _Probe:
    """Counts this database's idle-in-transaction backends from a separate autocommit connection."""

    def __init__(self):
        from sqlalchemy.ext.asyncio import create_async_engine
        self.engine = create_async_engine(_async_url(), isolation_level="AUTOCOMMIT")

    async def idle_in_transaction(self) -> int:
        from sqlalchemy import text
        async with self.engine.connect() as conn:
            return (await conn.execute(text(
                "SELECT count(*) FROM pg_stat_activity "
                "WHERE datname = current_database() AND state LIKE 'idle in transaction%' AND pid <> pg_backend_pid()"
            ))).scalar_one()

    async def close(self):
        await self.engine.dispose()


# ── AC1a: the request's read transaction ends before the background tasks ────────────────────────────────────────

def _app(seen: dict, probe: _Probe):
    """A minimal app with the real middleware and the real get_db / get_read_db."""
    from fastapi import BackgroundTasks, Depends, FastAPI
    from fastapi.responses import JSONResponse, StreamingResponse
    from sqlalchemy import select, text

    from app.core.commit_before_response import CommitBeforeResponseMiddleware
    from app.core.database import get_db, get_read_db
    from app.models.organization import Organization

    async def _error(request, exc):
        return JSONResponse({"error": "x"}, status_code=500)

    app = FastAPI()
    app.add_middleware(CommitBeforeResponseMiddleware, error_handler=_error)

    async def slow_background(db, org=None):
        await asyncio.sleep(0.3)  # the «webhook» the request is waiting on
        seen["idle_in_tx"] = await probe.idle_in_transaction()
        seen["in_transaction"] = db.in_transaction()
        if org is not None:
            seen["org_name"] = org.name  # an ORM object loaded by the handler is still usable (no expiry)

    @app.post("/commit-then-read")
    async def commit_then_read(background_tasks: BackgroundTasks, db=Depends(get_db)):
        org = Organization(id=uuid.uuid4(), name="O4402", slug=f"o4402-{uuid.uuid4().hex[:8]}")
        db.add(org)
        await db.commit()
        await db.refresh(org)  # a read after the commit: the shape of routers/events.py:798-799
        seen["org_id"] = org.id
        background_tasks.add_task(slow_background, db, org)
        return {"ok": True}

    @app.get("/read-no-background")
    async def read_no_background(db=Depends(get_db)):
        await db.execute(text("SELECT 1"))
        return {"ok": True}

    @app.get("/read-only")
    async def read_only(background_tasks: BackgroundTasks, db=Depends(get_read_db)):
        await db.execute(text("SELECT 1"))
        background_tasks.add_task(slow_background, db)
        return {"ok": True}

    @app.get("/streaming")
    async def streaming(background_tasks: BackgroundTasks, db=Depends(get_db)):
        async def body():
            yield b"["
            n = (await db.execute(select(Organization.id).limit(1))).first()  # reads while streaming
            yield b"1" if n else b"0"
            yield b"]"
        background_tasks.add_task(slow_background, db)
        return StreamingResponse(body(), background=background_tasks)

    return app


async def _call(app, method: str, path: str):
    from httpx import ASGITransport, AsyncClient
    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as client:
        return await client.request(method, path)


async def _cleanup_org(org_id):
    from sqlalchemy import delete
    from app.core.database import async_session_factory
    from app.models.organization import Organization
    async with async_session_factory() as s:
        await s.execute(delete(Organization).where(Organization.id == org_id))
        await s.commit()


async def test_commit_then_read_leaves_no_transaction_open_during_background_work():
    seen, probe = {}, _Probe()
    try:
        resp = await _call(_app(seen, probe), "POST", "/commit-then-read")
        assert resp.status_code == 200, resp.text
        assert seen["in_transaction"] is False
        assert seen["idle_in_tx"] == 0
        assert seen["org_name"] == "O4402"
    finally:
        await _cleanup_org(seen.get("org_id"))
        await probe.close()


async def test_read_session_transaction_ends_too():
    seen, probe = {}, _Probe()
    try:
        resp = await _call(_app(seen, probe), "GET", "/read-only")
        assert resp.status_code == 200
        assert seen["in_transaction"] is False
        assert seen["idle_in_tx"] == 0
    finally:
        await probe.close()


async def test_streaming_body_completes_before_the_transaction_ends():
    seen, probe = {}, _Probe()
    try:
        resp = await _call(_app(seen, probe), "GET", "/streaming")
        assert resp.status_code == 200
        assert resp.text in ("[0]", "[1]")  # the body read the DB while streaming
        assert seen["idle_in_tx"] == 0
    finally:
        await probe.close()


async def test_a_write_is_still_committed_before_the_response():
    """Regression (#4389): the early commit of a written session is unchanged."""
    from sqlalchemy import select

    from app.core.database import async_session_factory
    from app.models.organization import Organization

    seen, probe = {}, _Probe()
    try:
        await _call(_app(seen, probe), "POST", "/commit-then-read")
        async with async_session_factory() as s:
            assert (await s.execute(select(Organization).where(Organization.id == seen["org_id"]))).scalar_one()
    finally:
        await _cleanup_org(seen.get("org_id"))
        await probe.close()


async def test_a_request_without_background_work_is_unchanged_one_commit_at_teardown(monkeypatch):
    """Qadir lens ② — a request with no background tasks is exactly as before: the only COMMIT is get_db's teardown (the
    queued task sees it is alone and does nothing). Dropping the «only with background work» guard makes it two."""
    from sqlalchemy.ext.asyncio import AsyncSession

    commits = {"n": 0}
    real_commit = AsyncSession.commit

    async def counting_commit(self):
        commits["n"] += 1
        return await real_commit(self)

    monkeypatch.setattr(AsyncSession, "commit", counting_commit)
    seen, probe = {}, _Probe()
    try:
        resp = await _call(_app(seen, probe), "GET", "/read-no-background")
        assert resp.status_code == 200
        assert commits["n"] == 1
    finally:
        await probe.close()


async def test_mutation_without_ending_the_read_transaction_it_stays_idle_in_transaction(monkeypatch):
    from app.core import database

    monkeypatch.setattr(database, "_end_read_transaction_before_background", lambda session, background_tasks: None)
    seen, probe = {}, _Probe()
    try:
        await _call(_app(seen, probe), "POST", "/commit-then-read")
        assert seen["in_transaction"] is True
        assert seen["idle_in_tx"] >= 1  # the defect: the request's read transaction waits out the background work
    finally:
        await _cleanup_org(seen.get("org_id"))
        await probe.close()


# ── AC1b: dispatch ends its transaction before the webhook POST ─────────────────────────────────────────────────

async def _seed_dispatch(channel_webhook: bool):
    from app.core.database import async_session_factory
    from app.models.event import Event
    from app.models.organization import Organization
    from app.models.project import Project
    from app.models.webhook_config import WebhookConfig

    org_id, project_id, agent_id, event_id = uuid.uuid4(), uuid.uuid4(), uuid.uuid4(), uuid.uuid4()
    async with async_session_factory() as s:
        s.add(Organization(id=org_id, name="O", slug=f"o4402d-{org_id.hex[:8]}"))
        await s.flush()
        s.add(Project(id=project_id, org_id=org_id, name="P"))
        await s.flush()
        s.add(Event(id=event_id, org_id=org_id, project_id=project_id, event_type="story_assigned",
                    recipient_id=agent_id, recipient_type="agent", payload={"title": "T"}))
        if channel_webhook:
            s.add(WebhookConfig(org_id=org_id, member_id=agent_id, url="https://hooks.example.com/4402",
                                secret="s", events=[], channel="generic", is_active=True))
        await s.commit()
    return org_id, event_id, agent_id


async def test_dispatch_posts_with_no_transaction_open_and_falls_back_to_sse(monkeypatch):
    from app.core.database import async_session_factory
    from app.models.organization import Organization
    from app.services import dispatch_router
    from sqlalchemy import delete

    org_id, event_id, agent_id = await _seed_dispatch(channel_webhook=True)
    probe, seen, pushed = _Probe(), {}, []

    async def slow_failing_post(url, payload, secret, member_id):
        await asyncio.sleep(0.3)
        seen["idle_in_tx"] = await probe.idle_in_transaction()
        seen["in_transaction"] = db.in_transaction()
        seen["url"] = url
        return False  # every retry failed → SSE fallback

    monkeypatch.setattr(dispatch_router, "_post_with_retry", slow_failing_post)
    monkeypatch.setattr("app.routers.events._push_to_agent", lambda rid, payload: pushed.append(rid))
    try:
        async with async_session_factory() as db:
            await dispatch_router.route_dispatch_event(event_id, db)
        assert seen["url"] == "https://hooks.example.com/4402"
        assert seen["in_transaction"] is False
        assert seen["idle_in_tx"] == 0
        assert pushed == [str(agent_id)]  # SSE fallback unchanged
    finally:
        async with async_session_factory() as s:
            await s.execute(delete(Organization).where(Organization.id == org_id))
            await s.commit()
        await probe.close()


async def test_dispatch_without_a_webhook_still_goes_to_sse(monkeypatch):
    from app.core.database import async_session_factory
    from app.models.organization import Organization
    from app.services import dispatch_router
    from sqlalchemy import delete

    org_id, event_id, agent_id = await _seed_dispatch(channel_webhook=False)
    pushed = []

    async def never(*a, **k):
        raise AssertionError("no webhook configured — no POST")

    monkeypatch.setattr(dispatch_router, "_post_with_retry", never)
    monkeypatch.setattr("app.routers.events._push_to_agent", lambda rid, payload: pushed.append(rid))
    try:
        async with async_session_factory() as db:
            await dispatch_router.route_dispatch_event(event_id, db)
            assert db.in_transaction() is False
        assert pushed == [str(agent_id)]
    finally:
        async with async_session_factory() as s:
            await s.execute(delete(Organization).where(Organization.id == org_id))
            await s.commit()


# ── the helper's conditions, one by one (no DB) ─────────────────────────────────────────────────────────────────────

class _FakeSession:
    def __init__(self, *, in_tx=True, wrote=False, commit_failed=False):
        from app.core.commit_before_response import COMMIT_FAILED_KEY, WROTE_KEY

        self.info = {WROTE_KEY: wrote, COMMIT_FAILED_KEY: commit_failed}
        self.new, self.dirty, self.deleted = set(), set(), set()
        self._in_tx = in_tx
        self.commits = 0

    def in_transaction(self):
        return self._in_tx

    async def commit(self):
        self.commits += 1
        self._in_tx = False


async def _run_queued(session, *, other_tasks: int) -> int:
    from fastapi import BackgroundTasks

    from app.core.database import _end_read_transaction_before_background

    tasks = BackgroundTasks()
    _end_read_transaction_before_background(session, tasks)
    for _ in range(other_tasks):
        tasks.add_task(lambda: None)
    await tasks.tasks[0]()  # the queued task runs first
    return session.commits


async def test_helper_ends_a_read_only_transaction_when_there_is_background_work():
    assert await _run_queued(_FakeSession(), other_tasks=1) == 1


@pytest.mark.parametrize(("label", "session_kwargs", "other_tasks"), [
    ("alone — no background work", {}, 0),
    ("the session wrote (left to teardown)", {"wrote": True}, 1),
    ("the commit before response failed (teardown rolls back)", {"commit_failed": True}, 1),
    ("no open transaction", {"in_tx": False}, 1),
])
async def test_helper_leaves_the_session_alone(label, session_kwargs, other_tasks):
    assert await _run_queued(_FakeSession(**session_kwargs), other_tasks=other_tasks) == 0, label

