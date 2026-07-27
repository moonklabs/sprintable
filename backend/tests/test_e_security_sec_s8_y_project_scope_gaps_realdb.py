"""E-SECURITY SEC-S8(story 83ea3d6a) Y: 4개 라우터 project-scope 미검증 봉쇄 실증 — 근본은
하나(create/list 경로 project-scope 부재)라 한 파일로 묶는다.

- doc parent_id: create_doc이 parent_id를 소유권 검증 없이 그대로 repo.create에 전달(T-class).
- agent_runs: list_agent_runs가 org-scope만 있고 has_project_access는 안 봄(G-class).
- file_locks: list_file_locks가 독스트링("현재 프로젝트 내")과 달리 project_id 필터 자체가 없음.
- github story-link: create_explicit_link/list_links가 story org-scope는 있으나 project-scope
  없이 같은 org 다른 project story에 PR 링크 생성/열람 가능(T/X-class)."""
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


async def _seed_base(session):
    """org(project_a, project_b) + human_a(project_a에만 명시 grant)."""
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

    human_user_id = uuid.uuid4()
    human_user = User(id=human_user_id, email=f"h-{human_user_id.hex[:8]}@test.com", hashed_password="x")
    session.add(human_user)
    await session.commit()
    human_om = OrgMember(id=uuid.uuid4(), org_id=org.id, user_id=human_user_id, role="member")
    session.add(human_om)
    await session.commit()
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
        return AuthContext(
            user_id=str(user_id), email="caller@test",
            claims={"app_metadata": {"org_id": str(org_id)}},
        )

    app.dependency_overrides[get_db] = _db
    app.dependency_overrides[get_current_user] = _auth


# ── doc parent_id ────────────────────────────────────────────────────────────

@pytest.mark.anyio
async def test_create_doc_cross_project_parent_blocked():
    from app.main import app
    from app.models.doc import Doc

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            seeded = await _seed_base(s)
            doc_b = Doc(
                id=uuid.uuid4(), org_id=seeded["org_id"], project_id=seeded["project_b_id"],
                title="Doc B", slug=f"doc-b-{uuid.uuid4().hex[:8]}", content="",
            )
            s.add(doc_b)
            await s.commit()
            doc_b_id = doc_b.id

        await _setup_app(app, Session, seeded["human_user_id"], seeded["org_id"])
        client = _client_for(app)
        try:
            resp = await client.post(
                "/api/v2/docs",
                json={
                    "project_id": str(seeded["project_a_id"]), "org_id": str(seeded["org_id"]),
                    "title": "Injected", "slug": f"injected-{uuid.uuid4().hex[:8]}",
                    "parent_id": str(doc_b_id),
                },
            )
            assert resp.status_code == 404, resp.text
        finally:
            await client.aclose()
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()


@pytest.mark.anyio
async def test_create_doc_same_project_parent_still_works():
    from app.main import app
    from app.models.doc import Doc

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            seeded = await _seed_base(s)
            doc_a = Doc(
                id=uuid.uuid4(), org_id=seeded["org_id"], project_id=seeded["project_a_id"],
                title="Doc A", slug=f"doc-a-{uuid.uuid4().hex[:8]}", content="",
            )
            s.add(doc_a)
            await s.commit()
            doc_a_id = doc_a.id

        await _setup_app(app, Session, seeded["human_user_id"], seeded["org_id"])
        client = _client_for(app)
        try:
            resp = await client.post(
                "/api/v2/docs",
                json={
                    "project_id": str(seeded["project_a_id"]), "org_id": str(seeded["org_id"]),
                    "title": "Child", "slug": f"child-{uuid.uuid4().hex[:8]}",
                    "parent_id": str(doc_a_id),
                },
            )
            assert resp.status_code == 201, resp.text
            assert resp.json()["parent_id"] == str(doc_a_id)
        finally:
            await client.aclose()
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()


# ── agent_runs ────────────────────────────────────────────────────────────────

@pytest.mark.anyio
async def test_list_agent_runs_cross_project_blocked():
    from app.main import app

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            seeded = await _seed_base(s)

        await _setup_app(app, Session, seeded["human_user_id"], seeded["org_id"])
        client = _client_for(app)
        try:
            resp = await client.get(
                "/api/v2/agent-runs", params={"project_id": str(seeded["project_b_id"])},
            )
            assert resp.status_code == 403, resp.text
        finally:
            await client.aclose()
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()


@pytest.mark.anyio
async def test_list_agent_runs_same_project_still_works():
    from app.main import app

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            seeded = await _seed_base(s)

        await _setup_app(app, Session, seeded["human_user_id"], seeded["org_id"])
        client = _client_for(app)
        try:
            resp = await client.get(
                "/api/v2/agent-runs", params={"project_id": str(seeded["project_a_id"])},
            )
            assert resp.status_code == 200, resp.text
        finally:
            await client.aclose()
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()


# ── file_locks ────────────────────────────────────────────────────────────────

@pytest.mark.anyio
async def test_list_file_locks_scoped_to_own_project_only():
    """B가 아니라 A의 lock만 보여야 함(org 전체 노출 봉쇄)."""
    from app.main import app
    from app.models.file_lock import FileLock

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            seeded = await _seed_base(s)
            now_a = FileLock(
                id=uuid.uuid4(), org_id=seeded["org_id"], project_id=seeded["project_a_id"],
                member_id=uuid.uuid4(), file_path="a.py",
            )
            now_b = FileLock(
                id=uuid.uuid4(), org_id=seeded["org_id"], project_id=seeded["project_b_id"],
                member_id=uuid.uuid4(), file_path="b.py",
            )
            s.add_all([now_a, now_b])
            await s.commit()

        await _setup_app(app, Session, seeded["human_user_id"], seeded["org_id"])
        client = _client_for(app)
        try:
            resp = await client.get(
                "/api/v2/file-locks", params={"project_id": str(seeded["project_a_id"])},
            )
            assert resp.status_code == 200, resp.text
            paths = {row["file_path"] for row in resp.json()}
            assert paths == {"a.py"}, f"project_b lock이 노출되면 안 됨: {paths}"
        finally:
            await client.aclose()
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()


@pytest.mark.anyio
async def test_list_file_locks_no_access_project_blocked():
    from app.main import app

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            seeded = await _seed_base(s)

        await _setup_app(app, Session, seeded["human_user_id"], seeded["org_id"])
        client = _client_for(app)
        try:
            resp = await client.get(
                "/api/v2/file-locks", params={"project_id": str(seeded["project_b_id"])},
            )
            assert resp.status_code == 403, resp.text
        finally:
            await client.aclose()
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()


# ── github story-link ──────────────────────────────────────────────────────────

@pytest.mark.anyio
async def test_github_link_cross_project_story_blocked():
    from app.main import app
    from app.models.github_installation import GithubInstallation
    from app.models.pm import Story

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            seeded = await _seed_base(s)
            story_b = Story(
                id=uuid.uuid4(), org_id=seeded["org_id"], project_id=seeded["project_b_id"], title="Story B",
            )
            s.add(story_b)
            s.add(GithubInstallation(
                id=uuid.uuid4(), org_id=seeded["org_id"], installation_id=uuid.uuid4().int % 2_000_000_000,
                account_login="acme-corp", account_type="Organization", repository_selection="all",
            ))
            await s.commit()
            story_b_id = story_b.id

        await _setup_app(app, Session, seeded["human_user_id"], seeded["org_id"])
        client = _client_for(app)
        try:
            resp = await client.post(
                "/api/v2/integrations/github/links",
                json={"story_id": str(story_b_id), "repo_full_name": "acme-corp/repo1", "pr_number": 42},
            )
            assert resp.status_code == 404, resp.text

            resp2 = await client.get(
                "/api/v2/integrations/github/links", params={"story_id": str(story_b_id)},
            )
            assert resp2.status_code == 404, resp2.text
        finally:
            await client.aclose()
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()


@pytest.mark.anyio
async def test_github_link_same_project_story_still_works():
    from app.main import app
    from app.models.github_installation import GithubInstallation
    from app.models.pm import Story

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            seeded = await _seed_base(s)
            story_a = Story(
                id=uuid.uuid4(), org_id=seeded["org_id"], project_id=seeded["project_a_id"], title="Story A",
            )
            s.add(story_a)
            s.add(GithubInstallation(
                id=uuid.uuid4(), org_id=seeded["org_id"], installation_id=uuid.uuid4().int % 2_000_000_000,
                account_login="acme-corp", account_type="Organization", repository_selection="all",
            ))
            await s.commit()
            story_a_id = story_a.id

        await _setup_app(app, Session, seeded["human_user_id"], seeded["org_id"])
        client = _client_for(app)
        try:
            resp = await client.post(
                "/api/v2/integrations/github/links",
                json={"story_id": str(story_a_id), "repo_full_name": "acme-corp/repo1", "pr_number": 7},
            )
            assert resp.status_code == 200, resp.text

            resp2 = await client.get(
                "/api/v2/integrations/github/links", params={"story_id": str(story_a_id)},
            )
            assert resp2.status_code == 200, resp2.text
            assert len(resp2.json()["links"]) == 1
        finally:
            await client.aclose()
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()
