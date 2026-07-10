"""E-SECURITY SEC-S8(story 83ea3d6a) J+K: cross-org 토큰 탈취 체인 봉쇄 실증.

J(근본): create_project_access 휴먼분기(org_member_id)가 target-org 미검증 — Org A owner가
Org B org_member_id로 Org A project에 cross-org grant 행을 만들 수 있었음.
K(방어심화): switch-project의 has_project_access가 org_id 없이 호출돼, J로 생긴 (또는 다른
경로의) cross-org grant 행이 있으면 target org의 정식 access+refresh 토큰이 발급됐음.
"""
from __future__ import annotations

import os
import uuid
from datetime import datetime, timezone

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


async def _seed_two_orgs(session):
    """Org A(owner) + Org A project + Org B(target org_member) — J 재현용."""
    from app.models.organization import Organization
    from app.models.project import OrgMember, Project
    from app.models.user import User

    org_a = Organization(id=uuid.uuid4(), name="Org A", slug=f"org-a-{uuid.uuid4().hex[:8]}")
    org_b = Organization(id=uuid.uuid4(), name="Org B", slug=f"org-b-{uuid.uuid4().hex[:8]}")
    session.add_all([org_a, org_b])
    await session.commit()

    project_a = Project(id=uuid.uuid4(), org_id=org_a.id, name="Org A Project")
    session.add(project_a)
    await session.commit()

    owner_user_id = uuid.uuid4()
    owner_user = User(id=owner_user_id, email=f"owner-{owner_user_id.hex[:8]}@test.com", hashed_password="x")
    session.add(owner_user)
    await session.commit()
    owner_om = OrgMember(id=uuid.uuid4(), org_id=org_a.id, user_id=owner_user_id, role="owner")
    session.add(owner_om)
    await session.commit()

    target_user_id = uuid.uuid4()
    target_user = User(id=target_user_id, email=f"target-{target_user_id.hex[:8]}@test.com", hashed_password="x")
    session.add(target_user)
    await session.commit()
    target_om_b = OrgMember(id=uuid.uuid4(), org_id=org_b.id, user_id=target_user_id, role="member")
    session.add(target_om_b)
    await session.commit()

    same_org_user_id = uuid.uuid4()
    same_org_user = User(id=same_org_user_id, email=f"member-{same_org_user_id.hex[:8]}@test.com", hashed_password="x")
    session.add(same_org_user)
    await session.commit()
    same_org_om_a = OrgMember(id=uuid.uuid4(), org_id=org_a.id, user_id=same_org_user_id, role="member")
    session.add(same_org_om_a)
    await session.commit()

    return {
        "org_a_id": org_a.id, "org_b_id": org_b.id, "project_a_id": project_a.id,
        "owner_user_id": owner_user_id, "target_om_b_id": target_om_b.id,
        "same_org_om_a_id": same_org_om_a.id,
        "target_user_id": target_user_id,
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
async def test_j_cross_org_project_access_grant_blocked():
    """J 재현: Org A owner가 Org B org_member_id로 Org A project에 grant 시도 → 400."""
    from app.main import app

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            seeded = await _seed_two_orgs(s)

        await _setup_app(app, Session, seeded["owner_user_id"], seeded["org_a_id"])
        client = _client_for(app)
        try:
            resp = await client.post(
                f"/api/v2/projects/{seeded['project_a_id']}/access",
                json={"org_member_id": str(seeded["target_om_b_id"]), "permission": "granted"},
            )
            assert resp.status_code == 400, resp.text
        finally:
            await client.aclose()

        async with Session() as s:
            from sqlalchemy import select
            from app.models.project_access import ProjectAccess
            rows = (await s.execute(
                select(ProjectAccess).where(
                    ProjectAccess.project_id == seeded["project_a_id"],
                    ProjectAccess.org_member_id == seeded["target_om_b_id"],
                )
            )).scalars().all()
            assert len(rows) == 0, "cross-org grant 행이 생성되면 안 됨"
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()


@pytest.mark.anyio
async def test_j_same_org_project_access_grant_still_free():
    """회귀 0: 같은 org org_member_id는 정상 201."""
    from app.main import app

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            seeded = await _seed_two_orgs(s)

        await _setup_app(app, Session, seeded["owner_user_id"], seeded["org_a_id"])
        client = _client_for(app)
        try:
            resp = await client.post(
                f"/api/v2/projects/{seeded['project_a_id']}/access",
                json={"org_member_id": str(seeded["same_org_om_a_id"]), "permission": "granted"},
            )
            assert resp.status_code == 201, resp.text
        finally:
            await client.aclose()
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()


@pytest.mark.anyio
async def test_k_switch_project_blocked_despite_rogue_cross_org_grant():
    """K 재현: J 봉쇄와 무관하게(예: 레거시로 이미 존재하는 rogue 행을 직접 시뮬레이션) —
    Org B 유저가 Org A project_id로 switch-project 시도 시, 자신의 세션 org(Org B)로 스코프된
    has_project_access가 org_id 불일치로 403을 내야 한다(K fix 전이면 무필터로 200+토큰 발급)."""
    from app.main import app
    from app.models.project_access import ProjectAccess

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            seeded = await _seed_two_orgs(s)
            # rogue cross-org grant 직접 시뮬레이션(J가 막아도 레거시/다른 경로로 이미 존재할 수
            # 있는 상태를 가정 — K는 이 상태에서도 방어해야 하는 defense-in-depth).
            s.add(ProjectAccess(
                id=uuid.uuid4(), project_id=seeded["project_a_id"],
                org_member_id=seeded["target_om_b_id"], permission="granted",
            ))
            await s.commit()

        await _setup_app(app, Session, seeded["target_user_id"], seeded["org_b_id"])
        client = _client_for(app)
        try:
            resp = await client.post(
                "/api/v2/auth/switch-project",
                json={"project_id": str(seeded["project_a_id"])},
            )
            assert resp.status_code == 403, resp.text
        finally:
            await client.aclose()
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()


@pytest.mark.anyio
async def test_k_switch_project_same_org_still_free():
    """회귀 0: 정상 same-org project로 switch하면 200 + 새 토큰."""
    from app.main import app
    from app.models.project import Project
    from app.models.project_access import ProjectAccess

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            seeded = await _seed_two_orgs(s)
            grant = ProjectAccess(
                id=uuid.uuid4(), project_id=seeded["project_a_id"],
                org_member_id=seeded["same_org_om_a_id"], permission="granted",
            )
            s.add(grant)
            await s.commit()

        await _setup_app(app, Session, seeded["owner_user_id"], seeded["org_a_id"])
        client = _client_for(app)
        try:
            # owner는 org owner라 has_project_access org-wide floor로 통과.
            resp = await client.post(
                "/api/v2/auth/switch-project",
                json={"project_id": str(seeded["project_a_id"])},
            )
            assert resp.status_code == 200, resp.text
            body = resp.json()["data"]
            assert "access_token" in body
        finally:
            await client.aclose()
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()
