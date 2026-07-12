"""E-SECURITY 스캐너 라운드2(#2~4·story 5285888c) — hypotheses update/unlink/archive PATH_ID
project-scope IDOR, 실 PG.

갭: PATCH /{hypothesis_id}(update)·DELETE /{hypothesis_id}/links(unlink)·DELETE /{hypothesis_id}
(archive) 세 라우트 모두 hyp를 id로 잡되 service가 org-scope get만 해 resolved-resource
(Hypothesis.project_id) has_project_access 검증이 0이었다(service-layer 갭). caller는 접근권 없는
same-org 다른 project의 hyp를 덮어쓰기/링크해제/아카이브할 수 있었다. fix: 라우터 공통 가드
_assert_hypothesis_project_access(hyp 조회→hyp.project_id has_project_access·404·존재 비노출).
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


_METRIC = {"metric": "signups", "source": "db", "target": 100, "direction": "increase"}


def _hyp(org_id, project_id, statement):
    from app.models.hypothesis import Hypothesis
    return Hypothesis(
        id=uuid.uuid4(), org_id=org_id, project_id=project_id, owner_member_id=uuid.uuid4(),
        statement=statement, metric_definition=_METRIC,
        measure_after=datetime(2026, 6, 1, tzinfo=timezone.utc), status="proposed",
    )


async def _seed(session):
    """org(project_a[caller grant]·project_b[무접근]) + hyp_a(project_a)·hyp_b(project_b)."""
    from app.models.organization import Organization
    from app.models.project import OrgMember, Project
    from app.models.project_access import ProjectAccess
    from app.models.user import User

    org = Organization(id=uuid.uuid4(), name="Org", slug=f"org-{uuid.uuid4().hex[:8]}")
    session.add(org)
    await session.commit()
    project_a = Project(id=uuid.uuid4(), org_id=org.id, name="Project A")
    project_b = Project(id=uuid.uuid4(), org_id=org.id, name="Project B")
    session.add_all([project_a, project_b])
    await session.commit()
    hyp_a = _hyp(org.id, project_a.id, "Hyp A")
    hyp_b = _hyp(org.id, project_b.id, "Hyp B orig")
    session.add_all([hyp_a, hyp_b])
    await session.commit()

    caller_id = uuid.uuid4()
    caller = User(id=caller_id, email=f"caller-{caller_id.hex[:8]}@test.com", hashed_password="x")
    session.add(caller)
    await session.commit()
    caller_om = OrgMember(id=uuid.uuid4(), org_id=org.id, user_id=caller_id, role="member")
    session.add(caller_om)
    await session.commit()
    session.add(ProjectAccess(
        id=uuid.uuid4(), project_id=project_a.id, org_member_id=caller_om.id, permission="granted", role="member",
    ))
    await session.commit()

    return {"org_id": org.id, "hyp_a_id": hyp_a.id, "hyp_b_id": hyp_b.id, "caller_id": caller_id}


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
        return AuthContext(user_id=str(user_id), email="caller@test", claims={"app_metadata": {"org_id": str(org_id)}})

    async def _org():
        return org_id

    app.dependency_overrides[get_db] = _db
    app.dependency_overrides[get_current_user] = _auth
    app.dependency_overrides[get_verified_org_id] = _org


async def _hyp_col(Session, hyp_id, col):
    from sqlalchemy import text
    async with Session() as s:
        return (await s.execute(
            text(f"SELECT {col} FROM hypotheses WHERE id = :i"), {"i": hyp_id}
        )).scalar_one()


@pytest.mark.anyio
async def test_update_hypothesis_own_project_200():
    """회귀0: project_a grant caller가 project_a hyp statement 수정 → 200 + 반영."""
    from app.main import app
    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            seeded = await _seed(s)
        await _setup_app(app, Session, seeded["caller_id"], seeded["org_id"])
        client = _client_for(app)
        try:
            resp = await client.patch(
                f"/api/v2/hypotheses/{seeded['hyp_a_id']}", json={"statement": "Hyp A updated"},
            )
            assert resp.status_code == 200, resp.text
            assert await _hyp_col(Session, seeded["hyp_a_id"], "statement") == "Hyp A updated"
        finally:
            await client.aclose()
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()


@pytest.mark.anyio
async def test_update_hypothesis_cross_project_blocked_404_not_modified():
    """봉인: 접근권 없는 project_b hyp를 id로 수정 시도 → 404 + **미변경 직조회**(statement 원본 유지)."""
    from app.main import app
    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            seeded = await _seed(s)
        await _setup_app(app, Session, seeded["caller_id"], seeded["org_id"])
        client = _client_for(app)
        try:
            resp = await client.patch(
                f"/api/v2/hypotheses/{seeded['hyp_b_id']}", json={"statement": "HACKED"},
            )
            assert resp.status_code == 404, resp.text
            assert await _hyp_col(Session, seeded["hyp_b_id"], "statement") == "Hyp B orig", "cross-project hyp 변경됨(IDOR)"
        finally:
            await client.aclose()
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()


@pytest.mark.anyio
async def test_archive_hypothesis_cross_project_blocked_404_not_archived():
    """봉인: 접근권 없는 project_b hyp archive 시도 → 404 + **미아카이브 직조회**(status='proposed' 유지)."""
    from app.main import app
    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            seeded = await _seed(s)
        await _setup_app(app, Session, seeded["caller_id"], seeded["org_id"])
        client = _client_for(app)
        try:
            resp = await client.delete(f"/api/v2/hypotheses/{seeded['hyp_b_id']}")
            assert resp.status_code == 404, resp.text
            assert await _hyp_col(Session, seeded["hyp_b_id"], "status") == "proposed", "cross-project hyp 아카이브됨(IDOR)"
        finally:
            await client.aclose()
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()


@pytest.mark.anyio
async def test_unlink_hypothesis_cross_project_blocked_404():
    """봉인: 접근권 없는 project_b hyp 링크해제 시도 → 404(가드가 service 前 차단)."""
    from app.main import app
    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            seeded = await _seed(s)
        await _setup_app(app, Session, seeded["caller_id"], seeded["org_id"])
        client = _client_for(app)
        try:
            resp = await client.request(
                "DELETE", f"/api/v2/hypotheses/{seeded['hyp_b_id']}/links",
                json={"epic_ids": [], "story_ids": [], "unlink_sprint": True},
            )
            assert resp.status_code == 404, resp.text
        finally:
            await client.aclose()
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()
