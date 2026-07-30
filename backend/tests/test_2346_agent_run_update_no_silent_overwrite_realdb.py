"""story #2346 AC1 — `update_run_status`(PATCH /agent-runs/{id})가 result_summary·
last_error_code를 «생략해도 항상 덮어쓰던» 결함, 실 PG.

원인(두 층의 조합, 각자는 말이 됨): 라우터가 body.result_summary/body.last_error_code를
항상 명시 전달(Optional, 기본 None) + repo.update()가 이 두 필드만 `v is not None or
k in (...)` 특례로 항상 set. 캐폴러가 요청에서 필드를 생략해도 body.X=None이 그대로
내려가 기존 값을 지웠다.

수정: 라우터가 body.model_dump(exclude_unset=True)로 "실제로 요청에 있던 필드만" 넘기고,
repo 특례를 제거한다 — 생략(값 보존)과 명시적 null(의도적 비우기)이 이제 갈린다.
"""
from __future__ import annotations

import os
import uuid

import pytest

_REAL_DB_URL = os.getenv("PARITY_TEST_DATABASE_URL") or os.getenv("ALEMBIC_DATABASE_URL")

pytestmark = [
    pytest.mark.skipif(not _REAL_DB_URL, reason="통합 테스트는 실 PG(PARITY/ALEMBIC_DATABASE_URL) 필요"),
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


async def _seed(session):
    from app.models.agent_run import AgentRun
    from app.models.organization import Organization
    from app.models.project import OrgMember, Project
    from app.models.project_access import ProjectAccess
    from app.models.user import User

    org = Organization(id=uuid.uuid4(), name="Org", slug=f"org-{uuid.uuid4().hex[:8]}")
    session.add(org)
    await session.commit()
    project = Project(id=uuid.uuid4(), org_id=org.id, name="Project")
    session.add(project)
    await session.commit()
    run = AgentRun(
        id=uuid.uuid4(), org_id=org.id, project_id=project.id, agent_id=uuid.uuid4(),
        trigger="manual", status="running",
    )
    session.add(run)
    await session.commit()

    caller_id = uuid.uuid4()
    caller = User(id=caller_id, email=f"caller-{caller_id.hex[:8]}@test.com", hashed_password="x")
    session.add(caller)
    await session.commit()
    caller_om = OrgMember(id=uuid.uuid4(), org_id=org.id, user_id=caller_id, role="member")
    session.add(caller_om)
    await session.commit()
    session.add(ProjectAccess(
        id=uuid.uuid4(), project_id=project.id, org_member_id=caller_om.id, permission="granted", role="member",
    ))
    await session.commit()

    return {"org_id": org.id, "run_id": run.id, "caller_id": caller_id}


def _client_for(app):
    from httpx import AsyncClient, ASGITransport
    return AsyncClient(transport=ASGITransport(app=app), base_url="http://test")


async def _setup_app(app, Session, user_id, org_id):
    from app.dependencies.auth import AuthContext, get_current_user, get_verified_org_id
    from app.dependencies.database import get_db

    async def _db():
        async with Session() as s:
            try:
                yield s
                await s.commit()
            except Exception:
                await s.rollback()
                raise

    async def _auth():
        return AuthContext(user_id=str(user_id), email="caller@test", claims={"app_metadata": {"org_id": str(org_id)}})

    async def _org():
        return org_id

    app.dependency_overrides[get_db] = _db
    app.dependency_overrides[get_current_user] = _auth
    app.dependency_overrides[get_verified_org_id] = _org


async def _fetch_run(Session, run_id):
    from sqlalchemy import text
    async with Session() as s:
        row = (await s.execute(
            text("SELECT result_summary, last_error_code, status, finished_at FROM agent_runs WHERE id = :i"),
            {"i": run_id},
        )).one()
        return {"result_summary": row[0], "last_error_code": row[1], "status": row[2], "finished_at": row[3]}


@pytest.mark.anyio
async def test_omitting_result_summary_preserves_existing_value_write_then_read_roundtrip():
    """AC1 핵심 — write→read 왕복: ①값 채우고 ②그 필드 없이 update ③다시 읽어 살아 있는지."""
    from app.main import app
    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            seeded = await _seed(s)
        await _setup_app(app, Session, seeded["caller_id"], seeded["org_id"])
        client = _client_for(app)
        try:
            # ①값 채운다.
            r1 = await client.patch(
                f"/api/v2/agent-runs/{seeded['run_id']}",
                json={"status": "running", "result_summary": "partial progress", "last_error_code": "E_TIMEOUT"},
            )
            assert r1.status_code == 200, r1.text
            before = await _fetch_run(Session, seeded["run_id"])
            assert before["result_summary"] == "partial progress"
            assert before["last_error_code"] == "E_TIMEOUT"

            # ②그 필드 없이(생략) 다시 status만 update.
            r2 = await client.patch(
                f"/api/v2/agent-runs/{seeded['run_id']}",
                json={"status": "running"},
            )
            assert r2.status_code == 200, r2.text

            # ③다시 읽어 «살아 있는지» — 이게 이 스토리의 원 버그가 깨졌던 자리.
            after = await _fetch_run(Session, seeded["run_id"])
            assert after["result_summary"] == "partial progress", (
                f"생략한 필드가 지워짐(회귀): {after}"
            )
            assert after["last_error_code"] == "E_TIMEOUT", f"생략한 필드가 지워짐(회귀): {after}"
        finally:
            await client.aclose()
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()


@pytest.mark.anyio
async def test_explicit_null_still_clears_the_field():
    """조건①(파울로 요청) — 명시적 null로 «비우는» 길이 실제로 도는지. 안 비워지면 그것도
    결함(아무것도 못 지우는 도구가 됨)."""
    from app.main import app
    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            seeded = await _seed(s)
        await _setup_app(app, Session, seeded["caller_id"], seeded["org_id"])
        client = _client_for(app)
        try:
            await client.patch(
                f"/api/v2/agent-runs/{seeded['run_id']}",
                json={"status": "running", "last_error_code": "E_TIMEOUT"},
            )
            before = await _fetch_run(Session, seeded["run_id"])
            assert before["last_error_code"] == "E_TIMEOUT"

            # 명시적으로 null을 보낸다(생략이 아니라 «의도적 비우기»).
            resp = await client.patch(
                f"/api/v2/agent-runs/{seeded['run_id']}",
                json={"status": "running", "last_error_code": None},
            )
            assert resp.status_code == 200, resp.text
            after = await _fetch_run(Session, seeded["run_id"])
            assert after["last_error_code"] is None, "명시적 null이 안 먹힘 — 아무것도 못 지우는 도구가 됨"
        finally:
            await client.aclose()
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()


@pytest.mark.anyio
async def test_finished_at_auto_fill_on_terminal_status_unbroken():
    """조건②(파울로 요청) 양성 대조 — finished_at을 안 주고 종단 상태로 전이하면 서버가
    now()로 채우는 기존 동작이 exclude_unset 전환으로 안 깨졌는지."""
    from app.main import app
    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            seeded = await _seed(s)
        await _setup_app(app, Session, seeded["caller_id"], seeded["org_id"])
        client = _client_for(app)
        try:
            resp = await client.patch(
                f"/api/v2/agent-runs/{seeded['run_id']}",
                json={"status": "completed"},  # finished_at 생략
            )
            assert resp.status_code == 200, resp.text
            after = await _fetch_run(Session, seeded["run_id"])
            assert after["status"] == "completed"
            assert after["finished_at"] is not None, "종단 상태인데 finished_at 자동 채움이 깨짐(회귀)"
        finally:
            await client.aclose()
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()


@pytest.mark.anyio
async def test_finished_at_explicit_value_still_respected():
    """조건②(파울로 요청) 양성 대조 — finished_at을 클라가 명시로 주면 그 값을 그대로 쓰는지
    (서버 now()로 덮어쓰지 않는지)."""
    from datetime import datetime, timezone
    from app.main import app
    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            seeded = await _seed(s)
        await _setup_app(app, Session, seeded["caller_id"], seeded["org_id"])
        client = _client_for(app)
        try:
            explicit_ts = "2020-01-01T00:00:00+00:00"
            resp = await client.patch(
                f"/api/v2/agent-runs/{seeded['run_id']}",
                json={"status": "completed", "finished_at": explicit_ts},
            )
            assert resp.status_code == 200, resp.text
            after = await _fetch_run(Session, seeded["run_id"])
            assert after["finished_at"] == datetime(2020, 1, 1, tzinfo=timezone.utc)
        finally:
            await client.aclose()
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()


