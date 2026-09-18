"""story #3719 — `agent_runs.last_error_code` 생성 시점 계약 누락, 실 PG.

3707과 반대편 갭: `UpdateAgentRun`엔 `last_error_code`가 이미 있어 PATCH(exclude_unset
패스스루)는 원래도 됐지만, `CreateAgentRun`엔 필드 자체가 없어 POST(emit_event 경로)로는
처음부터 채울 수 없었다. `CreateAgentRun`에 필드 추가 + 라우터가 named-arg로 repo에 명시
전달하는 수정을 write→read 왕복으로 pin(#3707 realdb 테스트와 동형 골격 재사용).
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


async def _fetch_run_last_error_code_db(Session, run_id):
    from sqlalchemy import text
    async with Session() as s:
        row = (await s.execute(
            text("SELECT last_error_code FROM agent_runs WHERE id = :i"), {"i": run_id},
        )).one()
        return row[0]


@pytest.mark.anyio
async def test_create_with_last_error_code_persists_and_is_readable_write_then_read_roundtrip():
    """핵심 — POST(status=failed+last_error_code) → DB에 실제로 닿는지 → GET 응답에 실리는지.
    CreateAgentRun에서 last_error_code를 도로 빼면(mutation-kill) 이 테스트가 정확히 이 자리서
    RED(POST 바디가 조용히 버려짐)."""
    from app.main import app
    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            seeded = await _seed(s)
        await _setup_app(app, Session, seeded["caller_id"], seeded["org_id"])
        client = _client_for(app)
        try:
            code = "E_SMOKE_3719"
            resp = await client.post(
                "/api/v2/agent-runs",
                json={
                    "agent_id": str(seeded["agent_id"]),
                    "project_id": str(seeded["project_id"]),
                    "status": "failed",
                    "error_message": "[스모크·3719] 의도된 실패 표본",
                    "last_error_code": code,
                },
            )
            assert resp.status_code == 201, resp.text
            body = resp.json()
            assert body["last_error_code"] == code, f"POST 응답에 last_error_code가 안 실림(회귀): {body}"

            run_id = body["id"]
            db_value = await _fetch_run_last_error_code_db(Session, run_id)
            assert db_value == code, f"DB엔 안 닿음(응답만 echo, 회귀): {db_value!r}"

            get_resp = await client.get(f"/api/v2/agent-runs/{run_id}")
            assert get_resp.status_code == 200, get_resp.text
            assert get_resp.json()["last_error_code"] == code
        finally:
            await client.aclose()
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()


@pytest.mark.anyio
async def test_update_last_error_code_persists_and_readable_no_regression():
    """UpdateAgentRun은 원래도 있었으나(exclude_unset 패스스루) 이번 수정이 그 경로를 깨지
    않았는지 회귀 감시."""
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
            run_id = create_resp.json()["id"]

            code = "E_SMOKE_3719_PATCH"
            patch_resp = await client.patch(
                f"/api/v2/agent-runs/{run_id}",
                json={"status": "failed", "last_error_code": code},
            )
            assert patch_resp.status_code == 200, patch_resp.text
            assert patch_resp.json()["last_error_code"] == code, "PATCH 응답에 last_error_code가 안 실림(회귀)"

            db_value = await _fetch_run_last_error_code_db(Session, run_id)
            assert db_value == code, f"DB엔 안 닿음(회귀): {db_value!r}"
        finally:
            await client.aclose()
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()
