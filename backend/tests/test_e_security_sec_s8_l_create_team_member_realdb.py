"""E-SECURITY SEC-S8(story 83ea3d6a) L: create_team_member 무인가 신원 발급 봉쇄 실증.

권한체크가 `if actor.type=="agent"`에 갇혀 있어 휴먼 caller(또는 actor 미해소)면 인가가
통째로 스킵됐음 — 아무 권한 없는 멤버가 임의 project_id(타 org 포함)로 role=admin 에이전트를
찍어낼 수 있었음(sk_live_ API키 자동발급까지 이어짐)."""
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
    """org A(project) + org B(project, 대상) + 무권한 휴먼(org A 소속·프로젝트 grant 0)
    + org A admin 휴먼(정당 시나리오 회귀용)."""
    from app.models.organization import Organization
    from app.models.project import OrgMember, Project
    from app.models.user import User

    org_a = Organization(id=uuid.uuid4(), name="Org A", slug=f"org-a-{uuid.uuid4().hex[:8]}")
    org_b = Organization(id=uuid.uuid4(), name="Org B", slug=f"org-b-{uuid.uuid4().hex[:8]}")
    session.add_all([org_a, org_b])
    await session.commit()

    project_a = Project(id=uuid.uuid4(), org_id=org_a.id, name="Org A Project")
    project_b = Project(id=uuid.uuid4(), org_id=org_b.id, name="Org B Project")
    session.add_all([project_a, project_b])
    await session.commit()

    # 무권한 휴먼 — org A 소속(member role)이나 project_a에 어떤 grant도 없음.
    no_priv_user_id = uuid.uuid4()
    no_priv_user = User(id=no_priv_user_id, email=f"nopriv-{no_priv_user_id.hex[:8]}@test.com", hashed_password="x")
    session.add(no_priv_user)
    await session.commit()
    no_priv_om = OrgMember(id=uuid.uuid4(), org_id=org_a.id, user_id=no_priv_user_id, role="member")
    session.add(no_priv_om)
    await session.commit()

    # 정당 admin 휴먼 — org A owner.
    admin_user_id = uuid.uuid4()
    admin_user = User(id=admin_user_id, email=f"admin-{admin_user_id.hex[:8]}@test.com", hashed_password="x")
    session.add(admin_user)
    await session.commit()
    admin_om = OrgMember(id=uuid.uuid4(), org_id=org_a.id, user_id=admin_user_id, role="owner")
    session.add(admin_om)
    await session.commit()

    return {
        "org_a_id": org_a.id, "org_b_id": org_b.id,
        "project_a_id": project_a.id, "project_b_id": project_b.id,
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
async def test_no_privilege_human_cannot_create_admin_agent():
    """L 재현: 무권한 휴먼(org A member·project grant 0)이 project_a에 role=admin agent 생성 시도
    → 403(기존엔 human=인가 전면스킵으로 201)."""
    from app.main import app

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            seeded = await _seed(s)

        await _setup_app(app, Session, seeded["no_priv_user_id"], seeded["org_a_id"])
        client = _client_for(app)
        try:
            resp = await client.post(
                "/api/v2/team-members",
                json={
                    "project_id": str(seeded["project_a_id"]), "org_id": str(seeded["org_a_id"]),
                    "type": "agent", "name": "RogueAdmin", "role": "admin",
                },
            )
            assert resp.status_code == 403, resp.text
        finally:
            await client.aclose()
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()


@pytest.mark.anyio
async def test_no_privilege_human_cannot_create_agent_in_other_org_project():
    """L 재현(target-org 축): 무권한 휴먼이 Org B project_id로 agent 생성 시도 → 차단(404, org 불일치)."""
    from app.main import app

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            seeded = await _seed(s)

        await _setup_app(app, Session, seeded["no_priv_user_id"], seeded["org_a_id"])
        client = _client_for(app)
        try:
            resp = await client.post(
                "/api/v2/team-members",
                json={
                    "project_id": str(seeded["project_b_id"]), "org_id": str(seeded["org_a_id"]),
                    "type": "agent", "name": "CrossOrgAgent",
                },
            )
            assert resp.status_code in (403, 404), resp.text
        finally:
            await client.aclose()
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()


@pytest.mark.anyio
async def test_org_admin_human_can_still_create_agent():
    """회귀 0: 정당한 org admin/owner 휴먼은 여전히 에이전트 생성 가능(정당 시나리오 안 깨짐)."""
    from app.main import app

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            seeded = await _seed(s)

        await _setup_app(app, Session, seeded["admin_user_id"], seeded["org_a_id"])
        client = _client_for(app)
        try:
            resp = await client.post(
                "/api/v2/team-members",
                json={
                    "project_id": str(seeded["project_a_id"]), "org_id": str(seeded["org_a_id"]),
                    "type": "agent", "name": "LegitBot",
                },
            )
            assert resp.status_code == 201, resp.text
        finally:
            await client.aclose()
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()
