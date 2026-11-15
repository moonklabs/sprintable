"""story 4910 — POST /api/v2/docs with a slug the project already uses answers 409 SLUG_TAKEN (the PATCH rename body), never a 500.

Found on dev (deploy-55): the same slug POSTed twice → 201 then 500 INTERNAL_ERROR, because create_doc handed the slug straight to the
`docs_project_slug_active` unique index (project_id, slug WHERE deleted_at IS NULL). Two layers now:
  - pre-check (`is_slug_taken`) → 409 before any insert;
  - the insert's unique violation (two requests passing the pre-check together) → the same 409.
A soft-deleted doc's slug is free again (the index only covers live rows); another project may use the same slug; any other integrity
error is not turned into a slug conflict.
"""
from __future__ import annotations

import os
import uuid
from unittest.mock import patch

import pytest
from sqlalchemy.exc import IntegrityError

_REAL_DB_URL = os.getenv("PARITY_TEST_DATABASE_URL") or os.getenv("ALEMBIC_DATABASE_URL")

pytestmark = [pytest.mark.anyio]

_realdb = pytest.mark.skipif(not _REAL_DB_URL, reason="통합 테스트는 실 PG(PARITY/ALEMBIC_DATABASE_URL) 필요")


@pytest.fixture
def anyio_backend():
    return "asyncio"


@pytest.fixture(autouse=True)
async def _dispose_global_engine_after_test():
    yield
    if not _REAL_DB_URL:
        return
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


async def _make_org(session):
    from app.models.organization import Organization
    org = Organization(id=uuid.uuid4(), name="Org", slug=f"org-{uuid.uuid4().hex[:8]}")
    session.add(org)
    await session.commit()
    return org


async def _make_project(session, org_id, name="P"):
    from app.models.project import Project
    project = Project(id=uuid.uuid4(), org_id=org_id, name=name)
    session.add(project)
    await session.commit()
    return project


async def _make_human_member(session, org_id, project_ids):
    from app.models.member import Member
    from app.models.project import OrgMember
    from app.models.project_access import ProjectAccess
    from app.models.user import User

    user = User(id=uuid.uuid4(), email=f"u-{uuid.uuid4().hex[:8]}@test.local", hashed_password="x")
    session.add(user)
    await session.flush()
    om = OrgMember(id=uuid.uuid4(), org_id=org_id, user_id=user.id, role="member")
    session.add(om)
    await session.flush()
    m = Member(id=om.id, org_id=org_id, type="human", user_id=user.id, name="Human")
    session.add(m)
    await session.flush()
    for project_id in project_ids:
        session.add(ProjectAccess(project_id=project_id, org_member_id=om.id, member_id=m.id, role="member"))
    await session.commit()
    return m.id, user.id


def _client_for(app):
    from httpx import ASGITransport, AsyncClient
    return AsyncClient(transport=ASGITransport(app=app), base_url="http://test")


async def _setup_app_human(app, Session, user_id, org_id):
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
        return AuthContext(user_id=str(user_id), email="human@test", claims={"app_metadata": {"org_id": str(org_id)}})

    from tests.conftest import override_db_and_read
    override_db_and_read(app, _db)
    app.dependency_overrides[get_current_user] = _auth


async def _fixture(session):
    org = await _make_org(session)
    project_a = await _make_project(session, org.id, "A")
    project_b = await _make_project(session, org.id, "B")
    _member_id, user_id = await _make_human_member(session, org.id, [project_a.id, project_b.id])
    return {"org_id": org.id, "project_a": project_a.id, "project_b": project_b.id, "user_id": user_id}


def _body(f, project_key, slug, title="T"):
    return {"project_id": str(f[project_key]), "org_id": str(f["org_id"]), "title": title, "slug": slug}


async def _live_count(Session, project_id, slug) -> int:
    from sqlalchemy import func, select
    from app.models.doc import Doc
    async with Session() as s:
        return (await s.execute(
            select(func.count()).select_from(Doc).where(Doc.project_id == project_id, Doc.slug == slug, Doc.deleted_at.is_(None))
        )).scalar() or 0


@_realdb
async def test_same_slug_twice_second_is_409_slug_taken_with_the_patch_body_realdb():
    from app.main import app

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            f = await _fixture(s)
        await _setup_app_human(app, Session, f["user_id"], f["org_id"])
        client = _client_for(app)
        try:
            slug = f"dup-{uuid.uuid4().hex[:8]}"
            first = await client.post("/api/v2/docs", json=_body(f, "project_a", slug, "first"))
            assert first.status_code == 201, first.text
            second = await client.post("/api/v2/docs", json=_body(f, "project_a", slug, "second"))
            assert second.status_code == 409, second.text
            err = second.json()["error"]
            assert err["code"] == "SLUG_TAKEN"
            assert err["message"] == "이미 사용 중인 슬러그"
            assert err["suggestion"] == f"{slug}-2"
            assert await _live_count(Session, f["project_a"], slug) == 1
        finally:
            await client.aclose()
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()


@_realdb
async def test_pre_check_answers_before_any_insert_realdb():
    """The second POST is answered by the pre-check: the insert (BaseRepository.create) is not even attempted."""
    from app.main import app
    from app.repositories.base import BaseRepository

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            f = await _fixture(s)
        await _setup_app_human(app, Session, f["user_id"], f["org_id"])
        client = _client_for(app)
        real_create = BaseRepository.create
        calls = []

        async def _spy(self, **data):
            calls.append(data.get("slug"))
            return await real_create(self, **data)

        try:
            slug = f"pre-{uuid.uuid4().hex[:8]}"
            with patch.object(BaseRepository, "create", _spy):
                assert (await client.post("/api/v2/docs", json=_body(f, "project_a", slug))).status_code == 201
                assert (await client.post("/api/v2/docs", json=_body(f, "project_a", slug))).status_code == 409
            assert calls == [slug], "the second POST must not reach the insert"
        finally:
            await client.aclose()
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()


@_realdb
async def test_unique_violation_at_insert_is_also_409_when_two_requests_pass_the_pre_check_realdb():
    """Simulate the race: the pre-check says «free» for the loser, the unique index refuses its insert → still 409 SLUG_TAKEN + a real suggestion."""
    from app.main import app
    import app.services.doc_slug as doc_slug

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            f = await _fixture(s)
        await _setup_app_human(app, Session, f["user_id"], f["org_id"])
        client = _client_for(app)
        real_taken = doc_slug.is_slug_taken
        state = {"n": 0}

        async def _blind_once(*args, **kwargs):
            state["n"] += 1
            if state["n"] == 1:
                return False  # the pre-check of the losing request sees nothing
            return await real_taken(*args, **kwargs)  # the suggestion lookup after the rollback is honest

        try:
            slug = f"race-{uuid.uuid4().hex[:8]}"
            assert (await client.post("/api/v2/docs", json=_body(f, "project_a", slug, "winner"))).status_code == 201
            state["n"] = 0
            with patch.object(doc_slug, "is_slug_taken", _blind_once):
                loser = await client.post("/api/v2/docs", json=_body(f, "project_a", slug, "loser"))
            assert loser.status_code == 409, loser.text
            err = loser.json()["error"]
            assert err["code"] == "SLUG_TAKEN"
            assert err["suggestion"] == f"{slug}-2"
            assert await _live_count(Session, f["project_a"], slug) == 1
        finally:
            await client.aclose()
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()


@_realdb
async def test_a_soft_deleted_docs_slug_can_be_used_again_realdb():
    from sqlalchemy import update, func
    from app.main import app
    from app.models.doc import Doc

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            f = await _fixture(s)
        await _setup_app_human(app, Session, f["user_id"], f["org_id"])
        client = _client_for(app)
        try:
            slug = f"gone-{uuid.uuid4().hex[:8]}"
            first = await client.post("/api/v2/docs", json=_body(f, "project_a", slug, "old"))
            assert first.status_code == 201, first.text
            async with Session() as s:
                await s.execute(update(Doc).where(Doc.id == uuid.UUID(first.json()["id"])).values(deleted_at=func.now()))
                await s.commit()
            again = await client.post("/api/v2/docs", json=_body(f, "project_a", slug, "new"))
            assert again.status_code == 201, again.text
            assert await _live_count(Session, f["project_a"], slug) == 1
        finally:
            await client.aclose()
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()


@_realdb
async def test_the_same_slug_in_another_project_is_fine_realdb():
    from app.main import app

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            f = await _fixture(s)
        await _setup_app_human(app, Session, f["user_id"], f["org_id"])
        client = _client_for(app)
        try:
            slug = f"shared-{uuid.uuid4().hex[:8]}"
            assert (await client.post("/api/v2/docs", json=_body(f, "project_a", slug))).status_code == 201
            assert (await client.post("/api/v2/docs", json=_body(f, "project_b", slug))).status_code == 201
        finally:
            await client.aclose()
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()


@_realdb
async def test_another_integrity_error_at_insert_is_not_dressed_up_as_slug_taken_realdb():
    """The catch answers 409 only for the slug index: a different integrity error (here a foreign key) still surfaces as the error it was."""
    from app.main import app
    from app.repositories.base import BaseRepository

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            f = await _fixture(s)
        await _setup_app_human(app, Session, f["user_id"], f["org_id"])
        client = _client_for(app)

        async def _fk_violation(self, **data):
            raise _integrity_error(
                'insert or update on table "docs" violates foreign key constraint "docs_parent_id_fkey"',
                constraint="docs_parent_id_fkey", sqlstate="23503",
            )

        try:
            with patch.object(BaseRepository, "create", _fk_violation):
                with pytest.raises(IntegrityError):
                    await client.post("/api/v2/docs", json=_body(f, "project_a", f"fk-{uuid.uuid4().hex[:8]}"))
        finally:
            await client.aclose()
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()


@_realdb
async def test_a_slug_that_spells_the_index_name_does_not_turn_a_check_violation_into_slug_taken_realdb():
    """Real Postgres: the failing row's detail contains the slug, which here equals the index name — but the violated constraint is the
    doc_type check, so the answer is still the integrity error (not SLUG_TAKEN)."""
    from app.main import app

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            f = await _fixture(s)
        await _setup_app_human(app, Session, f["user_id"], f["org_id"])
        client = _client_for(app)
        try:
            body = _body(f, "project_a", "docs_project_slug_active")
            body["doc_type"] = "not-a-real-type"
            with pytest.raises(IntegrityError):
                await client.post("/api/v2/docs", json=body)
        finally:
            await client.aclose()
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()


def _integrity_error(message: str, *, constraint: str | None, sqlstate: str | None) -> IntegrityError:
    """An IntegrityError shaped like SQLAlchemy's asyncpg path: .orig is the adapter error whose __cause__ is the driver exception."""

    class _Driver(Exception):
        pass

    class _Adapter(Exception):
        pass

    driver = _Driver(message)
    driver.constraint_name = constraint
    driver.sqlstate = sqlstate
    adapter = _Adapter(message)
    adapter.__cause__ = driver
    return IntegrityError("INSERT", {}, adapter)


def test_only_the_slug_unique_index_counts_as_a_slug_conflict():
    """Any other integrity error (foreign key, other unique, check) is not dressed up as SLUG_TAKEN."""
    from app.routers.docs import _is_doc_slug_unique_violation

    msg = 'duplicate key value violates unique constraint "docs_project_slug_active"'
    assert _is_doc_slug_unique_violation(_integrity_error(msg, constraint="docs_project_slug_active", sqlstate="23505")) is True
    assert _is_doc_slug_unique_violation(_integrity_error(msg, constraint="uq_doc_slug_alias_project_old", sqlstate="23505")) is False
    assert _is_doc_slug_unique_violation(_integrity_error("fk", constraint="docs_parent_id_fkey", sqlstate="23503")) is False
    # same constraint name but not a unique violation, and a message that merely spells the index name: both refused
    assert _is_doc_slug_unique_violation(_integrity_error(msg, constraint="docs_project_slug_active", sqlstate="23514")) is False
    assert _is_doc_slug_unique_violation(_integrity_error(msg, constraint=None, sqlstate=None)) is False
