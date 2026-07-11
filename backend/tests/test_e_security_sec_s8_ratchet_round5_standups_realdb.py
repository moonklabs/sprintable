"""E-SECURITY SEC HIGH baseline paydown round5 — #2050 ratchet _KNOWN_DEBT_ALLOWLIST HIGH
7건 중 standups.list_standups + standups.list_standup_history 상환(둘 다 동형 패턴).

근본: top-level project_id 필터(지정 시)에 caller의 project 접근권 검증이 없어 same-org
cross-project 스탠드업 자유텍스트(yesterday/today/blockers)가 노출됐다. project_id는
쿼리파라미터 자체가 조회 대상이라 직접 has_project_access(session, user_id, project_id,
org_id) 검증으로 봉인."""
from __future__ import annotations

import os
import uuid
from datetime import date

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
    """org(project_a, project_b) + standup_b(project_b 링크, blockers="TOP SECRET BLOCKER") +
    human_a(project_a에만 명시 grant, project_b 접근권 없음)."""
    from app.models.organization import Organization
    from app.models.project import OrgMember, Project
    from app.models.project_access import ProjectAccess
    from app.models.standup import StandupEntry, StandupEntryProject
    from app.models.user import User

    org = Organization(id=uuid.uuid4(), name="Org", slug=f"org-{uuid.uuid4().hex[:8]}")
    session.add(org)
    await session.commit()

    project_a = Project(id=uuid.uuid4(), org_id=org.id, name="Project A")
    project_b = Project(id=uuid.uuid4(), org_id=org.id, name="Project B")
    session.add_all([project_a, project_b])
    await session.commit()

    standup_b = StandupEntry(
        id=uuid.uuid4(), org_id=org.id, project_id=project_b.id,
        author_id=uuid.uuid4(), date=date(2026, 7, 11),
        done="secret work", plan="secret plan", blockers="TOP SECRET BLOCKER",
    )
    session.add(standup_b)
    await session.commit()
    session.add(StandupEntryProject(id=uuid.uuid4(), org_id=org.id, entry_id=standup_b.id, project_id=project_b.id))
    await session.commit()

    human_user_id = uuid.uuid4()
    human_user = User(id=human_user_id, email=f"human-{human_user_id.hex[:8]}@test.com", hashed_password="x")
    session.add(human_user)
    await session.commit()
    human_om = OrgMember(id=uuid.uuid4(), org_id=org.id, user_id=human_user_id, role="member")
    session.add(human_om)
    await session.commit()
    # project_a에만 명시 grant — project_b 접근권 없음(org owner/admin도 아님).
    session.add(ProjectAccess(
        id=uuid.uuid4(), project_id=project_a.id, org_member_id=human_om.id, permission="granted", role="member",
    ))
    await session.commit()

    return {
        "org_id": org.id, "project_a_id": project_a.id, "project_b_id": project_b.id,
        "human_user_id": human_user_id,
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
        return AuthContext(user_id=str(user_id), email="caller@test", claims={"app_metadata": {"org_id": str(org_id)}})

    app.dependency_overrides[get_db] = _db
    app.dependency_overrides[get_current_user] = _auth


@pytest.mark.anyio
async def test_project_a_human_can_list_own_project_standups_empty():
    """회귀 0: project_a grant 보유 휴먼은 project_a 스탠드업 정상 조회(200, 결과 0건이어도 통과)."""
    from app.main import app

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            seeded = await _seed(s)

        await _setup_app(app, Session, seeded["human_user_id"], seeded["org_id"])
        client = _client_for(app)
        try:
            resp = await client.get(f"/api/v2/standups?project_id={seeded['project_a_id']}")
            assert resp.status_code == 200, resp.text
            assert resp.json() == []
        finally:
            await client.aclose()
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()


@pytest.mark.anyio
async def test_no_grant_human_cannot_list_other_project_standups():
    """봉인 실증(list): project_a에만 grant된 휴먼이 project_b 스탠드업(blockers="TOP SECRET
    BLOCKER")을 project_id override로 조회 시도 → 404(기존엔 접근권 검증 0이라 200+유출)."""
    from app.main import app

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            seeded = await _seed(s)

        await _setup_app(app, Session, seeded["human_user_id"], seeded["org_id"])
        client = _client_for(app)
        try:
            resp = await client.get(f"/api/v2/standups?project_id={seeded['project_b_id']}")
            assert resp.status_code == 404, resp.text
        finally:
            await client.aclose()
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()


@pytest.mark.anyio
async def test_no_grant_human_cannot_list_other_project_standup_history():
    """봉인 실증(history): 동일 벡터를 /standups/history에서도 차단."""
    from app.main import app

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            seeded = await _seed(s)

        await _setup_app(app, Session, seeded["human_user_id"], seeded["org_id"])
        client = _client_for(app)
        try:
            resp = await client.get(f"/api/v2/standups/history?project_id={seeded['project_b_id']}")
            assert resp.status_code == 404, resp.text
        finally:
            await client.aclose()
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()


@pytest.mark.anyio
async def test_list_standups_without_project_id_still_works_unchanged():
    """회귀 0: project_id 미지정(org-level) 호출은 무변경 — 여전히 200(has_project_access
    미적용 경로, list_standups만 project_id optional)."""
    from app.main import app

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            seeded = await _seed(s)

        await _setup_app(app, Session, seeded["human_user_id"], seeded["org_id"])
        client = _client_for(app)
        try:
            resp = await client.get("/api/v2/standups")
            assert resp.status_code == 200, resp.text
        finally:
            await client.aclose()
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()


@pytest.mark.anyio
async def test_nonexistent_project_id_returns_404_not_leak():
    """엣지: 존재하지 않는 project_id도 404(존재여부 자체를 흘리지 않음, history 엔드포인트)."""
    from app.main import app

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            seeded = await _seed(s)

        await _setup_app(app, Session, seeded["human_user_id"], seeded["org_id"])
        client = _client_for(app)
        try:
            resp = await client.get(f"/api/v2/standups/history?project_id={uuid.uuid4()}")
            assert resp.status_code == 404, resp.text
        finally:
            await client.aclose()
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()
