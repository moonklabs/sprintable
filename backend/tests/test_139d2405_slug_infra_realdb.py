"""story 139d2405(S-slug-infra): workspace(organization)/project slug 인프라 — 생성·유일성·
예약어·rename 이력·resolution API. 유나 doc org-1st-class-surface-ia-design-b §2a/§2e.
"""
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


async def _seed_human(session, org_id, project_id=None, *, role="member", grant_project=False):
    from app.models.project import OrgMember
    from app.models.project_access import ProjectAccess
    from app.models.user import User

    user_id = uuid.uuid4()
    user = User(
        id=user_id, email=f"human-{user_id.hex[:8]}@test.com", hashed_password="x",
        email_verified=True,
    )
    session.add(user)
    await session.commit()
    om = OrgMember(id=uuid.uuid4(), org_id=org_id, user_id=user_id, role=role)
    session.add(om)
    await session.commit()
    if grant_project and project_id is not None:
        session.add(ProjectAccess(
            id=uuid.uuid4(), project_id=project_id, org_member_id=om.id, permission="granted",
        ))
        await session.commit()
    return user_id, om.id


async def _seed_org(session, *, slug=None):
    from app.models.organization import Organization

    org = Organization(
        id=uuid.uuid4(), name="Slug Test Org", slug=slug or f"org-{uuid.uuid4().hex[:8]}",
    )
    session.add(org)
    await session.commit()
    return org


async def _seed_project(session, org_id, *, name="Roadmap", slug=None):
    from app.models.project import Project

    project = Project(
        id=uuid.uuid4(), org_id=org_id, name=name, slug=slug or f"proj-{uuid.uuid4().hex[:8]}",
    )
    session.add(project)
    await session.commit()
    return project


def _client_for(app):
    from httpx import AsyncClient, ASGITransport
    return AsyncClient(transport=ASGITransport(app=app), base_url="http://test")


async def _setup_app(app, Session, user_id, org_id=None):
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

    claims = {"app_metadata": {}}
    if org_id is not None:
        claims["app_metadata"]["org_id"] = str(org_id)

    async def _auth():
        return AuthContext(user_id=str(user_id), email="caller@test", claims=claims)

    app.dependency_overrides[get_db] = _db
    app.dependency_overrides[get_current_user] = _auth


# ─── entity_slug.py 유닛 ────────────────────────────────────────────────────

def test_is_valid_slug_format():
    from app.services.entity_slug import is_valid_slug_format

    assert is_valid_slug_format("moonklabs")
    assert is_valid_slug_format("moonk-labs-2")
    assert not is_valid_slug_format("")
    assert not is_valid_slug_format("MoonkLabs")  # 대문자 금지
    assert not is_valid_slug_format("-moonklabs")  # 앞 하이픈 금지
    assert not is_valid_slug_format("moonklabs-")  # 뒤 하이픈 금지
    assert not is_valid_slug_format("moonk_labs")  # 언더스코어 금지
    assert not is_valid_slug_format("문서")  # 유니코드(클라이언트 명시 slug는 ASCII만)


def test_reserved_workspace_slugs_exact_denylist():
    from app.services.entity_slug import RESERVED_WORKSPACE_SLUGS

    for w in ("api", "login", "logout", "onboarding", "settings", "organization", "o", "admin",
              "help", "static", "_next", "404"):
        assert w in RESERVED_WORKSPACE_SLUGS
    assert "moonklabs" not in RESERVED_WORKSPACE_SLUGS


def test_reserved_workspace_slugs_covers_fe_flat_resource_routes():
    """미르코 S-route-project 그라운딩 발견(2026-07-15) 후속 봉합 — apps/web/src/app 실측
    최상위 라우트명 전체가 denylist에 있어야 /{ws}/... 마이그 이후 오배정이 없다."""
    from app.services.entity_slug import RESERVED_WORKSPACE_SLUGS

    for w in (
        "activity", "artifacts", "board", "channel", "chats", "docs", "epics", "glance",
        "inbox", "loops", "meetings", "mockups", "org-briefing", "retro", "rewards",
        "sprints", "standup", "storage",
        "auth", "dashboard", "forgot-password", "internal-dogfood", "invite", "mfa",
        "privacy", "register", "reset-password", "share", "terms", "verify-email",
    ):
        assert w in RESERVED_WORKSPACE_SLUGS, f"{w} 라우트명이 denylist에 없음"


@pytest.mark.anyio
async def test_resolve_unique_workspace_slug_skips_reserved_and_collision():
    from app.services.entity_slug import resolve_unique_workspace_slug

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org = await _seed_org(s, slug="taken")
            # 예약어는 base 그대로 못 나옴 — suffix로 우회.
            reserved_result = await resolve_unique_workspace_slug(s, "admin")
            assert reserved_result != "admin"
            assert reserved_result not in ("api", "login")
            # 충돌은 -n suffix.
            taken_result = await resolve_unique_workspace_slug(s, "taken")
            assert taken_result == "taken-2"
    finally:
        await engine.dispose()


@pytest.mark.anyio
async def test_resolve_unique_project_slug_scoped_per_org():
    from app.services.entity_slug import resolve_unique_project_slug

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org_a = await _seed_org(s)
            org_b = await _seed_org(s)
            await _seed_project(s, org_a.id, slug="roadmap")
            # 같은 slug라도 다른 org면 충돌 아님.
            result_b = await resolve_unique_project_slug(s, org_b.id, "roadmap")
            assert result_b == "roadmap"
            # 같은 org면 충돌 → suffix.
            result_a = await resolve_unique_project_slug(s, org_a.id, "roadmap")
            assert result_a == "roadmap-2"
    finally:
        await engine.dispose()


# ─── organizations 라우터 ───────────────────────────────────────────────────

@pytest.mark.anyio
async def test_create_organization_reserved_slug_400():
    from app.main import app

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            from app.models.user import User
            user_id = uuid.uuid4()
            s.add(User(id=user_id, email=f"u-{user_id.hex[:8]}@test.com", hashed_password="x",
                       email_verified=True))
            await s.commit()

        await _setup_app(app, Session, user_id)
        client = _client_for(app)
        try:
            resp = await client.post("/api/v2/organizations", json={"name": "Admin Org", "slug": "admin"})
            assert resp.status_code == 400, resp.text
        finally:
            await client.aclose()
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()


@pytest.mark.anyio
async def test_create_organization_invalid_format_400():
    from app.main import app

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            from app.models.user import User
            user_id = uuid.uuid4()
            s.add(User(id=user_id, email=f"u-{user_id.hex[:8]}@test.com", hashed_password="x",
                       email_verified=True))
            await s.commit()

        await _setup_app(app, Session, user_id)
        client = _client_for(app)
        try:
            resp = await client.post(
                "/api/v2/organizations", json={"name": "Bad Org", "slug": "Not_Valid!"}
            )
            assert resp.status_code == 400, resp.text
        finally:
            await client.aclose()
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()


@pytest.mark.anyio
async def test_create_organization_valid_slug_201():
    from app.main import app

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            from app.models.user import User
            user_id = uuid.uuid4()
            s.add(User(id=user_id, email=f"u-{user_id.hex[:8]}@test.com", hashed_password="x",
                       email_verified=True))
            await s.commit()

        await _setup_app(app, Session, user_id)
        client = _client_for(app)
        try:
            resp = await client.post(
                "/api/v2/organizations", json={"name": "Moonk Labs", "slug": "moonklabs-e2e"}
            )
            assert resp.status_code == 201, resp.text
            assert resp.json()["slug"] == "moonklabs-e2e"
        finally:
            await client.aclose()
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()


@pytest.mark.anyio
async def test_update_organization_slug_rename_records_history():
    from app.main import app

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org = await _seed_org(s, slug="oldslug")
            user_id, _om_id = await _seed_human(s, org.id, role="owner")

        await _setup_app(app, Session, user_id, org.id)
        client = _client_for(app)
        try:
            resp = await client.patch(f"/api/v2/organizations/{org.id}", json={"slug": "newslug"})
            assert resp.status_code == 200, resp.text
            assert resp.json()["slug"] == "newslug"
        finally:
            await client.aclose()

        async with Session() as s:
            from sqlalchemy import select
            from app.models.entity_slug_history import EntitySlugHistory
            rows = (await s.execute(
                select(EntitySlugHistory).where(EntitySlugHistory.entity_id == org.id)
            )).scalars().all()
            assert len(rows) == 1
            assert rows[0].old_slug == "oldslug"
            assert rows[0].new_slug == "newslug"
            assert rows[0].entity_type == "organization"
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()


@pytest.mark.anyio
async def test_update_organization_slug_same_value_no_history():
    from app.main import app

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org = await _seed_org(s, slug="stableslug")
            user_id, _om_id = await _seed_human(s, org.id, role="owner")

        await _setup_app(app, Session, user_id, org.id)
        client = _client_for(app)
        try:
            resp = await client.patch(f"/api/v2/organizations/{org.id}", json={"slug": "stableslug"})
            assert resp.status_code == 200, resp.text
        finally:
            await client.aclose()

        async with Session() as s:
            from sqlalchemy import select
            from app.models.entity_slug_history import EntitySlugHistory
            rows = (await s.execute(
                select(EntitySlugHistory).where(EntitySlugHistory.entity_id == org.id)
            )).scalars().all()
            assert len(rows) == 0, "무변경 재전송은 이력 기록 안 함"
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()


@pytest.mark.anyio
async def test_update_organization_slug_collision_409():
    from app.main import app

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org1 = await _seed_org(s, slug="taken-ws")
            org2 = await _seed_org(s, slug="own-ws")
            user_id, _om_id = await _seed_human(s, org2.id, role="owner")
            _ = org1

        await _setup_app(app, Session, user_id, org2.id)
        client = _client_for(app)
        try:
            resp = await client.patch(f"/api/v2/organizations/{org2.id}", json={"slug": "taken-ws"})
            assert resp.status_code == 409, resp.text
        finally:
            await client.aclose()
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()


@pytest.mark.anyio
async def test_resolve_organization_by_slug_member_200_nonmember_404():
    from app.main import app

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org = await _seed_org(s, slug="resolvable-ws")
            member_id, _om = await _seed_human(s, org.id, role="member")
            other_org = await _seed_org(s)
            outsider_id, _om2 = await _seed_human(s, other_org.id, role="member")

        # 소속 멤버 — 200
        await _setup_app(app, Session, member_id, org.id)
        client = _client_for(app)
        try:
            resp = await client.get("/api/v2/organizations/resolve", params={"slug": "resolvable-ws"})
            assert resp.status_code == 200, resp.text
            assert resp.json()["id"] == str(org.id)
        finally:
            await client.aclose()
        app.dependency_overrides.clear()

        # 비소속 — 404(존재 비노출)
        await _setup_app(app, Session, outsider_id, other_org.id)
        client = _client_for(app)
        try:
            resp = await client.get("/api/v2/organizations/resolve", params={"slug": "resolvable-ws"})
            assert resp.status_code == 404, resp.text
        finally:
            await client.aclose()
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()


# ─── projects 라우터 ────────────────────────────────────────────────────────

@pytest.mark.anyio
async def test_create_project_no_slug_auto_derives_from_name():
    from app.main import app

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org = await _seed_org(s)
            user_id, _om = await _seed_human(s, org.id, role="owner")

        await _setup_app(app, Session, user_id, org.id)
        client = _client_for(app)
        try:
            resp = await client.post(
                "/api/v2/projects", json={"org_id": str(org.id), "name": "My Roadmap Q3"}
            )
            assert resp.status_code == 201, resp.text
            assert resp.json()["slug"] == "my-roadmap-q3"
        finally:
            await client.aclose()
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()


@pytest.mark.anyio
async def test_create_project_duplicate_name_auto_suffixes():
    from app.main import app

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org = await _seed_org(s)
            user_id, _om = await _seed_human(s, org.id, role="owner")

        await _setup_app(app, Session, user_id, org.id)
        client = _client_for(app)
        try:
            body = {"org_id": str(org.id), "name": "Roadmap"}
            r1 = await client.post("/api/v2/projects", json=body)
            r2 = await client.post("/api/v2/projects", json=body)
            assert r1.status_code == 201 and r2.status_code == 201
            assert r1.json()["slug"] == "roadmap"
            assert r2.json()["slug"] == "roadmap-2"
        finally:
            await client.aclose()
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()


@pytest.mark.anyio
async def test_create_project_explicit_slug_collision_409():
    from app.main import app

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org = await _seed_org(s)
            user_id, _om = await _seed_human(s, org.id, role="owner")
            await _seed_project(s, org.id, slug="explicit-slug")

        await _setup_app(app, Session, user_id, org.id)
        client = _client_for(app)
        try:
            resp = await client.post(
                "/api/v2/projects",
                json={"org_id": str(org.id), "name": "Anything", "slug": "explicit-slug"},
            )
            assert resp.status_code == 409, resp.text
        finally:
            await client.aclose()
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()


@pytest.mark.anyio
async def test_update_project_slug_rename_records_history_and_collision_409():
    from app.main import app

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org = await _seed_org(s)
            user_id, om_id = await _seed_human(s, org.id, role="owner")
            proj = await _seed_project(s, org.id, slug="old-proj-slug")
            other_proj = await _seed_project(s, org.id, slug="other-proj-slug")

        await _setup_app(app, Session, user_id, org.id)
        client = _client_for(app)
        try:
            ok = await client.patch(f"/api/v2/projects/{proj.id}", json={"slug": "new-proj-slug"})
            assert ok.status_code == 200, ok.text
            assert ok.json()["slug"] == "new-proj-slug"

            conflict = await client.patch(
                f"/api/v2/projects/{proj.id}", json={"slug": "other-proj-slug"}
            )
            assert conflict.status_code == 409, conflict.text
        finally:
            await client.aclose()

        async with Session() as s:
            from sqlalchemy import select
            from app.models.entity_slug_history import EntitySlugHistory
            rows = (await s.execute(
                select(EntitySlugHistory).where(EntitySlugHistory.entity_id == proj.id)
            )).scalars().all()
            assert len(rows) == 1
            assert rows[0].old_slug == "old-proj-slug"
            assert rows[0].new_slug == "new-proj-slug"
            assert rows[0].entity_type == "project"
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()


@pytest.mark.anyio
async def test_resolve_project_by_slug_scoped_to_caller_org():
    from app.main import app

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org_a = await _seed_org(s)
            org_b = await _seed_org(s)
            user_a, _om_a = await _seed_human(s, org_a.id, role="owner")
            proj_a = await _seed_project(s, org_a.id, slug="shared-slug-name")
            await _seed_project(s, org_b.id, slug="shared-slug-name")  # 다른 org의 동일 slug

        # org_a 컨텍스트에서 조회 → org_a의 project만.
        await _setup_app(app, Session, user_a, org_a.id)
        client = _client_for(app)
        try:
            resp = await client.get("/api/v2/projects/resolve", params={"slug": "shared-slug-name"})
            assert resp.status_code == 200, resp.text
            assert resp.json()["id"] == str(proj_a.id)
        finally:
            await client.aclose()
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()


@pytest.mark.anyio
async def test_resolve_project_by_slug_no_access_404():
    from app.main import app

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org = await _seed_org(s)
            # grant_project=False — org 멤버지만 project 접근권 없음(정책B: 미부여 비노출).
            user_id, _om = await _seed_human(s, org.id, role="member", grant_project=False)
            await _seed_project(s, org.id, slug="restricted-proj")

        await _setup_app(app, Session, user_id, org.id)
        client = _client_for(app)
        try:
            resp = await client.get("/api/v2/projects/resolve", params={"slug": "restricted-proj"})
            assert resp.status_code == 404, resp.text
        finally:
            await client.aclose()
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()
