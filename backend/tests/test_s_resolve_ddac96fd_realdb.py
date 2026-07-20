"""story ddac96fd(S-resolve) 게이트: GET /api/v2/resolve?workspace=&project= 실 PG 왕복.

단일 합성 resolve + 옛 slug(rename 이력) redirect + 접근권 404(비노출) + 캐시 헤더(ETag/304)."""
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


def _client_for(app):
    from httpx import AsyncClient, ASGITransport
    return AsyncClient(transport=ASGITransport(app=app), base_url="http://test")


async def _seed(session):
    """org(멤버=caller) + project(caller 접근권 有) + project_b(caller 접근권 無)."""
    from app.models.organization import Organization
    from app.models.project import OrgMember, Project
    from app.models.project_access import ProjectAccess
    from app.models.user import User

    org = Organization(id=uuid.uuid4(), name="Org", slug=f"org-{uuid.uuid4().hex[:8]}")
    session.add(org)
    await session.commit()

    project_a = Project(id=uuid.uuid4(), org_id=org.id, name="A", slug=f"proj-a-{uuid.uuid4().hex[:6]}")
    project_b = Project(id=uuid.uuid4(), org_id=org.id, name="B", slug=f"proj-b-{uuid.uuid4().hex[:6]}")
    session.add_all([project_a, project_b])
    await session.commit()

    user_id = uuid.uuid4()
    session.add(User(id=user_id, email=f"caller-{user_id.hex[:8]}@test.com", hashed_password="x"))
    await session.commit()
    om = OrgMember(id=uuid.uuid4(), org_id=org.id, user_id=user_id, role="member")
    session.add(om)
    await session.commit()
    session.add(ProjectAccess(
        id=uuid.uuid4(), project_id=project_a.id, org_member_id=om.id, permission="granted",
    ))
    await session.commit()

    return {
        "org_id": org.id, "org_slug": org.slug, "user_id": user_id,
        "project_a_id": project_a.id, "project_a_slug": project_a.slug,
        "project_b_id": project_b.id, "project_b_slug": project_b.slug,
    }


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
async def test_resolve_workspace_and_project_realdb():
    from app.main import app

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            seeded = await _seed(s)

        await _setup_app(app, Session, seeded["user_id"], seeded["org_id"])
        client = _client_for(app)
        try:
            resp = await client.get(
                f"/api/v2/resolve?workspace={seeded['org_slug']}&project={seeded['project_a_slug']}"
            )
            assert resp.status_code == 200, resp.text
            body = resp.json()
            assert body["org_id"] == str(seeded["org_id"])
            assert body["project_id"] == str(seeded["project_a_id"])
            assert "redirect" not in body
            assert resp.headers["cache-control"] == "private, max-age=60"
            assert resp.headers.get("etag")
        finally:
            await client.aclose()
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()


@pytest.mark.anyio
async def test_resolve_workspace_only_realdb():
    from app.main import app

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            seeded = await _seed(s)

        await _setup_app(app, Session, seeded["user_id"], seeded["org_id"])
        client = _client_for(app)
        try:
            resp = await client.get(f"/api/v2/resolve?workspace={seeded['org_slug']}")
            assert resp.status_code == 200, resp.text
            body = resp.json()
            assert body["org_id"] == str(seeded["org_id"])
            assert "project_id" not in body
        finally:
            await client.aclose()
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()


@pytest.mark.anyio
async def test_etag_if_none_match_returns_304_realdb():
    from app.main import app

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            seeded = await _seed(s)

        await _setup_app(app, Session, seeded["user_id"], seeded["org_id"])
        client = _client_for(app)
        try:
            resp1 = await client.get(f"/api/v2/resolve?workspace={seeded['org_slug']}")
            etag = resp1.headers["etag"]
            resp2 = await client.get(
                f"/api/v2/resolve?workspace={seeded['org_slug']}",
                headers={"If-None-Match": etag},
            )
            assert resp2.status_code == 304
        finally:
            await client.aclose()
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()


@pytest.mark.anyio
async def test_old_workspace_slug_redirects_via_history_realdb():
    """rename 이력(A→B→C) — 옛 slug 'A' 요청 시 단일-hop lookup으로 최종 C까지 정확히 해소."""
    from app.main import app
    from app.models.entity_slug_history import EntitySlugHistory
    from datetime import datetime, timedelta, timezone

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            seeded = await _seed(s)
            org_id = seeded["org_id"]
            old_slug_a = f"old-a-{uuid.uuid4().hex[:6]}"
            mid_slug_b = f"old-b-{uuid.uuid4().hex[:6]}"
            now = datetime.now(timezone.utc)
            s.add_all([
                EntitySlugHistory(
                    id=uuid.uuid4(), org_id=org_id, entity_type="organization", entity_id=org_id,
                    old_slug=old_slug_a, new_slug=mid_slug_b, changed_at=now - timedelta(days=2),
                ),
                EntitySlugHistory(
                    id=uuid.uuid4(), org_id=org_id, entity_type="organization", entity_id=org_id,
                    old_slug=mid_slug_b, new_slug=seeded["org_slug"], changed_at=now - timedelta(days=1),
                ),
            ])
            await s.commit()

        await _setup_app(app, Session, seeded["user_id"], seeded["org_id"])
        client = _client_for(app)
        try:
            resp = await client.get(f"/api/v2/resolve?workspace={old_slug_a}")
            assert resp.status_code == 200, resp.text
            body = resp.json()
            assert body["org_id"] == str(seeded["org_id"])
            assert body["org_slug"] == seeded["org_slug"]
            assert body["redirect"]["workspace"] == seeded["org_slug"]
        finally:
            await client.aclose()
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()


@pytest.mark.anyio
async def test_old_project_slug_redirects_via_history_realdb():
    from app.main import app
    from app.models.entity_slug_history import EntitySlugHistory

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            seeded = await _seed(s)
            old_proj_slug = f"old-proj-{uuid.uuid4().hex[:6]}"
            s.add(EntitySlugHistory(
                id=uuid.uuid4(), org_id=seeded["org_id"], entity_type="project",
                entity_id=seeded["project_a_id"], old_slug=old_proj_slug,
                new_slug=seeded["project_a_slug"],
            ))
            await s.commit()

        await _setup_app(app, Session, seeded["user_id"], seeded["org_id"])
        client = _client_for(app)
        try:
            resp = await client.get(
                f"/api/v2/resolve?workspace={seeded['org_slug']}&project={old_proj_slug}"
            )
            assert resp.status_code == 200, resp.text
            body = resp.json()
            assert body["project_id"] == str(seeded["project_a_id"])
            assert body["redirect"]["project"] == seeded["project_a_slug"]
        finally:
            await client.aclose()
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()


@pytest.mark.anyio
async def test_non_member_gets_404_not_403_realdb():
    """까심: org 비멤버는 404(존재 비노출) — 다른 org 기존 판단과 정합."""
    from app.main import app
    from app.models.user import User

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            seeded = await _seed(s)
            stranger_id = uuid.uuid4()
            s.add(User(id=stranger_id, email=f"stranger-{stranger_id.hex[:8]}@test.com", hashed_password="x"))
            await s.commit()

        await _setup_app(app, Session, stranger_id, seeded["org_id"])
        client = _client_for(app)
        try:
            resp = await client.get(f"/api/v2/resolve?workspace={seeded['org_slug']}")
            assert resp.status_code == 404, resp.text
        finally:
            await client.aclose()
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()


@pytest.mark.anyio
async def test_no_project_access_gets_404_realdb():
    """까심: org 멤버지만 project_b 접근권 없음 — 404(IDOR 차단)."""
    from app.main import app

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            seeded = await _seed(s)

        await _setup_app(app, Session, seeded["user_id"], seeded["org_id"])
        client = _client_for(app)
        try:
            resp = await client.get(
                f"/api/v2/resolve?workspace={seeded['org_slug']}&project={seeded['project_b_slug']}"
            )
            assert resp.status_code == 404, resp.text
        finally:
            await client.aclose()
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()
