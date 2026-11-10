"""story #4833 — 스프린트 패널 «스프린트에 안 든 장» 목록의 쪽 넘김. 실 PG.

예전엔 웹 프록시가 status=backlog를 박아, 진행 중으로 바꾼 장이 목록에서 사라졌다. 이제 프록시는 status가 없으면
no_sprint + exclude_status=done으로 보내고, 이 분기가 쪽 넘김(커서 `<시각>|<id>`)을 한다.
같은 시각에 만들어진 장이 쪽 사이에서 빠지거나 겹치면 안 된다 — 한 트랜잭션으로 넣은 장들은 created_at이 같다(now()).
"""
from __future__ import annotations

import os
import uuid
from unittest.mock import MagicMock

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
    from app.models.pm import Sprint, Story
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

    # 한 번의 commit → created_at이 전부 같다(트랜잭션 시작 시각). 진행 중 · 리뷰 중 · 대기 섞음 + 끝난 장 하나.
    stories = [
        Story(id=uuid.uuid4(), org_id=org.id, project_id=project.id, title=f"S{i}", status=st, story_number=i + 1)
        for i, st in enumerate(["backlog", "in-progress", "in-review", "ready-for-dev", "in-progress", "done"])
    ]
    session.add_all(stories)
    # a story that is NOT done but already sits in a sprint — the «not in a sprint» list must leave it out
    sprint = Sprint(id=uuid.uuid4(), org_id=org.id, project_id=project.id, title="Sprint")
    session.add(sprint)
    await session.commit()
    in_sprint = Story(
        id=uuid.uuid4(), org_id=org.id, project_id=project.id, title="InSprint", status="in-progress", story_number=99,
        sprint_id=sprint.id,
    )
    session.add(in_sprint)
    await session.commit()
    return {
        "org_id": org.id, "project_id": project.id, "agent_id": agent.id,
        "ids": [s.id for s in stories], "done_id": stories[-1].id, "in_progress_id": stories[1].id, "in_sprint_id": in_sprint.id,
    }


async def _list(session, seeded, **kwargs):
    from app.repositories.story import StoryRepository
    from app.routers.stories import list_stories

    repo = StoryRepository(session, seeded["org_id"])
    params = dict(
        project_id=seeded["project_id"], epic_id=None, sprint_id=None, assignee_id=None,
        status_filter=None, no_sprint=True, exclude_status="done", ids=None,
        story_number=None, q=None, limit=1000, cursor=None, response=None,
    )
    params.update(kwargs)
    response = MagicMock()
    response.headers = {}
    params["response"] = response
    rows = await list_stories(repo=repo, auth=_auth(seeded["agent_id"]), **params)
    return rows, response.headers


async def test_in_progress_stories_stay_in_the_no_sprint_list():
    """⭐결함 본체 — 진행 중 · 리뷰 중 장도 «스프린트에 안 든 장» 목록에 남고, 끝난 장만 빠진다."""
    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            seeded = await _seed(s)
        async with Session() as s:
            rows, _ = await _list(s, seeded)
        got = {r.id for r in rows}
        assert seeded["in_progress_id"] in got
        assert seeded["done_id"] not in got
        assert seeded["in_sprint_id"] not in got, "a story already in a sprint is not «not in a sprint»"
        assert got == set(seeded["ids"]) - {seeded["done_id"]}
        # same created_at → ordered by id (the order the cursor walks)
        assert [r.id for r in rows] == sorted(got)
    finally:
        await engine.dispose()


async def test_paging_by_cursor_neither_drops_nor_repeats_stories_created_at_the_same_instant():
    """⭐쪽 넘김 — limit 2로 커서를 따라 끝까지 가면 5장이 한 번씩만 나온다(전부 created_at이 같은 장)."""
    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            seeded = await _seed(s)
        seen: list[uuid.UUID] = []
        cursor = None
        pages = 0
        for _ in range(10):  # 무한 루프 방지 상한
            async with Session() as s:
                rows, headers = await _list(s, seeded, limit=2, cursor=cursor)
            assert rows, "a page after the last one was asked for — the previous page offered a cursor it should not have"
            pages += 1
            seen.extend(r.id for r in rows)
            assert headers["X-Total-Count"] == "5"  # 쪽마다 같은 전체 수(커서 적용 전 개수)
            assert len(rows) <= 2
            cursor = headers.get("X-Next-Cursor")
            if cursor is None:
                break
            assert "|" in cursor and "+" in cursor  # `<iso with +00:00>|<id>` — what the web has to URL-encode
        assert pages == 3, "5 stories at 2 per page = 2 + 2 + 1"
        assert len(seen) == len(set(seen)), "같은 장이 두 쪽에 나왔다"
        assert seen == sorted(seen), "pages follow the order"
        assert set(seen) == set(seeded["ids"]) - {seeded["done_id"]}, "빠진 장이 있다"
    finally:
        await engine.dispose()


async def test_a_last_page_that_is_exactly_the_limit_long_offers_no_cursor():
    """5 stories, limit 5 → one full page and nothing after it: no X-Next-Cursor (the web would otherwise show «더 보기» for an empty page)."""
    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            seeded = await _seed(s)
        async with Session() as s:
            rows, headers = await _list(s, seeded, limit=5)
        assert len(rows) == 5
        assert "X-Next-Cursor" not in headers
        async with Session() as s:
            rows4, headers4 = await _list(s, seeded, limit=4)
        assert len(rows4) == 4
        assert headers4["X-Next-Cursor"].endswith(str(rows4[-1].id))  # one more exists → the cursor is the 4th story's
    finally:
        await engine.dispose()


async def test_a_bare_iso_cursor_is_accepted_and_a_garbled_one_is_a_400():
    from fastapi import HTTPException

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            seeded = await _seed(s)
        async with Session() as s:
            rows_after, _ = await _list(s, seeded, cursor="2999-01-01T00:00:00+00:00")  # time only — taken: nothing is after it
        assert rows_after == []
        async with Session() as s:
            rows_before, _ = await _list(s, seeded, cursor="1970-01-01T00:00:00+00:00")  # time only, long ago — everything is after it
        assert len(rows_before) == 5
        for bad in ("2026-01-01T00:00:00+00:00|not-a-uuid", "|" + str(uuid.uuid4()), "not-a-time|" + str(uuid.uuid4())):
            async with Session() as s:
                with pytest.raises(HTTPException) as caught:
                    await _list(s, seeded, cursor=bad)
            assert caught.value.status_code == 400, bad
    finally:
        await engine.dispose()
