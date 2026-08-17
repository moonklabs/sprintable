"""story #2642(웹·칩 공통, 2026-08-14) BE 절반 — 엔티티 «전체 보기» 착지가 뷰어의 현재
프로젝트로 새는 버그. FE가 뷰어 컨텍스트 대신 엔티티 자신의 org/project로 직행 URL을 짓게
7축(story/goal/task/sprint/evidence/artifact/storage-asset) 응답에 org_slug/project_slug를
additive로 싣는다(#2168 DocPreviewResponse와 동형 패턴).

커버: 축별 positive 검증(슬러그 실제로 실림) + Story list N+1 부재(PO 자체발견 원칙 — org=
요청당 1쿼리·project=distinct 배치 1쿼리, 행 수 무관 고정)."""
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


def _auth(user_id: uuid.UUID, org_id: uuid.UUID, *, is_agent: bool = True):
    from app.dependencies.auth import AuthContext
    claims = {"app_metadata": {"org_id": str(org_id)}}
    if is_agent:
        claims["app_metadata"]["api_key_id"] = str(uuid.uuid4())
    return AuthContext(user_id=str(user_id), email=None, claims=claims)


async def _seed_org_project(session, *, project_slug="p-slug", org_slug=None):
    from app.models.organization import Organization
    from app.models.project import Project

    org = Organization(id=uuid.uuid4(), name="Org2642", slug=org_slug or f"org-{uuid.uuid4().hex[:8]}")
    session.add(org)
    await session.commit()
    project = Project(id=uuid.uuid4(), org_id=org.id, name="P", slug=project_slug)
    session.add(project)
    await session.commit()
    return org, project


async def _seed_agent(session, org_id, project_id, *, name="agent"):
    from app.models.member import AgentProjectProfile, Member
    from app.models.project_access import ProjectAccess

    member_id = uuid.uuid4()
    session.add(Member(id=member_id, org_id=org_id, type="agent", name=name))
    await session.commit()
    session.add(AgentProjectProfile(id=uuid.uuid4(), member_id=member_id, project_id=project_id))
    session.add(ProjectAccess(
        id=uuid.uuid4(), project_id=project_id, member_id=member_id, permission="granted",
    ))
    await session.commit()
    return member_id


# ── entity_slug.py 단위 ────────────────────────────────────────────────────
async def test_resolve_org_slug_and_project_slugs():
    from app.services.entity_slug import resolve_org_slug, resolve_project_slugs

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org, project = await _seed_org_project(s, project_slug="acme-web")
            org_slug = await resolve_org_slug(s, org.id)
            assert org_slug == org.slug

            slug_map = await resolve_project_slugs(s, {project.id})
            assert slug_map[project.id] == "acme-web"

            # 빈 집합·None 섞인 집합 — 안전 처리(빈 dict/스킵).
            assert await resolve_project_slugs(s, set()) == {}
            assert await resolve_project_slugs(s, {None, project.id}) == {project.id: "acme-web"}
    finally:
        await engine.dispose()


async def test_resolve_project_slugs_nullable_project_slug():
    """Project.slug가 nullable(미백필 행) — None으로 정직하게 반영."""
    from app.models.organization import Organization
    from app.models.project import Project
    from app.services.entity_slug import resolve_project_slugs

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org = Organization(id=uuid.uuid4(), name="O", slug=f"o-{uuid.uuid4().hex[:8]}")
            s.add(org)
            await s.commit()
            project = Project(id=uuid.uuid4(), org_id=org.id, name="P", slug=None)
            s.add(project)
            await s.commit()

            slug_map = await resolve_project_slugs(s, {project.id})
            assert slug_map[project.id] is None
    finally:
        await engine.dispose()


# ── Story axis ──────────────────────────────────────────────────────────────
async def test_story_list_and_get_carry_org_project_slug():
    from app.repositories.story import StoryRepository
    from app.routers.stories import get_story, list_stories
    from app.models.pm import Story

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org, project = await _seed_org_project(s, project_slug="acme-web")
            agent_id = await _seed_agent(s, org.id, project.id)
            story = Story(id=uuid.uuid4(), org_id=org.id, project_id=project.id, title="S", status="backlog")
            s.add(story)
            await s.commit()

            repo = StoryRepository(s, org.id)
            listed = await list_stories(
                project_id=None, epic_id=None, sprint_id=None, assignee_id=None,
                status_filter=None, no_sprint=False, unattached=False, ids=None,
                story_number=None, q=None, boost_candidates_from=None, limit=1000,
                cursor=None, response=None, repo=repo, auth=_auth(agent_id, org.id),
            )
            assert len(listed) == 1
            assert listed[0].org_slug == org.slug
            assert listed[0].project_slug == "acme-web"

            single = await get_story(id=story.id, repo=repo, auth=_auth(agent_id, org.id))
            assert single.org_slug == org.slug
            assert single.project_slug == "acme-web"
    finally:
        await engine.dispose()


async def test_story_create_carries_org_project_slug():
    """create_story는 8개 응답 사이트 중 처음에 빠뜨렸던 자리(카디르 QA 계기로 자체발견,
    2026-08-14) — list/get만이 아니라 create도 같은 계약을 지키는지 직접 고정."""
    from fastapi import BackgroundTasks
    from app.routers.stories import create_story
    from app.schemas.story import StoryCreate

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org, project = await _seed_org_project(s, project_slug="acme-web")
            agent_id = await _seed_agent(s, org.id, project.id)

        async with Session() as s:
            created = await create_story(
                body=StoryCreate(project_id=project.id, org_id=org.id, title="New Story"),
                background_tasks=BackgroundTasks(),
                session=s, auth=_auth(agent_id, org.id), org_id=org.id,
            )
            assert created.org_slug == org.slug
            assert created.project_slug == "acme-web"
    finally:
        await engine.dispose()


async def test_story_list_slug_resolution_is_not_n_plus_1():
    """PO 자체발견 원칙 — story 5건(project 2개에 분산)이어도 org_slug/project_slug 쿼리는
    각각 고정 1회(행 수 비례 아님)."""
    from app.repositories.story import StoryRepository
    from app.routers.stories import list_stories
    from app.models.pm import Story
    from app.models.project import Project
    from sqlalchemy import event

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org, project1 = await _seed_org_project(s, project_slug="proj-one")
            project2 = Project(id=uuid.uuid4(), org_id=org.id, name="P2", slug="proj-two")
            s.add(project2)
            await s.commit()
            agent_id = await _seed_agent(s, org.id, project1.id)
            await _seed_agent(s, org.id, project2.id)
            for i in range(5):
                s.add(Story(
                    id=uuid.uuid4(), org_id=org.id,
                    project_id=project1.id if i % 2 == 0 else project2.id,
                    title=f"S{i}", status="backlog",
                ))
            await s.commit()

        async with Session() as s:
            repo = StoryRepository(s, org.id)
            org_query_count = 0
            project_query_count = 0

            def _before_cursor_execute(conn, cursor, statement, parameters, context, executemany):
                nonlocal org_query_count, project_query_count
                low = statement.lower()
                if "from organizations" in low and "slug" in low:
                    org_query_count += 1
                if "from projects" in low and "slug" in low and " in " in low:
                    project_query_count += 1

            event.listen(engine.sync_engine, "before_cursor_execute", _before_cursor_execute)
            try:
                listed = await list_stories(
                    project_id=None, epic_id=None, sprint_id=None, assignee_id=None,
                    status_filter=None, no_sprint=False, unattached=False, ids=None,
                    story_number=None, q=None, boost_candidates_from=None, limit=1000,
                    cursor=None, response=None, repo=repo, auth=_auth(agent_id, org.id),
                )
            finally:
                event.remove(engine.sync_engine, "before_cursor_execute", _before_cursor_execute)

            assert len(listed) == 5
            assert all(st.project_slug in ("proj-one", "proj-two") for st in listed)
            assert org_query_count == 1, f"org_slug 쿼리 {org_query_count}회(N+1 의심)"
            assert project_query_count == 1, f"project_slug 배치쿼리 {project_query_count}회(N+1 의심)"
    finally:
        await engine.dispose()


# ── Goal axis ────────────────────────────────────────────────────────────────
async def test_goal_get_carries_org_project_slug():
    from app.repositories.goal import GoalRepository
    from app.routers.goals import get_goal
    from app.models.pm import Goal

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org, project = await _seed_org_project(s, project_slug="goal-proj")
            agent_id = await _seed_agent(s, org.id, project.id)
            goal = Goal(id=uuid.uuid4(), org_id=org.id, project_id=project.id, title="G")
            s.add(goal)
            await s.commit()

            repo = GoalRepository(s, org.id)
            result = await get_goal(id=goal.id, repo=repo, auth=_auth(agent_id, org.id))
            assert result.org_slug == org.slug
            assert result.project_slug == "goal-proj"
    finally:
        await engine.dispose()


# ── Task axis ────────────────────────────────────────────────────────────────
async def test_task_get_resolves_project_id_via_story_and_carries_slug():
    from app.models.pm import Story, Task
    from app.repositories.task import TaskRepository
    from app.routers.tasks import get_task

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org, project = await _seed_org_project(s, project_slug="task-proj")
            agent_id = await _seed_agent(s, org.id, project.id)
            story = Story(id=uuid.uuid4(), org_id=org.id, project_id=project.id, title="S", status="backlog")
            s.add(story)
            await s.commit()
            task = Task(id=uuid.uuid4(), org_id=org.id, story_id=story.id, title="T")
            s.add(task)
            await s.commit()

            repo = TaskRepository(s, org.id)
            result = await get_task(id=task.id, repo=repo, auth=_auth(agent_id, org.id), org_id=org.id)
            assert result.project_id == project.id
            assert result.org_slug == org.slug
            assert result.project_slug == "task-proj"
    finally:
        await engine.dispose()


# ── Sprint axis ──────────────────────────────────────────────────────────────
async def test_sprint_get_carries_org_project_slug():
    from app.models.pm import Sprint
    from app.repositories.sprint import SprintRepository
    from app.routers.sprints import get_sprint

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org, project = await _seed_org_project(s, project_slug="sprint-proj")
            agent_id = await _seed_agent(s, org.id, project.id)
            sprint = Sprint(id=uuid.uuid4(), org_id=org.id, project_id=project.id, title="Sp1")
            s.add(sprint)
            await s.commit()

            repo = SprintRepository(s, org.id)
            result = await get_sprint(id=sprint.id, repo=repo, auth=_auth(agent_id, org.id))
            assert result.org_slug == org.slug
            assert result.project_slug == "sprint-proj"
    finally:
        await engine.dispose()


# ── Evidence axis ────────────────────────────────────────────────────────────
async def test_evidence_get_carries_org_project_slug():
    from app.models.evidence import Evidence
    from app.models.pm import Story
    from app.routers.evidence import get_evidence

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org, project = await _seed_org_project(s, project_slug="ev-proj")
            agent_id = await _seed_agent(s, org.id, project.id)
            story = Story(id=uuid.uuid4(), org_id=org.id, project_id=project.id, title="S", status="backlog")
            s.add(story)
            await s.commit()
            evidence = Evidence(
                id=uuid.uuid4(), org_id=org.id, work_item_id=story.id, work_item_type="story",
                type="pr", ref="https://example.com/pr/1", created_by=agent_id,
            )
            s.add(evidence)
            await s.commit()

            result = await get_evidence(id=evidence.id, session=s, org_id=org.id, auth=_auth(agent_id, org.id))
            assert result.resolved_story_id == story.id
            assert result.org_slug == org.slug
            assert result.project_slug == "ev-proj"
    finally:
        await engine.dispose()


# ── Artifact axis ────────────────────────────────────────────────────────────
async def test_artifact_get_carries_own_org_project_slug_no_parent_hop():
    """create_artifact/get_artifact를 직접 호출(다른 축과 동형) — story #2708(2026-08-17)로
    `_write_scope_check: Depends(get_verified_org_id)`가 `scope: dict = Depends(get_scope_context)`
    로 교체됨에 따라, 실 DI 그래프 밖에서 그 dict를 그대로 넘겨 우회(HTTP 라운드트립의
    bearer-key 해소 복잡도 불필요 — 이 스토리 스코프는 slug 부착 로직 검증이지 인증 배선
    자체가 아니다)."""
    from app.models.visual_artifact import VisualArtifact
    from app.routers.visual_artifacts import CreateArtifactRequest, create_artifact, get_artifact
    from app.schemas.visual_artifact import ArtifactNodeIn

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org, project = await _seed_org_project(s, project_slug="art-proj")
            agent_id = await _seed_agent(s, org.id, project.id)

            auth = _auth(agent_id, org.id)
            auth.claims["app_metadata"]["project_id"] = str(project.id)
            scope = {"org_id": org.id, "project_id": project.id, "user_id": auth.user_id}

            create_resp = await create_artifact(
                body=CreateArtifactRequest(
                    title="Diagram", source="created",
                    nodes=[ArtifactNodeIn(type="text", props={"content": "hi"})],
                ),
                auth=auth, session=s, scope=scope,
            )
            import json
            artifact_id = uuid.UUID(json.loads(create_resp.body)["data"]["id"])

            get_resp = await get_artifact(id=artifact_id, auth=auth, scope=scope, session=s)
            body = json.loads(get_resp.body)["data"]
            assert body["org_slug"] == org.slug
            assert body["project_slug"] == "art-proj"
    finally:
        await engine.dispose()


# ── Storage asset axis ────────────────────────────────────────────────────────
async def test_asset_list_and_get_carry_org_project_slug_and_handle_nullable_project():
    from app.models.asset import Asset
    from app.routers.assets import get_asset, list_assets

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org, project = await _seed_org_project(s, project_slug="asset-proj")
            agent_id = await _seed_agent(s, org.id, project.id)
            asset_with_project = Asset(
                id=uuid.uuid4(), org_id=org.id, project_id=project.id, folder_id=None,
                container="uploads", object_path="a/b.png", name="b.png",
                content_type="image/png", size_bytes=10,
            )
            asset_no_project = Asset(
                id=uuid.uuid4(), org_id=org.id, project_id=None, folder_id=None,
                container="uploads", object_path="a/c.png", name="c.png",
                content_type="image/png", size_bytes=10,
            )
            s.add_all([asset_with_project, asset_no_project])
            await s.commit()

            page = await list_assets(
                project_id=None, folder_id=None, mime=None, q=None, sort="date", order="desc",
                cursor=None, limit=50, db=s, auth=_auth(agent_id, org.id), org_id=org.id,
            )
            by_id = {item.id: item for item in page.items}
            assert by_id[asset_with_project.id].org_slug == org.slug
            assert by_id[asset_with_project.id].project_slug == "asset-proj"
            assert by_id[asset_no_project.id].project_slug is None

            single = await get_asset(
                asset_id=str(asset_with_project.id), db=s, auth=_auth(agent_id, org.id), org_id=org.id,
            )
            assert single.org_slug == org.slug
            assert single.project_slug == "asset-proj"
    finally:
        await engine.dispose()
