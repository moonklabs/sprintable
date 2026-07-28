"""#2245(형제 비대칭) — GET /versions/{version_id}(workflow_line_config.py get_version)
project-scope IDOR, 실 PG.

갭: _load_version이 org-scope만이라 project 접근권(draft-author) 검증이 없었다(#2238 2차 스윕
적출). 바로 아래 형제 update_draft_version(PATCH)은 로드 後 _require_draft_author를 이미 부른다.
처방: 형제와 동일한 _require_draft_author(동일 403 관례) 재사용.
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
    """org(project_a[caller=project admin grant]·project_b[무접근]) + version_a(project_a)·
    version_b(project_b, caller 접근권 없음)."""
    from app.models.organization import Organization
    from app.models.project import OrgMember, Project
    from app.models.project_access import ProjectAccess
    from app.models.user import User
    from app.models.workflow_line import WorkflowLineDefinitionVersion

    org = Organization(id=uuid.uuid4(), name="Org", slug=f"org-{uuid.uuid4().hex[:8]}")
    session.add(org)
    await session.commit()
    project_a = Project(id=uuid.uuid4(), org_id=org.id, name="Project A")
    project_b = Project(id=uuid.uuid4(), org_id=org.id, name="Project B")
    session.add_all([project_a, project_b])
    await session.commit()

    version_a = WorkflowLineDefinitionVersion(
        id=uuid.uuid4(), org_id=org.id, project_id=project_a.id, entity_type="story", version=1,
        status="draft", config={}, config_hash="a", lint_status="not_run", lint_errors=[],
        created_by_member_id=uuid.uuid4(),
    )
    version_b = WorkflowLineDefinitionVersion(
        id=uuid.uuid4(), org_id=org.id, project_id=project_b.id, entity_type="story", version=1,
        status="draft", config={"secret": "B"}, config_hash="b", lint_status="not_run", lint_errors=[],
        created_by_member_id=uuid.uuid4(),
    )
    session.add_all([version_a, version_b])
    await session.commit()

    caller_id = uuid.uuid4()
    caller = User(id=caller_id, email=f"caller-{caller_id.hex[:8]}@test.com", hashed_password="x")
    session.add(caller)
    await session.commit()
    # org role=member(org owner/admin 아님) — project_a 에만 명시 admin grant.
    caller_om = OrgMember(id=uuid.uuid4(), org_id=org.id, user_id=caller_id, role="member")
    session.add(caller_om)
    await session.commit()
    session.add(ProjectAccess(
        id=uuid.uuid4(), project_id=project_a.id, org_member_id=caller_om.id, permission="granted", role="admin",
    ))
    await session.commit()

    return {
        "org_id": org.id, "version_a_id": version_a.id, "version_b_id": version_b.id,
        "caller_id": caller_id,
    }


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
        return AuthContext(
            user_id=str(user_id), email="caller@test",
            claims={"app_metadata": {"org_id": str(org_id)}},
        )

    async def _org():
        return org_id

    app.dependency_overrides[get_db] = _db
    app.dependency_overrides[get_current_user] = _auth
    app.dependency_overrides[get_verified_org_id] = _org


@pytest.mark.anyio
async def test_get_version_own_project_admin_200():
    """회귀 0: project admin grant 있는 caller는 여전히 200."""
    from app.main import app

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            seeded = await _seed(s)

        await _setup_app(app, Session, seeded["caller_id"], seeded["org_id"])
        client = _client_for(app)
        try:
            resp = await client.get(f"/api/v2/workflow-line-config/versions/{seeded['version_a_id']}")
            assert resp.status_code == 200, resp.text
        finally:
            await client.aclose()
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()


@pytest.mark.anyio
async def test_get_version_no_project_access_blocked_403():
    """본체: 같은 org 이지만 해당 project 의 draft-author 자격 없는 caller는 거부
    (기존엔 org-scope만이라 200)."""
    from app.main import app

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            seeded = await _seed(s)

        await _setup_app(app, Session, seeded["caller_id"], seeded["org_id"])
        client = _client_for(app)
        try:
            resp = await client.get(f"/api/v2/workflow-line-config/versions/{seeded['version_b_id']}")
            assert resp.status_code == 403, resp.text
        finally:
            await client.aclose()
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()
