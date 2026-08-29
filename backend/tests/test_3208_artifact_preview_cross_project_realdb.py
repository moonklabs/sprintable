"""story #3208 — 아티팩트 직URL/채팅 임베드가 «현재» 프로젝트로만 스코프된 GET /{id}
(SEC-S8, project_id 필수 필터)에 막혀, 다른 프로젝트를 보던 중 링크를 열면 대상이 실재해도
404였다. `GET /api/v2/visual-artifacts/preview`(신설, `docs.py::get_doc_preview`와 동형)가
org 스코프로 먼저 찾고 `has_project_access`로 실제 접근권을 검증해 위치정보만 낸다.

realdb 필수 — has_project_access SSOT(team_member∪grant∪owner/admin) 실측 + slug 컬럼 실조회.
"""
from __future__ import annotations

import os
import uuid

import pytest

_REAL_DB_URL = os.getenv("PARITY_TEST_DATABASE_URL") or os.getenv("ALEMBIC_DATABASE_URL")

pytestmark = [
    pytest.mark.skipif(not _REAL_DB_URL, reason="통합 테스트는 실 PG(PARITY/ALEMBIC_DATABASE_URL) 필요"),
    pytest.mark.anyio,
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
    """org(slug 有) + project_a(grant O)·project_b(grant X, slug 有) + artifact_b(project_b)."""
    from app.models.organization import Organization
    from app.models.project import Project
    from app.models.visual_artifact import ArtifactVersion, VisualArtifact
    from sqlalchemy import text

    org = Organization(id=uuid.uuid4(), name="Org", slug=f"org-{uuid.uuid4().hex[:8]}")
    session.add(org)
    await session.commit()

    project_a = Project(id=uuid.uuid4(), org_id=org.id, name="A", slug=f"proj-a-{uuid.uuid4().hex[:8]}")
    project_b = Project(id=uuid.uuid4(), org_id=org.id, name="B", slug=f"proj-b-{uuid.uuid4().hex[:8]}")
    session.add_all([project_a, project_b])
    await session.commit()

    user_id = uuid.uuid4()
    await session.execute(text(
        "INSERT INTO users (id,email,hashed_password,display_name,is_active,email_verified,"
        "login_fail_count,totp_enabled,totp_fail_count) VALUES "
        f"('{user_id}','u-{uuid.uuid4().hex[:8]}@test.local','x','U',true,true,0,false,0)"
    ))
    om_id = uuid.uuid4()
    await session.execute(text(
        f"INSERT INTO org_members (id,org_id,user_id,role) VALUES ('{om_id}','{org.id}','{user_id}','member')"
    ))
    # user는 project_a에만 grant(project_b는 접근 없음 — cross-project 축).
    await session.execute(text(
        f"INSERT INTO project_access (id,project_id,org_member_id,permission) "
        f"VALUES (gen_random_uuid(),'{project_a.id}','{om_id}','granted')"
    ))
    await session.commit()

    creator_id = uuid.uuid4()
    artifact_b = VisualArtifact(
        id=uuid.uuid4(), org_id=org.id, project_id=project_b.id, title="Artifact B",
        source="created", latest_version_number=1, created_by=creator_id,
    )
    session.add(artifact_b)
    await session.commit()
    version_b = ArtifactVersion(id=uuid.uuid4(), artifact_id=artifact_b.id, version_number=1, created_by=creator_id)
    session.add(version_b)
    await session.commit()

    return {
        "org_id": org.id, "org_slug": org.slug,
        "project_a_id": project_a.id, "project_b_id": project_b.id, "project_b_slug": project_b.slug,
        "artifact_b_id": artifact_b.id, "user_id": user_id,
    }


def _client_for(app):
    from httpx import AsyncClient, ASGITransport
    return AsyncClient(transport=ASGITransport(app=app), base_url="http://test")


async def _setup_app(app, Session, user_id, org_id, project_id):
    from app.dependencies.auth import AuthContext, get_current_user
    from tests.conftest import override_db_and_read

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
            claims={"app_metadata": {"org_id": str(org_id), "project_id": str(project_id)}},
        )

    # story #2451(§6 Phase3) — get_db만 걸고 get_read_db를 잊는 회귀 방지, 공용 헬퍼 경유.
    override_db_and_read(app, _db)
    app.dependency_overrides[get_current_user] = _auth


@pytest.mark.anyio
async def test_preview_cross_project_returns_real_location_when_access_granted():
    """근본 재현: user는 «현재» project_a를 보고 있지만 artifact_b(project_b 소속)를 열람할
    권한은 있다(team_member) — preview가 GET /{id}처럼 project_id 불일치로 막지 않고
    실제 위치(project_id·org_slug·project_slug)를 내야 한다."""
    from app.main import app

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            seeded = await _seed(s)
        # user에게 project_b에도 team_member 권한을 준다(접근 있음 축).
        async with Session() as s:
            from sqlalchemy import text
            await s.execute(text(
                f"INSERT INTO project_access (id,project_id,org_member_id,permission) "
                f"SELECT gen_random_uuid(),'{seeded['project_b_id']}',id,'granted' "
                f"FROM org_members WHERE org_id='{seeded['org_id']}' AND user_id='{seeded['user_id']}'"
            ))
            await s.commit()

        await _setup_app(app, Session, seeded["user_id"], seeded["org_id"], seeded["project_a_id"])
        client = _client_for(app)
        try:
            resp = await client.get(
                "/api/v2/visual-artifacts/preview", params={"id": str(seeded["artifact_b_id"])},
            )
            assert resp.status_code == 200
            data = resp.json()["data"]
            assert data["project_id"] == str(seeded["project_b_id"])
            assert data["org_slug"] == seeded["org_slug"]
            assert data["project_slug"] == seeded["project_b_slug"]
        finally:
            await client.aclose()
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()


@pytest.mark.anyio
async def test_preview_no_access_to_owning_project_returns_404():
    """대상은 실재하지만(org 안) 그 project에 접근권이 없으면 여전히 404 — SEC-S8과 동형
    가드(project_id 필터를 없앤 게 아니라 순서를 바꾼 것뿐임을 확認)."""
    from app.main import app

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            seeded = await _seed(s)

        await _setup_app(app, Session, seeded["user_id"], seeded["org_id"], seeded["project_a_id"])
        client = _client_for(app)
        try:
            resp = await client.get(
                "/api/v2/visual-artifacts/preview", params={"id": str(seeded["artifact_b_id"])},
            )
            assert resp.status_code == 404
            assert resp.json()["error"]["code"] == "NOT_FOUND"
        finally:
            await client.aclose()
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()


@pytest.mark.anyio
async def test_preview_nonexistent_artifact_returns_404():
    from app.main import app

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            seeded = await _seed(s)

        await _setup_app(app, Session, seeded["user_id"], seeded["org_id"], seeded["project_a_id"])
        client = _client_for(app)
        try:
            resp = await client.get(
                "/api/v2/visual-artifacts/preview", params={"id": str(uuid.uuid4())},
            )
            assert resp.status_code == 404
        finally:
            await client.aclose()
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()
