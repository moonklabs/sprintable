"""story #3725 — `AgentRunResponse`에 모델 실재 5필드(deployment_id·failure_disposition·
retry_count·max_retries·next_retry_at)가 빠져 실행 상세의 재시도·실패 처분 UI가 늘 폴백이던
것, 실 PG.

이 5필드엔 공개 API 쓰기 경로가 없다(CreateAgentRun/UpdateAgentRun에 없음 — 리퍼·재시도
스케줄러가 내부에서 직접 쓴다). 그래서 이 테스트는 DB 직접 fixture로 값을 심고 GET 응답에
그대로 실리는지만 pin한다(쓰기 경로 자체는 이 스토리 범위 밖).
"""
from __future__ import annotations

import os
import uuid
from datetime import datetime, timedelta, timezone

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
    from app.models.member import Member
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

    agent = Member(id=uuid.uuid4(), org_id=org.id, type="agent", name="Agent A")
    session.add(agent)
    await session.commit()
    session.add(ProjectAccess(
        id=uuid.uuid4(), project_id=project.id, member_id=agent.id, permission="granted", role="member",
    ))
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

    return {"org_id": org.id, "project_id": project.id, "agent_id": agent.id, "caller_id": caller_id}


def _client_for(app):
    from httpx import ASGITransport, AsyncClient
    return AsyncClient(transport=ASGITransport(app=app), base_url="http://test")


async def _setup_app(app, Session, user_id, org_id):
    from app.dependencies.auth import AuthContext, get_current_user, get_verified_org_id
    from tests.conftest import override_db_and_read

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

    override_db_and_read(app, _db)
    app.dependency_overrides[get_current_user] = _auth
    app.dependency_overrides[get_verified_org_id] = _org


async def _set_retry_fields_directly(Session, run_id, deployment_id, next_retry_at):
    """공개 쓰기 경로가 없는 필드(리퍼/재시도 스케줄러 내부 전용) — DB 직접 fixture."""
    from sqlalchemy import text
    async with Session() as s:
        await s.execute(
            text(
                "UPDATE agent_runs SET deployment_id = :dep, failure_disposition = :fd, "
                "retry_count = :rc, max_retries = :mr, next_retry_at = :nra WHERE id = :id"
            ),
            {
                "dep": deployment_id, "fd": "retry_scheduled", "rc": 2, "mr": 3,
                "nra": next_retry_at, "id": run_id,
            },
        )
        await s.commit()


@pytest.mark.anyio
async def test_additive_fields_readable_after_direct_db_write():
    """AC 핵심 — DB에 값이 실재하면(리퍼/재시도 스케줄러가 채운 것처럼) GET 응답에 그대로
    실려야 한다. 스키마에서 5필드를 도로 빼면(mutation-kill) 이 테스트가 정확히 이 자리서
    RED(값은 DB에 있는데 응답이 조용히 안 보여줌)."""
    from app.main import app
    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            seeded = await _seed(s)
        await _setup_app(app, Session, seeded["caller_id"], seeded["org_id"])
        client = _client_for(app)
        try:
            create_resp = await client.post(
                "/api/v2/agent-runs",
                json={"agent_id": str(seeded["agent_id"]), "project_id": str(seeded["project_id"]), "status": "failed"},
            )
            assert create_resp.status_code == 201, create_resp.text
            run_id = create_resp.json()["id"]
            deployment_id = uuid.uuid4()
            next_retry_at = datetime.now(timezone.utc) + timedelta(minutes=5)

            await _set_retry_fields_directly(Session, run_id, deployment_id, next_retry_at)

            get_resp = await client.get(f"/api/v2/agent-runs/{run_id}")
            assert get_resp.status_code == 200, get_resp.text
            body = get_resp.json()

            assert body["deployment_id"] == str(deployment_id), f"deployment_id 안 실림(회귀): {body}"
            assert body["failure_disposition"] == "retry_scheduled", f"failure_disposition 안 실림(회귀): {body}"
            assert body["retry_count"] == 2, f"retry_count 안 실림(회귀): {body}"
            assert body["max_retries"] == 3, f"max_retries 안 실림(회귀): {body}"
            assert body["next_retry_at"] is not None, f"next_retry_at 안 실림(회귀): {body}"
        finally:
            await client.aclose()
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()


@pytest.mark.anyio
async def test_additive_fields_default_when_unset_no_fiction():
    """리퍼/재시도가 아직 안 건드린 run — nullable 셋(deployment_id·failure_disposition·
    next_retry_at)은 null, NOT NULL 기본값 둘(retry_count=0·max_retries=3)은 그 기본값
    그대로여야 한다(지어내지 않는다 — 응답 스키마가 값을 임의로 바꾸지 않음을 pin)."""
    from app.main import app
    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            seeded = await _seed(s)
        await _setup_app(app, Session, seeded["caller_id"], seeded["org_id"])
        client = _client_for(app)
        try:
            create_resp = await client.post(
                "/api/v2/agent-runs",
                json={"agent_id": str(seeded["agent_id"]), "project_id": str(seeded["project_id"])},
            )
            assert create_resp.status_code == 201, create_resp.text
            body = create_resp.json()

            assert body["deployment_id"] is None
            assert body["failure_disposition"] is None
            assert body["retry_count"] == 0
            assert body["max_retries"] == 3
            assert body["next_retry_at"] is None
        finally:
            await client.aclose()
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()
