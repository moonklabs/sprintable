"""E-SECURITY SEC-S8(story 83ea3d6a) M: workflow-line-config `_require_draft_author`의
OR-fallback target-org 미검증 봉쇄 실증.

`role in ("owner","admin") or is_org_owner_or_admin(caller org)` fallback이 project_id의
실제 소속 org를 검증하지 않아 — caller org(A)의 owner/admin이 **타 org(B) 소속 project_id**를
넘기면 get_project_role이 None을 반환해도 OR-fallback(자기 org A의 owner/admin 자격)으로
통과했다. 즉 Org A owner가 Org B 프로젝트에 대한 workflow-line draft를 생성할 수 있었다."""
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
    """org A(owner human) + org B(project, 대상) + org A project(정당 project-admin 휴먼용)."""
    from app.models.organization import Organization
    from app.models.project import OrgMember, Project
    from app.models.project_access import ProjectAccess
    from app.models.user import User

    org_a = Organization(id=uuid.uuid4(), name="Org A", slug=f"org-a-{uuid.uuid4().hex[:8]}")
    org_b = Organization(id=uuid.uuid4(), name="Org B", slug=f"org-b-{uuid.uuid4().hex[:8]}")
    session.add_all([org_a, org_b])
    await session.commit()

    project_a = Project(id=uuid.uuid4(), org_id=org_a.id, name="Org A Project")
    project_b = Project(id=uuid.uuid4(), org_id=org_b.id, name="Org B Project")
    session.add_all([project_a, project_b])
    await session.commit()

    # Org A owner — 정당하게 project_a에 대해선 draft author 자격(org owner floor), project_b(타org)는 아님.
    owner_user_id = uuid.uuid4()
    owner_user = User(id=owner_user_id, email=f"owner-{owner_user_id.hex[:8]}@test.com", hashed_password="x")
    session.add(owner_user)
    await session.commit()
    owner_om = OrgMember(id=uuid.uuid4(), org_id=org_a.id, user_id=owner_user_id, role="owner")
    session.add(owner_om)
    await session.commit()

    # Org A 소속·project_a에 명시 project admin grant(org owner/admin 아닌 순수 project 권한 경로).
    proj_admin_user_id = uuid.uuid4()
    proj_admin_user = User(
        id=proj_admin_user_id, email=f"padmin-{proj_admin_user_id.hex[:8]}@test.com", hashed_password="x",
    )
    session.add(proj_admin_user)
    await session.commit()
    proj_admin_om = OrgMember(id=uuid.uuid4(), org_id=org_a.id, user_id=proj_admin_user_id, role="member")
    session.add(proj_admin_om)
    await session.commit()
    session.add(ProjectAccess(
        id=uuid.uuid4(), project_id=project_a.id, org_member_id=proj_admin_om.id,
        permission="granted", role="admin",
    ))
    await session.commit()

    return {
        "org_a_id": org_a.id, "org_b_id": org_b.id,
        "project_a_id": project_a.id, "project_b_id": project_b.id,
        "owner_user_id": owner_user_id, "proj_admin_user_id": proj_admin_user_id,
    }


def _client_for(app):
    from httpx import AsyncClient, ASGITransport
    return AsyncClient(transport=ASGITransport(app=app), base_url="http://test")


async def _setup_app(app, Session, user_id, org_id):
    from app.dependencies.auth import AuthContext, get_current_user
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

    app.dependency_overrides[get_db] = _db
    app.dependency_overrides[get_current_user] = _auth


@pytest.mark.anyio
async def test_org_owner_cannot_create_draft_for_other_org_project():
    """M 재현: Org A owner가 Org B project_id로 draft 생성 시도 → 404(기존엔 OR-fallback으로 201)."""
    from app.main import app

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            seeded = await _seed(s)

        await _setup_app(app, Session, seeded["owner_user_id"], seeded["org_a_id"])
        client = _client_for(app)
        try:
            resp = await client.post(
                "/api/v2/workflow-line-config/versions",
                json={"entity_type": "story", "config": {}, "project_id": str(seeded["project_b_id"])},
            )
            assert resp.status_code == 404, resp.text
        finally:
            await client.aclose()
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()


@pytest.mark.anyio
async def test_org_owner_can_still_create_draft_for_own_org_project():
    """회귀 0: Org A owner는 여전히 자기 org의 project(project_a)에 draft 생성 가능(org owner floor 유지)."""
    from app.main import app

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            seeded = await _seed(s)

        await _setup_app(app, Session, seeded["owner_user_id"], seeded["org_a_id"])
        client = _client_for(app)
        try:
            resp = await client.post(
                "/api/v2/workflow-line-config/versions",
                json={"entity_type": "story", "config": {}, "project_id": str(seeded["project_a_id"])},
            )
            assert resp.status_code == 201, resp.text
        finally:
            await client.aclose()
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()


@pytest.mark.anyio
async def test_project_admin_without_org_role_can_still_create_draft():
    """회귀 0: org owner/admin이 아니어도 project_access(role=admin) grant만으로 draft 생성 가능
    (project 권한 경로 무변경 확認)."""
    from app.main import app

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            seeded = await _seed(s)

        await _setup_app(app, Session, seeded["proj_admin_user_id"], seeded["org_a_id"])
        client = _client_for(app)
        try:
            resp = await client.post(
                "/api/v2/workflow-line-config/versions",
                json={"entity_type": "story", "config": {}, "project_id": str(seeded["project_a_id"])},
            )
            assert resp.status_code == 201, resp.text
        finally:
            await client.aclose()
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()
