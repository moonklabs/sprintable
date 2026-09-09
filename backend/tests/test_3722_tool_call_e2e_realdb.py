"""story #3722 — 전체 파이프라인 e2e(실 PG·실 agent API key 인증): 미들웨어→귀속→INSERT→
GET 조회, cascade 삭제, 보존기간 스윕. 실 인증 경로(x-agent-api-key)로 태워 request.state.
au_actor 등이 진짜 `get_current_user()`가 채운 값인지까지 함께 검증한다(get_current_user
자체를 override하면 그 SSOT 세팅 라인이 안 돌아 미들웨어가 절대 못 본다 — dependency
override로는 이 미들웨어를 정직하게 못 잰다, real-key 경로가 유일한 정답)."""
from __future__ import annotations

import asyncio
import os
import uuid
from datetime import UTC

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
async def _dispose_global_engine_after_test():
    yield
    from app.core.database import engine as _global_engine
    await _global_engine.dispose()


def _async_url() -> str:
    url = _REAL_DB_URL
    for prefix in ("postgresql+psycopg2://", "postgresql+asyncpg://", "postgresql://"):
        if url.startswith(prefix):
            return "postgresql+asyncpg://" + url[len(prefix):]
    return url


async def _session_factory():
    from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine
    engine = create_async_engine(_async_url())
    return engine, async_sessionmaker(engine, expire_on_commit=False)


async def _drain_background_tasks() -> None:
    current = asyncio.current_task()
    pending = [t for t in asyncio.all_tasks() if t is not current and not t.done()]
    if pending:
        await asyncio.gather(*pending)


async def _seed_agent_with_key(session):
    """test_2600_charlie_discovery_e2e_realdb.py `_seed_agent` 패턴 재사용."""
    from app.core.security import hash_token
    from app.models.api_key import ApiKey
    from app.models.member import Member
    from app.models.organization import Organization
    from app.models.project import Project
    from app.models.project_access import ProjectAccess

    org = Organization(id=uuid.uuid4(), name="Org", slug=f"org-{uuid.uuid4().hex[:8]}")
    session.add(org)
    await session.commit()
    project = Project(id=uuid.uuid4(), org_id=org.id, name="Project")
    session.add(project)
    await session.commit()
    agent = Member(id=uuid.uuid4(), org_id=org.id, type="agent", name="Agent A")
    session.add(agent)
    await session.commit()
    session.add(ProjectAccess(id=uuid.uuid4(), project_id=project.id, member_id=agent.id, permission="granted"))
    await session.commit()

    raw_key = f"sk_live_{uuid.uuid4().hex}"
    session.add(ApiKey(
        id=uuid.uuid4(), team_member_id=agent.id, member_id=agent.id,
        key_prefix=raw_key[:12], key_hash=hash_token(raw_key), scope=["read", "write"],
    ))
    await session.commit()
    return {"org_id": org.id, "project_id": project.id, "agent_id": agent.id, "raw_key": raw_key}


def _client_with_key(app, raw_key: str):
    from httpx import ASGITransport, AsyncClient
    return AsyncClient(
        transport=ASGITransport(app=app), base_url="http://test",
        headers={"x-agent-api-key": raw_key},
    )


class _PatchedGlobalSessionFactory:
    """test_2087_agent_api_key_usage_audit_trail_realdb.py 선례 확장 — `async_session_
    factory`를 여러 모듈이 각자 `from app.core.database import async_session_factory`로
    자기 네임스페이스에 따로 바인딩해 뒀다(app.core.database 원본만 패치하면 이 모듈들의
    사본은 그대로 안 바뀐다 — `from X import Y`는 새 독립 바인딩). 이 요청 경로가 실제로
    거치는 자리(get_current_user→_resolve_api_key가 쓰는 app.dependencies.auth·
    AUMeteringMiddleware가 쓰는 app.services.au_metering) 전부를 같이 교체해야
    "attached to a different loop" 없이 돈다."""

    _MODULES = ("app.core.database", "app.dependencies.auth", "app.services.au_metering")

    def __init__(self, session_factory):
        self._session_factory = session_factory
        self._orig: dict[str, object] = {}

    async def __aenter__(self):
        import importlib
        for mod_name in self._MODULES:
            mod = importlib.import_module(mod_name)
            self._orig[mod_name] = mod.async_session_factory
            mod.async_session_factory = self._session_factory
        return self

    async def __aexit__(self, *exc):
        import importlib
        for mod_name, orig in self._orig.items():
            mod = importlib.import_module(mod_name)
            mod.async_session_factory = orig


def _wire_db(app, Session) -> None:
    """get_db/get_read_db만 테스트 세션으로 갈아끼운다 — get_current_user는 절대 override
    안 한다(진짜 인증 경로를 태워야 request.state.au_actor 등 SSOT가 실제로 채워진다,
    모듈 docstring 참고). test_2600 관례(override_db_and_read) 그대로."""
    from tests.conftest import override_db_and_read

    async def _db():
        async with Session() as sess:
            try:
                yield sess
                await sess.commit()
            except Exception:
                await sess.rollback()
                raise
    override_db_and_read(app, _db)


@pytest.mark.anyio
async def test_real_agent_request_lands_a_row_attributed_to_single_running_run():
    from sqlalchemy import select

    from app.main import app
    from app.models.agent_run import AgentRun
    from app.models.agent_run_tool_call import AgentRunToolCall

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            ctx = await _seed_agent_with_key(s)
            run = AgentRun(
                id=uuid.uuid4(), org_id=ctx["org_id"], agent_id=ctx["agent_id"],
                project_id=ctx["project_id"], trigger="manual", status="running",
            )
            s.add(run)
            await s.commit()
            run_id = run.id

        app.dependency_overrides.clear()
        _wire_db(app, Session)
        client = _client_with_key(app, ctx["raw_key"])
        async with _PatchedGlobalSessionFactory(Session):
            async with client:
                resp = await client.get(f"/api/v2/agent-runs?project_id={ctx['project_id']}")
                await _drain_background_tasks()
        assert resp.status_code == 200

        async with Session() as s:
            rows = list((await s.execute(
                select(AgentRunToolCall).where(AgentRunToolCall.agent_id == ctx["agent_id"])
            )).scalars().all())
        assert len(rows) == 1, f"정확히 1행이 기록돼야(회귀): {rows}"
        row = rows[0]
        assert row.run_id == run_id, "단일 running run 상관(ⓑ)이 실제로 동작해야"
        assert row.attribution_reason == "single_running"
        assert row.method == "GET"
        assert row.status_code == 200
        assert row.org_id == ctx["org_id"]
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()


@pytest.mark.anyio
async def test_get_tool_calls_endpoint_returns_rows_for_that_run_newest_first():
    from datetime import datetime, timedelta

    from app.main import app
    from app.models.agent_run import AgentRun
    from app.models.agent_run_tool_call import AgentRunToolCall

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            ctx = await _seed_agent_with_key(s)
            run = AgentRun(
                id=uuid.uuid4(), org_id=ctx["org_id"], agent_id=ctx["agent_id"],
                project_id=ctx["project_id"], trigger="manual", status="running",
            )
            s.add(run)
            await s.commit()

            now = datetime.now(UTC)
            older = AgentRunToolCall(
                id=uuid.uuid4(), org_id=ctx["org_id"], agent_id=ctx["agent_id"], run_id=run.id,
                method="GET", path="/api/v2/older", status_code=200, duration_ms=5,
                started_at=now - timedelta(minutes=5), attribution_reason="single_running",
                created_at=now - timedelta(minutes=5),
            )
            newer = AgentRunToolCall(
                id=uuid.uuid4(), org_id=ctx["org_id"], agent_id=ctx["agent_id"], run_id=run.id,
                method="POST", path="/api/v2/newer", status_code=201, duration_ms=8,
                started_at=now, attribution_reason="single_running", created_at=now,
            )
            s.add_all([older, newer])
            await s.commit()
            run_id = run.id

        app.dependency_overrides.clear()
        _wire_db(app, Session)
        client = _client_with_key(app, ctx["raw_key"])
        async with _PatchedGlobalSessionFactory(Session), client:
            resp = await client.get(f"/api/v2/agent-runs/{run_id}/tool-calls")
            await _drain_background_tasks()
        assert resp.status_code == 200, resp.text
        body = resp.json()
        assert len(body) == 2
        assert body[0]["path"] == "/api/v2/newer", "최신순(created_at DESC)이어야"
        assert body[1]["path"] == "/api/v2/older"
        assert resp.headers["X-Total-Count"] == "2"
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()


@pytest.mark.anyio
async def test_get_tool_calls_x_total_count_reflects_full_count_not_page_size():
    """페드루 PO 追加(2026-09-09) — X-Total-Count는 limit 適用 前 run_id 기준 전체
    건수(3703/3706류 «한 페이지=전부» 오판 재발 방지). 51행 표본에 limit=50 → 헤더 51."""
    from datetime import datetime, timedelta

    from app.main import app
    from app.models.agent_run import AgentRun
    from app.models.agent_run_tool_call import AgentRunToolCall

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            ctx = await _seed_agent_with_key(s)
            run = AgentRun(
                id=uuid.uuid4(), org_id=ctx["org_id"], agent_id=ctx["agent_id"],
                project_id=ctx["project_id"], trigger="manual", status="running",
            )
            s.add(run)
            await s.commit()

            now = datetime.now(UTC)
            for i in range(51):
                s.add(AgentRunToolCall(
                    id=uuid.uuid4(), org_id=ctx["org_id"], agent_id=ctx["agent_id"], run_id=run.id,
                    method="GET", path=f"/api/v2/row-{i}", status_code=200, duration_ms=1,
                    started_at=now - timedelta(seconds=i), attribution_reason="single_running",
                    created_at=now - timedelta(seconds=i),
                ))
            await s.commit()
            run_id = run.id

        app.dependency_overrides.clear()
        _wire_db(app, Session)
        client = _client_with_key(app, ctx["raw_key"])
        async with _PatchedGlobalSessionFactory(Session), client:
            resp = await client.get(f"/api/v2/agent-runs/{run_id}/tool-calls?limit=50")
            await _drain_background_tasks()
        assert resp.status_code == 200, resp.text
        assert len(resp.json()) == 50, "limit=50이 페이지를 자름"
        assert resp.headers["X-Total-Count"] == "51", "헤더는 limit 適用 前 전체 건수"
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()


@pytest.mark.anyio
async def test_get_tool_calls_404_for_other_org_run():
    from app.main import app

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            ctx = await _seed_agent_with_key(s)
            await s.commit()

        app.dependency_overrides.clear()
        _wire_db(app, Session)
        client = _client_with_key(app, ctx["raw_key"])
        async with _PatchedGlobalSessionFactory(Session), client:
            resp = await client.get(f"/api/v2/agent-runs/{uuid.uuid4()}/tool-calls")
            await _drain_background_tasks()
        assert resp.status_code == 404
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()


@pytest.mark.anyio
async def test_run_deletion_cascades_to_tool_calls():
    from sqlalchemy import select

    from app.models.agent_run import AgentRun
    from app.models.agent_run_tool_call import AgentRunToolCall

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            ctx = await _seed_agent_with_key(s)
            run = AgentRun(
                id=uuid.uuid4(), org_id=ctx["org_id"], agent_id=ctx["agent_id"],
                project_id=ctx["project_id"], trigger="manual", status="running",
            )
            s.add(run)
            await s.commit()
            call = AgentRunToolCall(
                id=uuid.uuid4(), org_id=ctx["org_id"], agent_id=ctx["agent_id"], run_id=run.id,
                method="GET", path="/api/v2/x", status_code=200, duration_ms=1,
                started_at=run.started_at, attribution_reason="single_running",
            )
            s.add(call)
            await s.commit()
            call_id = call.id
            run_id = run.id

            await s.delete(run)
            await s.commit()

            remaining = (await s.execute(
                select(AgentRunToolCall).where(AgentRunToolCall.id == call_id)
            )).scalar_one_or_none()
            assert remaining is None, f"run(id={run_id}) 삭제가 cascade 안 됨(회귀)"
    finally:
        await engine.dispose()


@pytest.mark.anyio
async def test_retention_sweep_deletes_only_rows_older_than_30_days():
    from datetime import datetime, timedelta

    from sqlalchemy import select

    from app.models.agent_run_tool_call import AgentRunToolCall
    from app.services.tool_call_recording import sweep_old_tool_calls

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            ctx = await _seed_agent_with_key(s)
            now = datetime.now(UTC)
            old = AgentRunToolCall(
                id=uuid.uuid4(), org_id=ctx["org_id"], agent_id=ctx["agent_id"], run_id=None,
                method="GET", path="/api/v2/old", status_code=200, duration_ms=1,
                started_at=now - timedelta(days=31), attribution_reason="no_running_run",
                created_at=now - timedelta(days=31),
            )
            recent = AgentRunToolCall(
                id=uuid.uuid4(), org_id=ctx["org_id"], agent_id=ctx["agent_id"], run_id=None,
                method="GET", path="/api/v2/recent", status_code=200, duration_ms=1,
                started_at=now - timedelta(days=1), attribution_reason="no_running_run",
                created_at=now - timedelta(days=1),
            )
            s.add_all([old, recent])
            await s.commit()

            deleted_before = list((await s.execute(
                select(AgentRunToolCall).where(AgentRunToolCall.agent_id == ctx["agent_id"])
            )).scalars().all())
            assert len(deleted_before) == 2

            deleted = await sweep_old_tool_calls(s, now=now)
            assert deleted >= 1  # 다른 테스트의 leftover 행도 30일 컷오프 대상이면 같이 잡힐 수 있다.

            remaining = list((await s.execute(
                select(AgentRunToolCall).where(AgentRunToolCall.agent_id == ctx["agent_id"])
            )).scalars().all())
            assert len(remaining) == 1
            assert remaining[0].path == "/api/v2/recent"
    finally:
        await engine.dispose()
