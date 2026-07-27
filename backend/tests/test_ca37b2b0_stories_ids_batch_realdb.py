"""[E-CANVAS][갤러리 잔여②·BE] story ca37b2b0 — `GET /api/v2/stories?ids=` 배치 앵커 조회. 실 PG.

`BaseRepository.list()`(ORDER BY 없음·별건 d8787fa6)에 기대지 않고 정확한 id 집합을 해소 —
갤러리처럼 특정 스토리들(산출물 앵커)만 필요한 소비자용. 인가 스코프: 접근 못 하는 project의
id가 섞여도 조용히 필터링(유출 0)."""
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
    """org + project_a(agent 접근)/project_b(agent 무접근) + 각 project 스토리 2개씩.

    project_a 스토리는 일부러 과거(오래된 created_at)로 시드 — base.list()의 "첫 N건"이
    최신순이 아님을 알 수 있게(ORDER BY 부재 문제와 무관함을 대조로 보여줌)."""
    from datetime import datetime, timedelta, timezone
    from app.models.member import Member
    from app.models.organization import Organization
    from app.models.pm import Story
    from app.models.project import Project
    from app.models.project_access import ProjectAccess

    org = Organization(id=uuid.uuid4(), name="Org", slug=f"org-{uuid.uuid4().hex[:8]}")
    session.add(org)
    await session.commit()

    project_a = Project(id=uuid.uuid4(), org_id=org.id, name="A")
    project_b = Project(id=uuid.uuid4(), org_id=org.id, name="B")
    session.add_all([project_a, project_b])
    await session.commit()

    agent = Member(id=uuid.uuid4(), org_id=org.id, type="agent", name="Agent")
    session.add(agent)
    await session.commit()
    session.add(ProjectAccess(id=uuid.uuid4(), project_id=project_a.id, member_id=agent.id, permission="granted"))
    await session.commit()

    old_ts = datetime.now(timezone.utc) - timedelta(days=90)
    story_a1 = Story(id=uuid.uuid4(), org_id=org.id, project_id=project_a.id, title="A1", status="backlog", created_at=old_ts)
    story_a2 = Story(id=uuid.uuid4(), org_id=org.id, project_id=project_a.id, title="A2", status="backlog", created_at=old_ts)
    story_b1 = Story(id=uuid.uuid4(), org_id=org.id, project_id=project_b.id, title="B1", status="backlog")
    session.add_all([story_a1, story_a2, story_b1])
    await session.commit()

    return {
        "org_id": org.id, "project_a": project_a.id, "project_b": project_b.id, "agent_id": agent.id,
        "story_a1": story_a1.id, "story_a2": story_a2.id, "story_b1": story_b1.id,
    }


async def _call_list_stories(session, org_id, agent_id, ids_param):
    from app.repositories.story import StoryRepository
    from app.routers.stories import list_stories

    repo = StoryRepository(session, org_id)
    return await list_stories(
        ids=ids_param,
        repo=repo,
        auth=_auth(agent_id),
    )


async def test_ids_batch_returns_exact_set_regardless_of_creation_order():
    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            seeded = await _seed(s)
        async with Session() as s:
            ids_param = f"{seeded['story_a1']},{seeded['story_a2']}"
            result = await _call_list_stories(s, seeded["org_id"], seeded["agent_id"], ids_param)
            returned_ids = {r.id for r in result}
            assert returned_ids == {seeded["story_a1"], seeded["story_a2"]}
    finally:
        await engine.dispose()


async def test_ids_batch_filters_cross_project_ids_silently():
    """접근권 없는 project_b의 story id가 섞여 들어와도 유출 0 — 에러 아닌 조용한 필터링."""
    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            seeded = await _seed(s)
        async with Session() as s:
            ids_param = f"{seeded['story_a1']},{seeded['story_b1']}"
            result = await _call_list_stories(s, seeded["org_id"], seeded["agent_id"], ids_param)
            returned_ids = {r.id for r in result}
            assert returned_ids == {seeded["story_a1"]}  # story_b1은 조용히 빠짐.
    finally:
        await engine.dispose()


async def test_ids_batch_malformed_id_422():
    from fastapi import HTTPException

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            seeded = await _seed(s)
        async with Session() as s:
            with pytest.raises(HTTPException) as exc_info:
                await _call_list_stories(s, seeded["org_id"], seeded["agent_id"], "not-a-uuid")
            assert exc_info.value.status_code == 422
    finally:
        await engine.dispose()


async def test_ids_batch_oversized_422():
    from fastapi import HTTPException

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            seeded = await _seed(s)
        async with Session() as s:
            ids_param = ",".join(str(uuid.uuid4()) for _ in range(201))
            with pytest.raises(HTTPException) as exc_info:
                await _call_list_stories(s, seeded["org_id"], seeded["agent_id"], ids_param)
            assert exc_info.value.status_code == 422
    finally:
        await engine.dispose()


async def test_ids_batch_empty_string_returns_empty_list():
    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            seeded = await _seed(s)
        async with Session() as s:
            result = await _call_list_stories(s, seeded["org_id"], seeded["agent_id"], "")
            assert result == []
    finally:
        await engine.dispose()
