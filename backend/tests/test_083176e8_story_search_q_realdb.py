"""갤러리 스토리 피커 실검색 BE(story 083176e8·까심 #2148 QA 적출) — 실 PG.

`GET /api/v2/stories?q=` — title ILIKE 부분일치, 기존 필터(project_id 등)와 AND 결합.
BaseRepository.list()는 범용 동등비교만 지원해 q ILIKE를 못 얹으므로 StoryRepository.list()를
오버라이드(list_board/list_by_ids와 동형 관례). d8787fa6(ORDER BY 부재)와는 별개 트랙 — 여기선
q 검색 정확성만 검증, 정렬 결정론은 스코프 밖."""
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


def _auth(agent_id: uuid.UUID):
    from app.dependencies.auth import AuthContext
    return AuthContext(user_id=str(agent_id), email=None, claims={"app_metadata": {}})


async def _seed(session):
    from app.models.member import Member
    from app.models.organization import Organization
    from app.models.pm import Story
    from app.models.project import Project
    from app.models.project_access import ProjectAccess

    org = Organization(id=uuid.uuid4(), name="Org", slug=f"org-{uuid.uuid4().hex[:8]}")
    session.add(org)
    await session.commit()

    project = Project(id=uuid.uuid4(), org_id=org.id, name="P")
    session.add(project)
    await session.commit()

    agent = Member(id=uuid.uuid4(), org_id=org.id, type="agent", name="Agent")
    session.add(agent)
    await session.commit()
    session.add(ProjectAccess(id=uuid.uuid4(), project_id=project.id, member_id=agent.id, permission="granted"))
    await session.commit()

    story_login = Story(id=uuid.uuid4(), org_id=org.id, project_id=project.id, title="Login page redesign", status="backlog")
    story_dash = Story(id=uuid.uuid4(), org_id=org.id, project_id=project.id, title="Dashboard widget refresh", status="backlog")
    story_logout = Story(id=uuid.uuid4(), org_id=org.id, project_id=project.id, title="Logout flow cleanup", status="backlog")
    session.add_all([story_login, story_dash, story_logout])
    await session.commit()

    return {
        "org_id": org.id, "project_id": project.id, "agent_id": agent.id,
        "story_login": story_login.id, "story_dash": story_dash.id, "story_logout": story_logout.id,
    }


async def _call_list_stories(session, org_id, agent_id, **kwargs):
    """list_stories를 직접 호출 — FastAPI Query() 기본값은 실제 요청 경유 없인 unwrap 안 되므로
    (라우터 함수를 직접 부르면 Query(...) 객체 그대로 남아 truthy 오판) 관련 파라미터 전부 명시
    None/False로 채운다(test_ca37b2b0가 ids만 명시해도 되던 건 조기 return이라 나머지 분기에
    안 들어가서였을 뿐 — 이 파일은 일반 분기까지 타야 해서 전부 필요)."""
    from app.repositories.story import StoryRepository
    from app.routers.stories import list_stories

    repo = StoryRepository(session, org_id)
    params = dict(
        project_id=None, epic_id=None, sprint_id=None, assignee_id=None,
        status_filter=None, no_sprint=False, ids=None, q=None, limit=1000,
        cursor=None, response=None,
    )
    params.update(kwargs)
    return await list_stories(repo=repo, auth=_auth(agent_id), **params)


async def test_q_full_title_match():
    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            seeded = await _seed(s)
        async with Session() as s:
            result = await _call_list_stories(s, seeded["org_id"], seeded["agent_id"], q="Login page redesign")
            assert {r.id for r in result} == {seeded["story_login"]}
    finally:
        await engine.dispose()


async def test_q_partial_case_insensitive_match():
    """ILIKE 부분일치 — 대소문자 무관, 여러 건 매치("log"가 Login·Logout 둘 다 히트)."""
    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            seeded = await _seed(s)
        async with Session() as s:
            result = await _call_list_stories(s, seeded["org_id"], seeded["agent_id"], q="LOG")
            returned_ids = {r.id for r in result}
            assert returned_ids == {seeded["story_login"], seeded["story_logout"]}
            assert seeded["story_dash"] not in returned_ids
    finally:
        await engine.dispose()


async def test_q_no_match_returns_empty():
    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            seeded = await _seed(s)
        async with Session() as s:
            result = await _call_list_stories(s, seeded["org_id"], seeded["agent_id"], q="nonexistent-xyz")
            assert result == []
    finally:
        await engine.dispose()


async def test_q_unspecified_returns_all_no_regression():
    """무회귀: q 미지정 시 기존 동작 그대로(전체 반환)."""
    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            seeded = await _seed(s)
        async with Session() as s:
            result = await _call_list_stories(s, seeded["org_id"], seeded["agent_id"])
            returned_ids = {r.id for r in result}
            assert returned_ids == {seeded["story_login"], seeded["story_dash"], seeded["story_logout"]}
    finally:
        await engine.dispose()


async def test_q_combined_with_project_id_filter_and_not_or():
    """q와 기존 필터(project_id)가 AND 결합 — 다른 project의 동일 title 매치는 제외."""
    from app.models.pm import Story
    from app.models.project import Project

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            seeded = await _seed(s)
            other_project = Project(id=uuid.uuid4(), org_id=seeded["org_id"], name="Other")
            s.add(other_project)
            await s.commit()
            other_story = Story(
                id=uuid.uuid4(), org_id=seeded["org_id"], project_id=other_project.id,
                title="Login page in other project", status="backlog",
            )
            s.add(other_story)
            await s.commit()

        async with Session() as s:
            result = await _call_list_stories(
                s, seeded["org_id"], seeded["agent_id"], q="Login", project_id=seeded["project_id"],
            )
            returned_ids = {r.id for r in result}
            assert returned_ids == {seeded["story_login"]}
    finally:
        await engine.dispose()
