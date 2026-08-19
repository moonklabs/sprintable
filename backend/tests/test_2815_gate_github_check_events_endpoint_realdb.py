"""story #2815(§5-②③④, Gate→GitHub required check FE 계약 후속) — 실PG 검증.

- `GET /api/v2/gates/{id}/github-check-events`(§5-②) — 원장 최신순 조회, 존재 비노출(404).
- `GithubInstallation.enforced_check_repos` + `is_repo_check_enforced`(§5-④, 관측모드 판별).
- `get_gate_endpoint`의 `github_check_enforced` 필드 enrich.

test_1970_gate_single_get.py의 realdb harness(session_factory/client_for/setup_app/seed_common)
패턴을 그대로 재사용(로컬 복제 — 발명 0, 파일 self-contained 유지).
"""
from __future__ import annotations

import os
import uuid

import pytest

_REAL_DB_URL = os.getenv("PARITY_TEST_DATABASE_URL") or os.getenv("ALEMBIC_DATABASE_URL")

pytestmark = pytest.mark.destructive_schema

_REAL_DB_SKIP = pytest.mark.skipif(not _REAL_DB_URL, reason="통합 테스트는 실 PG(PARITY/ALEMBIC_DATABASE_URL) 필요")


@pytest.fixture
def anyio_backend():
    return "asyncio"


def _async_url() -> str:
    url = _REAL_DB_URL
    for prefix in ("postgresql+psycopg2://", "postgresql+asyncpg://", "postgresql://"):
        if url.startswith(prefix):
            return "postgresql+asyncpg://" + url[len(prefix):]
    return url


async def _session_factory():
    import app.models  # noqa: F401
    from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine

    from app.core.database import Base

    engine = create_async_engine(_async_url())
    async with engine.begin() as conn:
        await conn.run_sync(Base.metadata.create_all)
    return engine, async_sessionmaker(engine, expire_on_commit=False)


def _client_for(app):
    from httpx import ASGITransport, AsyncClient
    return AsyncClient(transport=ASGITransport(app=app), base_url="http://test")


async def _setup_app(app, Session, org_id, user_id):
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
        return AuthContext(user_id=str(user_id), email="caller@test", claims={"app_metadata": {}})

    async def _org():
        return org_id

    app.dependency_overrides[get_db] = _db
    app.dependency_overrides[get_current_user] = _auth
    app.dependency_overrides[get_verified_org_id] = _org


async def _seed_common(session):
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

    caller = User(id=uuid.uuid4(), email=f"caller-{uuid.uuid4().hex[:8]}@test.com", hashed_password="x")
    session.add(caller)
    await session.commit()
    caller_om = OrgMember(id=uuid.uuid4(), org_id=org.id, user_id=caller.id, role="member")
    session.add(caller_om)
    await session.commit()
    session.add(ProjectAccess(
        id=uuid.uuid4(), project_id=project.id, org_member_id=caller_om.id,
        permission="granted", role="member",
    ))
    await session.commit()

    outsider = User(id=uuid.uuid4(), email=f"outsider-{uuid.uuid4().hex[:8]}@test.com", hashed_password="x")
    session.add(outsider)
    await session.commit()
    session.add(OrgMember(id=uuid.uuid4(), org_id=org.id, user_id=outsider.id, role="member"))
    await session.commit()

    return {"org_id": org.id, "project_id": project.id, "caller_id": caller.id, "outsider_id": outsider.id}


async def _seed_merge_gate(session, seeded):
    from app.models.gate import Gate
    from app.models.pm import Story

    story = Story(id=uuid.uuid4(), org_id=seeded["org_id"], project_id=seeded["project_id"], title="s")
    session.add(story)
    await session.commit()
    gate = Gate(
        id=uuid.uuid4(), org_id=seeded["org_id"], work_item_id=story.id,
        work_item_type="story", gate_type="merge", status="pending",
    )
    session.add(gate)
    await session.commit()
    return story, gate


@_REAL_DB_SKIP
@pytest.mark.anyio
async def test_realdb_list_check_events_latest_first_and_shape():
    from app.main import app
    from app.models.gate_github_check_event import GateGithubCheckEvent

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            seeded = await _seed_common(s)
            _, gate = await _seed_merge_gate(s, seeded)
            gate_id = gate.id
            e1 = GateGithubCheckEvent(
                id=uuid.uuid4(), org_id=seeded["org_id"], gate_id=gate.id, story_id=gate.work_item_id,
                repo_full_name="acme/repo", pr_number=7, head_sha="sha-1",
                event_type="published", check_conclusion=None,
            )
            s.add(e1)
            await s.commit()
            e2 = GateGithubCheckEvent(
                id=uuid.uuid4(), org_id=seeded["org_id"], gate_id=gate.id, story_id=gate.work_item_id,
                repo_full_name="acme/repo", pr_number=7, head_sha="sha-1",
                event_type="resolved", check_conclusion="success",
            )
            s.add(e2)
            await s.commit()

        await _setup_app(app, Session, seeded["org_id"], seeded["caller_id"])
        client = _client_for(app)
        try:
            resp = await client.get(f"/api/v2/gates/{gate_id}/github-check-events")
            assert resp.status_code == 200, resp.text
            body = resp.json()
            assert len(body) == 2
            assert body[0]["event_type"] == "resolved"  # 최신순.
            assert body[0]["check_conclusion"] == "success"
            assert body[1]["event_type"] == "published"
            assert body[0]["repo_full_name"] == "acme/repo"
            assert body[0]["pr_number"] == 7
            assert body[0]["head_sha"] == "sha-1"
            assert "org_id" not in body[0]  # 응답 스키마가 의도적으로 생략(URL이 이미 컨텍스트).
        finally:
            await client.aclose()
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()


@_REAL_DB_SKIP
@pytest.mark.anyio
async def test_realdb_list_check_events_empty_list_when_no_events():
    """양성대조 — 이벤트가 없으면 빈 배열(404 아님, gate 자체는 존재)."""
    from app.main import app

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            seeded = await _seed_common(s)
            _, gate = await _seed_merge_gate(s, seeded)
            gate_id = gate.id

        await _setup_app(app, Session, seeded["org_id"], seeded["caller_id"])
        client = _client_for(app)
        try:
            resp = await client.get(f"/api/v2/gates/{gate_id}/github-check-events")
            assert resp.status_code == 200
            assert resp.json() == []
        finally:
            await client.aclose()
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()


@_REAL_DB_SKIP
@pytest.mark.anyio
async def test_realdb_list_check_events_404_for_nonexistent_gate():
    from app.main import app

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            seeded = await _seed_common(s)

        await _setup_app(app, Session, seeded["org_id"], seeded["caller_id"])
        client = _client_for(app)
        try:
            resp = await client.get(f"/api/v2/gates/{uuid.uuid4()}/github-check-events")
            assert resp.status_code == 404
        finally:
            await client.aclose()
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()


@_REAL_DB_SKIP
@pytest.mark.anyio
async def test_realdb_list_check_events_404_for_outsider_no_project_access():
    """IDOR — 존재 비노출(403 아니라 404, get_gate_endpoint와 동일 규율)."""
    from app.main import app

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            seeded = await _seed_common(s)
            _, gate = await _seed_merge_gate(s, seeded)
            gate_id = gate.id

        await _setup_app(app, Session, seeded["org_id"], seeded["outsider_id"])
        client = _client_for(app)
        try:
            resp = await client.get(f"/api/v2/gates/{gate_id}/github-check-events")
            assert resp.status_code == 404
        finally:
            await client.aclose()
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()


@_REAL_DB_SKIP
@pytest.mark.anyio
async def test_realdb_get_gate_github_check_enforced_true_when_repo_listed():
    from app.main import app
    from app.models.github_installation import GithubInstallation
    from app.models.pull_request_story_link import PullRequestStoryLink

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            seeded = await _seed_common(s)
            _, gate = await _seed_merge_gate(s, seeded)
            gate_id = gate.id
            s.add(GithubInstallation(
                id=uuid.uuid4(), org_id=seeded["org_id"], installation_id=999001,
                account_login="acme", enforced_check_repos=["acme/repo"],
            ))
            s.add(PullRequestStoryLink(
                id=uuid.uuid4(), org_id=seeded["org_id"], story_id=gate.work_item_id,
                repo_full_name="acme/repo", pr_number=7, link_source="sid", confidence="high",
            ))
            await s.commit()

        await _setup_app(app, Session, seeded["org_id"], seeded["caller_id"])
        client = _client_for(app)
        try:
            resp = await client.get(f"/api/v2/gates/{gate_id}")
            assert resp.status_code == 200, resp.text
            assert resp.json()["github_check_enforced"] is True
        finally:
            await client.aclose()
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()


@_REAL_DB_SKIP
@pytest.mark.anyio
async def test_realdb_get_gate_github_check_enforced_false_when_repo_not_listed():
    """양성대조 — repo가 enforced_check_repos에 없으면(관측모드) False."""
    from app.main import app
    from app.models.github_installation import GithubInstallation
    from app.models.pull_request_story_link import PullRequestStoryLink

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            seeded = await _seed_common(s)
            _, gate = await _seed_merge_gate(s, seeded)
            gate_id = gate.id
            s.add(GithubInstallation(
                id=uuid.uuid4(), org_id=seeded["org_id"], installation_id=999002,
                account_login="acme", enforced_check_repos=["acme/other-repo"],
            ))
            s.add(PullRequestStoryLink(
                id=uuid.uuid4(), org_id=seeded["org_id"], story_id=gate.work_item_id,
                repo_full_name="acme/repo", pr_number=7, link_source="sid", confidence="high",
            ))
            await s.commit()

        await _setup_app(app, Session, seeded["org_id"], seeded["caller_id"])
        client = _client_for(app)
        try:
            resp = await client.get(f"/api/v2/gates/{gate_id}")
            assert resp.status_code == 200, resp.text
            assert resp.json()["github_check_enforced"] is False
        finally:
            await client.aclose()
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()


@pytest.mark.anyio
async def test_is_repo_check_enforced_none_repo_full_name_returns_false():
    """단위 — repo_full_name을 모르면(링크 없음) 무조건 False, DB 조회 자체를 스킵."""
    from unittest.mock import AsyncMock

    from app.services.gate_github_check import is_repo_check_enforced

    session = AsyncMock()
    result = await is_repo_check_enforced(session, uuid.uuid4(), None)
    assert result is False
    session.execute.assert_not_awaited()
