"""E-SECURITY SEC-S8(story 83ea3d6a) L 자매 갭: create_org_agent(POST /api/v2/agents)도
`if actor.type=="agent"`에 갇혀 휴먼 caller(또는 actor 미해소)면 인가가 통째로 스킵되던
동일 패턴. create_team_member 수정 중 자체 발견(fix-on-sight) — org owner/admin 게이트로
휴먼 분기를 봉쇄."""
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
    """org A(project) + 무권한 휴먼(org A member·admin 아님) + org A admin 휴먼(정당 시나리오)."""
    from app.models.organization import Organization
    from app.models.project import OrgMember, Project
    from app.models.user import User

    org_a = Organization(id=uuid.uuid4(), name="Org A", slug=f"org-a-{uuid.uuid4().hex[:8]}")
    session.add(org_a)
    await session.commit()

    project_a = Project(id=uuid.uuid4(), org_id=org_a.id, name="Org A Project")
    session.add(project_a)
    await session.commit()

    no_priv_user_id = uuid.uuid4()
    no_priv_user = User(id=no_priv_user_id, email=f"nopriv-{no_priv_user_id.hex[:8]}@test.com", hashed_password="x")
    session.add(no_priv_user)
    await session.commit()
    no_priv_om = OrgMember(id=uuid.uuid4(), org_id=org_a.id, user_id=no_priv_user_id, role="member")
    session.add(no_priv_om)
    await session.commit()

    admin_user_id = uuid.uuid4()
    admin_user = User(id=admin_user_id, email=f"admin-{admin_user_id.hex[:8]}@test.com", hashed_password="x")
    session.add(admin_user)
    await session.commit()
    admin_om = OrgMember(id=uuid.uuid4(), org_id=org_a.id, user_id=admin_user_id, role="owner")
    session.add(admin_om)
    await session.commit()

    return {
        "org_a_id": org_a.id, "project_a_id": project_a.id,
        "no_priv_user_id": no_priv_user_id, "admin_user_id": admin_user_id,
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
async def test_no_privilege_human_cannot_create_org_agent():
    """L 자매 갭 재현: 무권한 휴먼(org A member, owner/admin 아님)이 org agent 생성 시도
    → 403(기존엔 human=인가 전면스킵으로 201 + api_key 자동발급)."""
    from app.main import app

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            seeded = await _seed(s)

        await _setup_app(app, Session, seeded["no_priv_user_id"], seeded["org_a_id"])
        client = _client_for(app)
        try:
            resp = await client.post(
                "/api/v2/agents",
                json={
                    "name": "RogueOrgAgent", "scope_mode": "projects",
                    "project_ids": [str(seeded["project_a_id"])],
                },
            )
            assert resp.status_code == 403, resp.text
        finally:
            await client.aclose()
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()


@pytest.mark.anyio
async def test_org_admin_human_can_still_create_org_agent():
    """회귀 0: 정당한 org admin/owner 휴먼은 여전히 org agent 생성 가능(정당 시나리오 안 깨짐)."""
    from app.main import app

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            seeded = await _seed(s)

        await _setup_app(app, Session, seeded["admin_user_id"], seeded["org_a_id"])
        client = _client_for(app)
        try:
            resp = await client.post(
                "/api/v2/agents",
                json={
                    "name": "LegitOrgBot", "scope_mode": "projects",
                    "project_ids": [str(seeded["project_a_id"])],
                },
            )
            assert resp.status_code == 201, resp.text
        finally:
            await client.aclose()
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()
