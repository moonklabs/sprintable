"""E-SECURITY SEC-S8(story 83ea3d6a) Z: Sprint/Standup/github delete_link project-scope
미검증 봉쇄 실증 — 근본 하나(create/update/delete 경로 project-scope 부재)를 3개 라우터에서
닫는다(Sprint report_doc_id·Standup sprint_id/plan_story_ids+read-side 정보유출·github delete_link).

- Sprint report_doc_id: update_sprint이 소유권 검증 없이 그대로 repo.update에 전달(T-class).
- Standup: 실HTTP 확定 — project_a만 grant된 caller가 project_b sprint_id/story를 PUT으로
  참조하면 저장+응답에 그대로 title/project_id가 노출됐다(T-class + read-side 정보유출).
- github delete_link: create/list(Y)는 project-scope를 닫았는데 delete가 빠져 있었다(S/X-class)."""
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


# ── Sprint report_doc_id ────────────────────────────────────────────────────

@pytest.mark.anyio
async def test_update_sprint_cross_project_report_doc_blocked():
    from app.main import app
    from app.models.doc import Doc
    from app.models.pm import Sprint

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            seeded = await _seed_base(s)
            sprint_a = Sprint(id=uuid.uuid4(), org_id=seeded["org_id"], project_id=seeded["project_a_id"], title="Sprint A")
            doc_b = Doc(
                id=uuid.uuid4(), org_id=seeded["org_id"], project_id=seeded["project_b_id"],
                title="Doc B", slug=f"doc-b-{uuid.uuid4().hex[:8]}", content="",
            )
            s.add_all([sprint_a, doc_b])
            await s.commit()
            sprint_a_id, doc_b_id = sprint_a.id, doc_b.id

        await _setup_app(app, Session, seeded["human_user_id"], seeded["org_id"])
        client = _client_for(app)
        try:
            resp = await client.patch(
                f"/api/v2/sprints/{sprint_a_id}", json={"report_doc_id": str(doc_b_id)},
            )
            assert resp.status_code == 404, resp.text
        finally:
            await client.aclose()
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()


@pytest.mark.anyio
async def test_update_sprint_same_project_report_doc_still_works():
    from app.main import app
    from app.models.doc import Doc
    from app.models.pm import Sprint

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            seeded = await _seed_base(s)
            sprint_a = Sprint(id=uuid.uuid4(), org_id=seeded["org_id"], project_id=seeded["project_a_id"], title="Sprint A")
            doc_a = Doc(
                id=uuid.uuid4(), org_id=seeded["org_id"], project_id=seeded["project_a_id"],
                title="Doc A", slug=f"doc-a-{uuid.uuid4().hex[:8]}", content="",
            )
            s.add_all([sprint_a, doc_a])
            await s.commit()
            sprint_a_id, doc_a_id = sprint_a.id, doc_a.id

        await _setup_app(app, Session, seeded["human_user_id"], seeded["org_id"])
        client = _client_for(app)
        try:
            resp = await client.patch(
                f"/api/v2/sprints/{sprint_a_id}", json={"report_doc_id": str(doc_a_id)},
            )
            assert resp.status_code == 200, resp.text
            assert resp.json()["report_doc_id"] == str(doc_a_id)
        finally:
            await client.aclose()
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()


# ── Standup sprint_id/plan_story_ids ──────────────────────────────────────────

@pytest.mark.anyio
async def test_standup_cross_project_sprint_and_story_not_leaked():
    """Z 재현: project_a만 grant된 caller가 project_b sprint/story를 PUT으로 참조해도
    저장/응답에 반영되면 안 됨(쓰기 필터 + read enrich 접근권 필터 둘 다 실증)."""
    from app.main import app
    from app.models.pm import Sprint, Story

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            seeded = await _seed_base(s)
            sprint_b = Sprint(id=uuid.uuid4(), org_id=seeded["org_id"], project_id=seeded["project_b_id"], title="Sprint B Secret")
            story_b = Story(id=uuid.uuid4(), org_id=seeded["org_id"], project_id=seeded["project_b_id"], title="SECRET STORY B")
            s.add_all([sprint_b, story_b])
            await s.commit()
            sprint_b_id, story_b_id = sprint_b.id, story_b.id

        await _setup_app(app, Session, seeded["human_user_id"], seeded["org_id"])
        client = _client_for(app)
        try:
            resp = await client.put(
                "/api/v2/standups",
                json={
                    "project_id": str(seeded["project_a_id"]), "date": str(date.today()),
                    "sprint_id": str(sprint_b_id), "plan_story_ids": [str(story_b_id)],
                    "plan": "attempt cross-project leak",
                },
            )
            assert resp.status_code == 200, resp.text
            body = resp.json()
            assert body["sprint_id"] is None, "무권한 project의 sprint_id는 저장/응답에서 제거돼야 함"
            assert body["plan_stories"] == [], "무권한 project의 story는 enrich에서 제외돼야 함(정보유출 봉인)"
            entry_id = body["id"]
        finally:
            await client.aclose()

        # DB에도 실제로 스며들지 않았는지 확인.
        async with Session() as s:
            from sqlalchemy import select
            from app.models.standup import StandupEntry
            entry = (await s.execute(select(StandupEntry).where(StandupEntry.id == uuid.UUID(entry_id)))).scalar_one()
            assert entry.sprint_id is None
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()


@pytest.mark.anyio
async def test_standup_same_project_sprint_and_story_still_works():
    """회귀 0: project_a grant 보유 caller는 project_a sprint/story는 여전히 정상 저장+enrich."""
    from app.main import app
    from app.models.pm import Sprint, Story

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            seeded = await _seed_base(s)
            sprint_a = Sprint(id=uuid.uuid4(), org_id=seeded["org_id"], project_id=seeded["project_a_id"], title="Sprint A")
            story_a = Story(id=uuid.uuid4(), org_id=seeded["org_id"], project_id=seeded["project_a_id"], title="Story A")
            s.add_all([sprint_a, story_a])
            await s.commit()
            sprint_a_id, story_a_id = sprint_a.id, story_a.id

        await _setup_app(app, Session, seeded["human_user_id"], seeded["org_id"])
        client = _client_for(app)
        try:
            resp = await client.put(
                "/api/v2/standups",
                json={
                    "project_id": str(seeded["project_a_id"]), "date": str(date.today()),
                    "sprint_id": str(sprint_a_id), "plan_story_ids": [str(story_a_id)],
                    "plan": "legit plan",
                },
            )
            assert resp.status_code == 200, resp.text
            body = resp.json()
            assert body["sprint_id"] == str(sprint_a_id)
            assert [ps["id"] for ps in body["plan_stories"]] == [str(story_a_id)]
            assert body["plan_stories"][0]["title"] == "Story A"
        finally:
            await client.aclose()
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()


# ── github delete_link ─────────────────────────────────────────────────────

@pytest.mark.anyio
async def test_github_delete_link_cross_project_blocked():
    from app.main import app
    from app.models.github_installation import GithubInstallation
    from app.models.pm import Story
    from app.models.pull_request_story_link import PullRequestStoryLink

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            seeded = await _seed_base(s)
            story_b = Story(id=uuid.uuid4(), org_id=seeded["org_id"], project_id=seeded["project_b_id"], title="Story B")
            s.add(story_b)
            await s.commit()
            link = PullRequestStoryLink(
                id=uuid.uuid4(), org_id=seeded["org_id"], story_id=story_b.id,
                repo_full_name="acme-corp/repo1", pr_number=99,
                link_source="explicit", confidence="high",
            )
            s.add(link)
            await s.commit()
            link_id = link.id

        await _setup_app(app, Session, seeded["human_user_id"], seeded["org_id"])
        client = _client_for(app)
        try:
            resp = await client.delete(f"/api/v2/integrations/github/links/{link_id}")
            assert resp.status_code == 404, resp.text
        finally:
            await client.aclose()

        async with Session() as s:
            from sqlalchemy import select
            reloaded = (await s.execute(
                select(PullRequestStoryLink).where(PullRequestStoryLink.id == link_id)
            )).scalar_one()
            assert reloaded.deleted_at is None, "무권한 project의 link이 삭제되면 안 됨"
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()


@pytest.mark.anyio
async def test_github_delete_link_same_project_still_works():
    from app.main import app
    from app.models.pm import Story
    from app.models.pull_request_story_link import PullRequestStoryLink

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            seeded = await _seed_base(s)
            story_a = Story(id=uuid.uuid4(), org_id=seeded["org_id"], project_id=seeded["project_a_id"], title="Story A")
            s.add(story_a)
            await s.commit()
            link = PullRequestStoryLink(
                id=uuid.uuid4(), org_id=seeded["org_id"], story_id=story_a.id,
                repo_full_name="acme-corp/repo1", pr_number=100,
                link_source="explicit", confidence="high",
            )
            s.add(link)
            await s.commit()
            link_id = link.id

        await _setup_app(app, Session, seeded["human_user_id"], seeded["org_id"])
        client = _client_for(app)
        try:
            resp = await client.delete(f"/api/v2/integrations/github/links/{link_id}")
            assert resp.status_code == 200, resp.text
        finally:
            await client.aclose()
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()
