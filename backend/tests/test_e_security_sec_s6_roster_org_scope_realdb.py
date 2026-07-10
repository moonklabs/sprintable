"""E-SECURITY SEC-S6(story 54248174·까심 QA 부수발견 D): GET /api/v2/members?project_id= 스코프
검증 — 타 org project_id로 그 org 멤버 로스터가 그대로 열거되던 cross-org IDOR 봉쇄 실증.

동시에 `assert_target_in_caller_org` 공통 가드가 D(project)뿐 아니라 E(agent_personas의
agent_id) 형태의 target에도 그대로 재사용 가능한지 순수 함수 레벨로 실측(SEC-S7 crux 재사용
근거)."""
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


async def _seed_two_orgs(session):
    """Org A caller(휴먼)·Org B project + 멤버(휴먼1+에이전트1) — D 재현용."""
    from app.models.member import Member
    from app.models.organization import Organization
    from app.models.project import OrgMember, Project
    from app.models.project_access import ProjectAccess
    from app.models.user import User

    org_a = Organization(id=uuid.uuid4(), name="Org A", slug=f"org-a-{uuid.uuid4().hex[:8]}")
    org_b = Organization(id=uuid.uuid4(), name="Org B", slug=f"org-b-{uuid.uuid4().hex[:8]}")
    session.add_all([org_a, org_b])
    await session.commit()

    caller_user_id = uuid.uuid4()
    caller_user = User(id=caller_user_id, email=f"caller-{caller_user_id.hex[:8]}@test.com", hashed_password="x")
    session.add(caller_user)
    await session.commit()
    caller_om = OrgMember(id=uuid.uuid4(), org_id=org_a.id, user_id=caller_user_id, role="member")
    session.add(caller_om)
    await session.commit()

    project_b = Project(id=uuid.uuid4(), org_id=org_b.id, name="Org B Project")
    session.add(project_b)
    await session.commit()

    target_user_id = uuid.uuid4()
    target_user = User(id=target_user_id, email=f"target-{target_user_id.hex[:8]}@test.com", hashed_password="x")
    session.add(target_user)
    await session.commit()
    target_om = OrgMember(id=uuid.uuid4(), org_id=org_b.id, user_id=target_user_id, role="admin")
    session.add(target_om)
    await session.commit()

    agent_b = Member(id=uuid.uuid4(), org_id=org_b.id, type="agent", name="Org B Agent", is_active=True)
    session.add(agent_b)
    await session.commit()
    session.add(ProjectAccess(
        id=uuid.uuid4(), project_id=project_b.id, member_id=agent_b.id, permission="granted", role="member",
    ))
    await session.commit()

    return {
        "org_a_id": org_a.id, "org_b_id": org_b.id,
        "caller_user_id": caller_user_id, "project_b_id": project_b.id,
        "target_admin_name": target_user.email,
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
async def test_cross_org_project_id_roster_blocked():
    """까심 D 재현: Org A caller가 Org B project_id로 조회 시도 → 404(로스터 비노출)."""
    from app.main import app

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            seeded = await _seed_two_orgs(s)

        await _setup_app(app, Session, seeded["caller_user_id"], seeded["org_a_id"])
        client = _client_for(app)
        try:
            resp = await client.get(f"/api/v2/members?project_id={seeded['project_b_id']}")
            assert resp.status_code == 404, resp.text
            assert "Org B Agent" not in resp.text
            assert seeded["target_admin_name"] not in resp.text
        finally:
            await client.aclose()
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()


@pytest.mark.anyio
async def test_same_org_project_id_roster_still_free():
    """회귀 0: Org B caller가 자기 org의 project_id로 조회하면 정상 로스터(휴먼+에이전트) 반환."""
    from app.main import app

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            seeded = await _seed_two_orgs(s)

        await _setup_app(app, Session, seeded["caller_user_id"], seeded["org_b_id"])
        client = _client_for(app)
        try:
            resp = await client.get(f"/api/v2/members?project_id={seeded['project_b_id']}")
            assert resp.status_code == 200, resp.text
            members = resp.json()
            names = {m["name"] for m in members}
            assert seeded["target_admin_name"] in names
            assert "Org B Agent" in names
        finally:
            await client.aclose()
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()


@pytest.mark.anyio
async def test_nonexistent_project_id_also_404():
    """존재하지 않는 project_id도 동일하게 404(타org·미존재 구분 안 함 — 존재 비노출)."""
    from app.main import app

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            seeded = await _seed_two_orgs(s)

        await _setup_app(app, Session, seeded["caller_user_id"], seeded["org_a_id"])
        client = _client_for(app)
        try:
            resp = await client.get(f"/api/v2/members?project_id={uuid.uuid4()}")
            assert resp.status_code == 404, resp.text
        finally:
            await client.aclose()
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()


def test_assert_target_in_caller_org_reusable_for_agent_target():
    """SEC-S7 crux 실측: 공통 가드가 project 형태뿐 아니라 agent(persona target) 형태의
    target_org_id 비교에도 그대로 재사용 가능 — 순수 함수라 실 agent row 없이도 로직 검증 충분."""
    from fastapi import HTTPException
    from app.services.project_auth import assert_target_in_caller_org

    caller_org = uuid.uuid4()
    same_org_agent_org = caller_org
    other_org_agent_org = uuid.uuid4()

    # same-org agent target → 통과(예외 없음)
    assert_target_in_caller_org(caller_org, same_org_agent_org, not_found_detail="Agent not found")

    # cross-org agent target → 404
    with pytest.raises(HTTPException) as exc_info:
        assert_target_in_caller_org(caller_org, other_org_agent_org, not_found_detail="Agent not found")
    assert exc_info.value.status_code == 404

    # 존재하지 않는 agent(org 조회 자체가 None) → 동일 404
    with pytest.raises(HTTPException) as exc_info2:
        assert_target_in_caller_org(caller_org, None, not_found_detail="Agent not found")
    assert exc_info2.value.status_code == 404
