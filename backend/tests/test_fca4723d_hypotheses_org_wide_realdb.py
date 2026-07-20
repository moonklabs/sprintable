"""story fca4723d(C1) 게이트: 접근권 sabotage 실증 — project_id 생략(org-wide) 조회 시
비접근 project의 가설이 실제로 노출되지 않는지 realdb로 확인(mock has_project_access가
아니라 진짜 project_access/team_members 데이터 기반)."""
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
    """org + project_a(caller 접근권 有) + project_b(caller 접근권 無) + 각 프로젝트에 가설 1개씩."""
    from app.models.organization import Organization
    from app.models.project import OrgMember, Project
    from app.models.project_access import ProjectAccess
    from app.models.hypothesis import Hypothesis
    from app.models.user import User
    from datetime import datetime, timezone

    org = Organization(id=uuid.uuid4(), name="Org", slug=f"org-{uuid.uuid4().hex[:8]}")
    session.add(org)
    await session.commit()

    project_a = Project(id=uuid.uuid4(), org_id=org.id, name="A")
    project_b = Project(id=uuid.uuid4(), org_id=org.id, name="B")
    session.add_all([project_a, project_b])
    await session.commit()

    user_id = uuid.uuid4()
    session.add(User(id=user_id, email=f"caller-{user_id.hex[:8]}@test.com", hashed_password="x"))
    await session.commit()
    om = OrgMember(id=uuid.uuid4(), org_id=org.id, user_id=user_id, role="member")
    session.add(om)
    await session.commit()
    # caller는 project_a에만 grant — project_b는 접근권 없음(IDOR 축).
    session.add(ProjectAccess(
        id=uuid.uuid4(), project_id=project_a.id, org_member_id=om.id, permission="granted",
    ))
    await session.commit()

    now = datetime(2026, 7, 15, tzinfo=timezone.utc)
    hyp_a = Hypothesis(
        id=uuid.uuid4(), org_id=org.id, project_id=project_a.id, owner_member_id=om.id,
        statement="접근 가능 project의 가설", metric_definition={"metric": "x", "source": "manual", "target": 1, "direction": "up"},
        measure_after=now, status="proposed",
    )
    hyp_b = Hypothesis(
        id=uuid.uuid4(), org_id=org.id, project_id=project_b.id, owner_member_id=om.id,
        statement="비접근 project의 가설 — 노출되면 안 됨", metric_definition={"metric": "y", "source": "manual", "target": 1, "direction": "up"},
        measure_after=now, status="proposed",
    )
    session.add_all([hyp_a, hyp_b])
    await session.commit()

    return {
        "org_id": org.id, "user_id": user_id,
        "project_a_id": project_a.id, "project_b_id": project_b.id,
        "hyp_a_id": hyp_a.id, "hyp_b_id": hyp_b.id,
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
async def test_org_wide_hypotheses_hides_inaccessible_project_realdb():
    """까심 sabotage 케이스: project_id 생략 시 비접근 project(B)의 가설이 응답에 없어야 한다."""
    from app.main import app

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            seeded = await _seed(s)

        await _setup_app(app, Session, seeded["user_id"], seeded["org_id"])
        client = _client_for(app)
        try:
            resp = await client.get("/api/v2/hypotheses")
            assert resp.status_code == 200, resp.text
            body = resp.json()
            ids = {h["id"] for h in body}
            assert str(seeded["hyp_a_id"]) in ids, "접근 가능 project(A)의 가설은 보여야 함"
            assert str(seeded["hyp_b_id"]) not in ids, "비접근 project(B)의 가설이 노출됨 — sabotage 실패"
        finally:
            await client.aclose()
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()


@pytest.mark.anyio
async def test_project_scoped_query_still_requires_access_realdb():
    """회귀 0: project_id 명시 시(project_b) 기존 접근권 검증 그대로 — 403."""
    from app.main import app

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            seeded = await _seed(s)

        await _setup_app(app, Session, seeded["user_id"], seeded["org_id"])
        client = _client_for(app)
        try:
            resp = await client.get(f"/api/v2/hypotheses?project_id={seeded['project_b_id']}")
            assert resp.status_code == 403, resp.text
        finally:
            await client.aclose()
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()
