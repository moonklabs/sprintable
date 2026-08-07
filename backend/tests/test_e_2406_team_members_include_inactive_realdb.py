"""story #2406 AC2(critical) real-DB — GET /api/v2/team-members?type=agent&include_inactive=true
가 비활성 에이전트를 실제로 포함해 반환하는지 실 organizations/members/project_access 위에서
검증. PO 지시(2026-08-07) "검산" — include_inactive=true/false(또는 생략) 두 번 호출해 반환
건수가 실제로 다른지 확認한다(미르코 라이브 실측 16→15의 축소판).

DB env(PARITY_TEST_DATABASE_URL 또는 ALEMBIC_DATABASE_URL) 없으면 skip."""
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
    """org + human(caller) + agent_active(project grant) + agent_inactive(project grant,
    is_active=False) — 둘 다 org-level type=agent 조회 대상."""
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

    agent_active = Member(id=uuid.uuid4(), org_id=org.id, type="agent", name="Agent Active", is_active=True)
    agent_inactive = Member(id=uuid.uuid4(), org_id=org.id, type="agent", name="Agent Inactive", is_active=False)
    session.add_all([agent_active, agent_inactive])
    await session.commit()
    session.add_all([
        ProjectAccess(id=uuid.uuid4(), project_id=project.id, member_id=agent_active.id, permission="granted", role="member"),
        ProjectAccess(id=uuid.uuid4(), project_id=project.id, member_id=agent_inactive.id, permission="granted", role="member"),
    ])
    await session.commit()

    human_user_id = uuid.uuid4()
    human_user = User(id=human_user_id, email=f"human-{human_user_id.hex[:8]}@test.com", hashed_password="x")
    session.add(human_user)
    await session.commit()
    session.add(OrgMember(id=uuid.uuid4(), org_id=org.id, user_id=human_user_id, role="owner"))
    await session.commit()

    return {
        "org_id": org.id, "human_user_id": human_user_id,
        "agent_active_id": agent_active.id, "agent_inactive_id": agent_inactive.id,
    }


def _client_for(app):
    from httpx import AsyncClient, ASGITransport
    return AsyncClient(transport=ASGITransport(app=app), base_url="http://test")


async def _setup_app(app, Session, user_id, org_id):
    from app.dependencies.auth import AuthContext, get_current_user

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

    from tests.conftest import override_db_and_read
    override_db_and_read(app, _db)
    app.dependency_overrides[get_current_user] = _auth


@pytest.mark.anyio
async def test_include_inactive_true_returns_both_false_or_omitted_returns_only_active_realdb():
    """검산(PO 지시) — 같은 org에 include_inactive=true/생략 두 번 호출, 반환 건수가
    실제로 다른지(1건 vs 2건) 확認. 미르코 라이브 실측(16→15)의 축소판 재현."""
    from app.main import app

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            seeded = await _seed(s)

        await _setup_app(app, Session, seeded["human_user_id"], seeded["org_id"])
        client = _client_for(app)
        try:
            # ① include_inactive 생략(기본) — 활성만.
            resp_default = await client.get("/api/v2/team-members?type=agent")
            assert resp_default.status_code == 200, resp_default.text
            ids_default = {item["id"] for item in resp_default.json()}
            assert ids_default == {str(seeded["agent_active_id"])}

            # ② include_inactive=false 명시 — ①과 동일해야(회귀 0).
            resp_false = await client.get("/api/v2/team-members?type=agent&include_inactive=false")
            assert resp_false.status_code == 200, resp_false.text
            ids_false = {item["id"] for item in resp_false.json()}
            assert ids_false == ids_default

            # ③ include_inactive=true — 비활성 포함 둘 다(fix 핵심).
            resp_true = await client.get("/api/v2/team-members?type=agent&include_inactive=true")
            assert resp_true.status_code == 200, resp_true.text
            ids_true = {item["id"] for item in resp_true.json()}
            assert ids_true == {str(seeded["agent_active_id"]), str(seeded["agent_inactive_id"])}

            # 검산 핵심 — 두 값이 실제로 다르다(1건 vs 2건, PO "검산" 지시 그대로).
            assert len(ids_true) > len(ids_default)
        finally:
            await client.aclose()
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()


@pytest.mark.anyio
async def test_typo_param_ignored_confirms_root_cause_realdb():
    """PO 진단 판별 축(실DB) — 오타(`include_inactivee`)는 FastAPI가 조용히 무시해
    200은 나오지만 효과가 없다(=기본 활성만). 이게 원래 결함의 근본원인이었다는 진단을
    실측으로 고정."""
    from app.main import app

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            seeded = await _seed(s)

        await _setup_app(app, Session, seeded["human_user_id"], seeded["org_id"])
        client = _client_for(app)
        try:
            resp = await client.get("/api/v2/team-members?type=agent&include_inactivee=true")
            assert resp.status_code == 200
            ids = {item["id"] for item in resp.json()}
            assert ids == {str(seeded["agent_active_id"])}  # 오타라 무시됨 — 활성만
        finally:
            await client.aclose()
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()
