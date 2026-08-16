"""story #2428 — 실 PG. list_backlog 분기(no_sprint+project_id)가 이제 (stories, total)을
반환해 X-Total-Count에 실 COUNT(limit 適用 前)를 싣는다. 예전엔 이 분기가 total 자체를
안 내(list_backlog()가 list만 반환) MCP sprintable_list_backlog가 「더 있는지」를 알 방법이
없었다 — 카디르가 200건 요청 大비 1000건(자연 상한)까지 조용히 다 실어 320만자 응답을 낸
것도 이 갭의 다른 얼굴. limit truncation이 있어도 X-Total-Count가 len(items)로 위조되지
않고 진짜 전체 건수를 유지하는지가 이 테스트의 본체(test_2233의 goals 대응 테스트와 동형)."""
from __future__ import annotations

import os
import uuid
from unittest.mock import MagicMock

import pytest

_REAL_DB_URL = os.getenv("PARITY_TEST_DATABASE_URL") or os.getenv("ALEMBIC_DATABASE_URL")

pytestmark = [
    pytest.mark.skipif(not _REAL_DB_URL, reason="통합 테스트는 실 PG(PARITY/ALEMBIC_DATABASE_URL) 필요"),
    pytest.mark.anyio,
    pytest.mark.destructive_schema,
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
    from app.core.database import Base
    import app.models  # noqa: F401

    engine = create_async_engine(_async_url())
    async with engine.begin() as conn:
        await conn.run_sync(Base.metadata.create_all)
    return engine, async_sessionmaker(engine, expire_on_commit=False)


def _auth(agent_id: uuid.UUID):
    from app.dependencies.auth import AuthContext
    return AuthContext(user_id=str(agent_id), email=None, claims={"app_metadata": {}})


async def _seed(session, n: int = 3):
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

    story_ids = []
    for i in range(n):
        s = Story(id=uuid.uuid4(), org_id=org.id, project_id=project.id, title=f"S{i}", status="backlog", story_number=i + 1)
        session.add(s)
        story_ids.append(s.id)
    await session.commit()

    return {"org_id": org.id, "project_id": project.id, "agent_id": agent.id, "story_ids": story_ids}


async def _call_list_stories(session, org_id, agent_id, response, **kwargs):
    from app.repositories.story import StoryRepository
    from app.routers.stories import list_stories

    repo = StoryRepository(session, org_id)
    params = dict(
        project_id=None, epic_id=None, sprint_id=None, assignee_id=None,
        status_filter=None, no_sprint=False, ids=None, story_number=None, q=None, limit=1000,
        cursor=None, response=response,
    )
    params.update(kwargs)
    return await list_stories(repo=repo, auth=_auth(agent_id), **params)


async def test_x_total_count_is_real_total_not_page_length_when_truncated():
    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            seeded = await _seed(s, n=3)
        async with Session() as s:
            response = MagicMock()
            response.headers = {}
            result = await _call_list_stories(
                s, seeded["org_id"], seeded["agent_id"], response,
                project_id=seeded["project_id"], no_sprint=True, limit=1,
            )
            assert len(result) == 1, "limit=1이니 페이지는 1건이어야"
            assert response.headers["X-Total-Count"] == "3", (
                f"limit truncation이 있어도 진짜 전체(3)를 실어야: {response.headers}"
            )
    finally:
        await engine.dispose()


async def test_x_total_count_matches_page_when_not_truncated():
    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            seeded = await _seed(s, n=2)
        async with Session() as s:
            response = MagicMock()
            response.headers = {}
            result = await _call_list_stories(
                s, seeded["org_id"], seeded["agent_id"], response,
                project_id=seeded["project_id"], no_sprint=True, limit=1000,
            )
            assert len(result) == 2
            assert response.headers["X-Total-Count"] == "2"
    finally:
        await engine.dispose()
