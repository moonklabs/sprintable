"""story 4427 (나) piece 1 (PO 2026-09-30 01:38Z · design doc 9a4cb445 §4) — «create an organization» and «create a project» moved
into services/org_project_create.py so the desktop setup can make both inside one transaction.

Pinned here:
- the services never commit: after them, a rollback leaves no organization, project, membership or member anchor (read back on
  a new connection), and a commit (positive control) leaves all of them;
- inside the open transaction the new owner membership and member anchor are already visible — what the setup confirmation
  reads next (`is_org_owner_or_admin` · `resolve_member` on the same session);
- the two routes are unchanged: same status and response, and the same number of commits as before the move
  (`POST /organizations` 2 = its own + get_db's · `POST /projects` 2 — measured on the base commit with this same file)."""
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


async def _new_user(Session) -> uuid.UUID:
    from app.models.user import User

    user_id = uuid.uuid4()
    async with Session() as s:
        s.add(User(id=user_id, email=f"u-{user_id.hex[:8]}@test.com", hashed_password="x", email_verified=True))
        await s.commit()
    return user_id


class _CommitCounter:
    """Counts AsyncSession.commit calls from the moment it is installed (seeding before that is not counted)."""

    def __init__(self, monkeypatch):
        from sqlalchemy.ext.asyncio import AsyncSession

        self.count = 0
        real = AsyncSession.commit
        counter = self

        async def counting(session_self):
            counter.count += 1
            return await real(session_self)

        monkeypatch.setattr(AsyncSession, "commit", counting)


async def _state(Session, user_id: uuid.UUID, org_id: uuid.UUID | None, project_id: uuid.UUID | None) -> dict:
    """What exists, read on a new connection."""
    from sqlalchemy import text

    async with Session() as s:
        memberships = (await s.execute(
            text("SELECT id FROM org_members WHERE user_id = :u AND deleted_at IS NULL"), {"u": str(user_id)},
        )).scalars().all()
        anchors = (await s.execute(
            text("SELECT count(*) FROM members WHERE id = ANY(:ids)"), {"ids": list(memberships)},
        )).scalar() if memberships else 0
        orgs = (await s.execute(text("SELECT count(*) FROM organizations WHERE id = :o"), {"o": str(org_id)})).scalar() if org_id else 0
        projects = (await s.execute(text("SELECT count(*) FROM projects WHERE id = :p"), {"p": str(project_id)})).scalar() if project_id else 0
    return {"memberships": len(memberships), "anchors": anchors, "orgs": orgs, "projects": projects}


async def _make_both(s, user_id: uuid.UUID):
    from app.services.org_project_create import (
        check_org_create_allowed,
        check_project_create_allowed,
        create_org_with_owner,
        create_project_with_member,
    )

    await check_org_create_allowed(s, str(user_id))
    org = await create_org_with_owner(s, name="문클랩스 팀", slug=None, user_id=str(user_id), owner_member_id=None)
    await check_project_create_allowed(s, org.id)
    project = await create_project_with_member(
        s, org_id=org.id, name="첫 프로젝트", description=None, slug=None, user_id=str(user_id),
    )
    return org, project


@pytest.mark.anyio
async def test_services_never_commit_a_rollback_leaves_nothing(monkeypatch):
    engine, Session = await _session_factory()
    try:
        user_id = await _new_user(Session)
        counter = _CommitCounter(monkeypatch)
        async with Session() as s:
            org, project = await _make_both(s, user_id)
            assert counter.count == 0
            # inside the open transaction the confirmation's next reads already see the owner and the anchor
            from sqlalchemy import text
            from app.services.project_auth import is_org_owner_or_admin
            assert await is_org_owner_or_admin(s, user_id, org.id) is True
            om_id = (await s.execute(
                text("SELECT id FROM org_members WHERE org_id = :o AND user_id = :u"), {"o": str(org.id), "u": str(user_id)},
            )).scalar_one()
            assert (await s.execute(text("SELECT count(*) FROM members WHERE id = :m"), {"m": str(om_id)})).scalar() == 1
            await s.rollback()
        assert await _state(Session, user_id, org.id, project.id) == {"memberships": 0, "anchors": 0, "orgs": 0, "projects": 0}
        async with Session() as s:
            assert (await s.execute(text("SELECT count(*) FROM members WHERE id = :m"), {"m": str(om_id)})).scalar() == 0
    finally:
        await engine.dispose()


@pytest.mark.anyio
async def test_positive_control_a_commit_keeps_all_of_it():
    engine, Session = await _session_factory()
    try:
        user_id = await _new_user(Session)
        async with Session() as s:
            org, project = await _make_both(s, user_id)
            await s.commit()
        assert await _state(Session, user_id, org.id, project.id) == {"memberships": 1, "anchors": 1, "orgs": 1, "projects": 1}
    finally:
        await engine.dispose()


async def _setup_app(app, Session, user_id, org_id=None):
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

    claims = {"app_metadata": {} if org_id is None else {"org_id": str(org_id)}}

    async def _auth():
        return AuthContext(user_id=str(user_id), email="caller@test", claims=claims)

    override_db_and_read(app, _db)
    app.dependency_overrides[get_current_user] = _auth


async def _post(app, path: str, body: dict):
    from httpx import ASGITransport, AsyncClient

    client = AsyncClient(transport=ASGITransport(app=app), base_url="http://test")
    try:
        return await client.post(path, json=body)
    finally:
        await client.aclose()


@pytest.mark.anyio
async def test_routes_unchanged_same_response_and_commit_count(monkeypatch):
    """No service import here, so this test runs as is on the commit before the move (the comparison in the PR)."""
    from app.main import app

    engine, Session = await _session_factory()
    try:
        user_id = await _new_user(Session)
        await _setup_app(app, Session, user_id)
        counter = _CommitCounter(monkeypatch)
        resp = await _post(app, "/api/v2/organizations", {"name": "Route Check Team"})
        assert resp.status_code == 201, resp.text
        org = resp.json()
        from app.schemas.organization import OrganizationResponse
        assert set(org) == set(OrganizationResponse.model_fields)
        assert org["name"] == "Route Check Team" and org["slug"].startswith("route-check-team")
        org_commits = counter.count

        app.dependency_overrides.clear()
        await _setup_app(app, Session, user_id, org_id=org["id"])
        counter.count = 0
        resp = await _post(app, "/api/v2/projects", {"org_id": org["id"], "name": "첫 프로젝트"})
        assert resp.status_code == 201, resp.text
        assert resp.json()["name"] == "첫 프로젝트" and resp.json()["org_id"] == org["id"]
        project_commits = counter.count

        assert (org_commits, project_commits) == (2, 2)
        state = await _state(Session, user_id, uuid.UUID(org["id"]), uuid.UUID(resp.json()["id"]))
        assert state == {"memberships": 1, "anchors": 1, "orgs": 1, "projects": 1}
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()


# ─── Qadir 2nd line on 4832 · PO 04:50Z — the same ASCII name by two people at the same moment ─────────────────────────


async def _someone_waits_on_a_row(Session, ms: int = 10000) -> bool:
    """Condition wait (not a fixed sleep): a backend is blocked on another transaction (the unique index on an uncommitted row)."""
    import asyncio
    from sqlalchemy import text

    loop = asyncio.get_running_loop()
    deadline = loop.time() + ms / 1000
    while loop.time() < deadline:
        async with Session() as s:
            n = (await s.execute(text("SELECT count(*) FROM pg_locks WHERE locktype = 'transactionid' AND NOT granted"))).scalar()
        if n:
            return True
        await asyncio.sleep(0.02)
    return False


async def _drop_orgs(Session, slugs: list[str], users: list[uuid.UUID]) -> None:
    from sqlalchemy import text

    async with Session() as s:
        ids = [r[0] for r in (await s.execute(text("SELECT id FROM organizations WHERE slug = ANY(:s)"), {"s": slugs})).all()]
        for sql in (
            "DELETE FROM members WHERE org_id = ANY(:o)",
            "DELETE FROM org_members WHERE org_id = ANY(:o)",
            "DELETE FROM participation_role WHERE org_id = ANY(:o)",
            "DELETE FROM organizations WHERE id = ANY(:o)",
        ):
            await s.execute(text(sql), {"o": ids})
        await s.execute(text("DELETE FROM users WHERE id = ANY(:u)"), {"u": [str(u) for u in users]})
        await s.commit()


@pytest.mark.anyio
async def test_same_ascii_name_at_the_same_moment_both_made_with_different_slugs():
    import asyncio
    from app.services.org_project_create import create_org_with_owner

    engine, Session = await _session_factory()
    u1, u2 = await _new_user(Session), await _new_user(Session)
    name = f"Race Team {uuid.uuid4().hex[:6]}"
    made: list[str] = []
    try:
        async with Session() as a:
            org_a = await create_org_with_owner(a, name=name, slug=None, user_id=str(u1), owner_member_id=None)  # flushed, not committed
            made.append(org_a.slug)

            async def second() -> str:
                async with Session() as b:
                    org_b = await create_org_with_owner(b, name=name, slug=None, user_id=str(u2), owner_member_id=None)
                    await b.commit()
                    return org_b.slug

            task = asyncio.create_task(second())
            assert await _someone_waits_on_a_row(Session), "the second insert should wait on the first one's uncommitted row"
            await a.commit()
        slug_b = await task
        made.append(slug_b)
        assert slug_b == f"{org_a.slug}-2", (org_a.slug, slug_b)
    finally:
        await _drop_orgs(Session, made, [u1, u2])
        await engine.dispose()


@pytest.mark.anyio
async def test_same_sent_slug_at_the_same_moment_is_409_not_500():
    import asyncio
    from fastapi import HTTPException
    from app.services.org_project_create import create_org_with_owner

    engine, Session = await _session_factory()
    u1, u2 = await _new_user(Session), await _new_user(Session)
    slug = f"race-{uuid.uuid4().hex[:8]}"
    try:
        async with Session() as a:
            await create_org_with_owner(a, name="A", slug=slug, user_id=str(u1), owner_member_id=None)

            async def second():
                async with Session() as b:
                    return await create_org_with_owner(b, name="B", slug=slug, user_id=str(u2), owner_member_id=None)

            task = asyncio.create_task(second())
            assert await _someone_waits_on_a_row(Session)
            await a.commit()
        with pytest.raises(HTTPException) as e:
            await task
        assert e.value.status_code == 409
    finally:
        await _drop_orgs(Session, [slug], [u1, u2])
        await engine.dispose()
