"""story #2619(페드루 판정, 2026-08-14) — search_stories(제목 검색)가 다어순 쿼리에 0건을
내던 결함 fix. `app/repositories/story.py::_title_search_filter`가 list()/list_board()/
list_backlog() 3곳이 공유하는 단일 판정 로직(오늘의 3사본=내일의 드리프트, PO 조건①)이고,
공백 토큰화 + AND 결합(OR 아님 — PO 조건 확인)이다.

양성대조 = 선생님의 실 실패 예시 그대로(조건②): "무인간 대화 체인 게이트"(어순 반대)가
#2617류 제목("체인 게이트의 «무인간 대화» ...")을 찾아야 한다. 음성대조 = 제목에 없는
토큰이 하나라도 섞이면 0건(AND 의미 고정)."""
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

    # #2617 실 제목의 어순을 그대로 재현 — "무인간 대화"가 "체인 게이트" *뒤*에 온다.
    story_chain_gate = Story(
        id=uuid.uuid4(), org_id=org.id, project_id=project.id, status="backlog",
        title="[P1 후속] 체인 게이트의 «무인간 대화» 처리 재설계 — DM 예외만으론 반쪽",
    )
    story_unrelated = Story(
        id=uuid.uuid4(), org_id=org.id, project_id=project.id, status="backlog",
        title="Dashboard widget refresh",
    )
    session.add_all([story_chain_gate, story_unrelated])
    await session.commit()

    return {
        "org_id": org.id, "project_id": project.id, "agent_id": agent.id,
        "story_chain_gate": story_chain_gate.id, "story_unrelated": story_unrelated.id,
    }


async def _call_list_stories(session, org_id, agent_id, **kwargs):
    from app.repositories.story import StoryRepository
    from app.routers.stories import list_stories

    repo = StoryRepository(session, org_id)
    params = dict(
        project_id=None, epic_id=None, sprint_id=None, assignee_id=None,
        status_filter=None, no_sprint=False, ids=None, story_number=None, q=None, limit=1000,
        cursor=None, response=None,
    )
    params.update(kwargs)
    return await list_stories(repo=repo, auth=_auth(agent_id), **params)


async def test_word_order_reversed_query_still_matches_po_real_failure_example():
    """양성대조(조건②) — 선생님의 실 실패 쿼리 "무인간 대화 체인 게이트"가 이제 매치된다."""
    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            seeded = await _seed(s)
        async with Session() as s:
            result = await _call_list_stories(
                s, seeded["org_id"], seeded["agent_id"], q="무인간 대화 체인 게이트",
            )
            assert {r.id for r in result} == {seeded["story_chain_gate"]}
    finally:
        await engine.dispose()


async def test_missing_token_yields_zero_results_and_semantics():
    """음성대조(조건②) — 제목에 없는 토큰이 하나라도 섞이면 0건(AND 의미 고정, OR 아님)."""
    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            seeded = await _seed(s)
        async with Session() as s:
            result = await _call_list_stories(
                s, seeded["org_id"], seeded["agent_id"], q="무인간 대화 존재하지않는토큰",
            )
            assert result == []
    finally:
        await engine.dispose()


async def test_all_matching_tokens_any_order_match():
    """토큰 전부가 제목에 있으면 순서 무관 매치 — 부분(1개만)은 매치 안 됨을 대조로 확인."""
    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            seeded = await _seed(s)
        async with Session() as s:
            full = await _call_list_stories(s, seeded["org_id"], seeded["agent_id"], q="게이트 무인간")
            assert {r.id for r in full} == {seeded["story_chain_gate"]}

            partial_with_unrelated_token = await _call_list_stories(
                s, seeded["org_id"], seeded["agent_id"], q="게이트 대시보드",
            )
            assert partial_with_unrelated_token == []
    finally:
        await engine.dispose()


async def test_whitespace_only_query_falls_back_to_no_filter():
    """토큰이 하나도 안 남는 경계(공백뿐인 q) — 무필터 폴백(에러도 0건도 아님)."""
    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            seeded = await _seed(s)
        async with Session() as s:
            result = await _call_list_stories(s, seeded["org_id"], seeded["agent_id"], q="   ")
            returned_ids = {r.id for r in result}
            assert returned_ids == {seeded["story_chain_gate"], seeded["story_unrelated"]}
    finally:
        await engine.dispose()


async def test_list_board_uses_same_tokenized_and_match():
    """PO 조건① — list_board()도 같은 헬퍼를 써서 동일 회귀가 재발하지 않는다."""
    from app.repositories.story import StoryRepository

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            seeded = await _seed(s)
        async with Session() as s:
            repo = StoryRepository(s, seeded["org_id"])
            stories, total = await repo.list_board(
                project_id=seeded["project_id"], status="backlog", q_text="무인간 대화 체인 게이트",
            )
            assert {st.id for st in stories} == {seeded["story_chain_gate"]}
            assert total == 1
    finally:
        await engine.dispose()


async def test_list_backlog_uses_same_tokenized_and_match():
    """PO 조건① — list_backlog()도 같은 헬퍼를 써서 동일 회귀가 재발하지 않는다."""
    from app.repositories.story import StoryRepository

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            seeded = await _seed(s)
        async with Session() as s:
            repo = StoryRepository(s, seeded["org_id"])
            stories = await repo.list_backlog(
                project_id=seeded["project_id"], q="무인간 대화 체인 게이트",
            )
            assert {st.id for st in stories} == {seeded["story_chain_gate"]}
    finally:
        await engine.dispose()
