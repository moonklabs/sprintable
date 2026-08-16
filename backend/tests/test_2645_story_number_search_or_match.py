"""story #2645(미르코 실사용 발견, 2026-08-14) — search_stories(q)가 스토리 «번호»로는
0건이던 결함 fix. 스토리 번호는 제목에 리터럴로 없다(별도 story_number 컬럼)라
title ILIKE만으로는 q="2642" 같은 검색이 구조적으로 항상 0건이었다(#2619 fix 후에도
동일 — 원인 축이 다르다).

`app/repositories/story.py::_title_search_filter`(#2619 SSOT, list()/list_board()/
list_backlog() 3곳 공유 — PO 조건① 승계)를 확장: q(트림 후)가 단일 토큰이고 순수 숫자 또는
`#`+숫자면 title 매치와 story_number 정확 일치를 OR 결합.

양성대조 = 이 스토리 자신(#2645, PO가 재밌는 표본이라 지정) — 제목에 "2645"가 리터럴로
없으므로 OR 없이는 절대 못 찾는다. 조건②(숫자가 제목 토큰으로도 실재하는 케이스)는 OR
의미대로 "두 채널 다 반환, 한쪽이 다른 쪽을 가리지 않는다"로 정의하고 고정."""
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


async def _seed(session, *, second_project: bool = False):
    from app.models.member import Member
    from app.models.organization import Organization
    from app.models.pm import Story
    from app.models.project import Project
    from app.models.project_access import ProjectAccess
    from app.repositories.story import allocate_story_number

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

    # 양성대조 — #2645 자신: 제목에 "2645" 리터럴 없음(PO 지정 표본).
    n1 = await allocate_story_number(session, project.id)
    story_by_number_only = Story(
        id=uuid.uuid4(), org_id=org.id, project_id=project.id, status="backlog",
        title="스토리 «번호» 검색이 0건 — story_number 매치도 결합", story_number=n1,
    )
    session.add(story_by_number_only)
    await session.commit()

    # 조건② — 숫자가 제목 토큰으로도 실재하는 별개 스토리(번호는 다름, 제목에 "2024" 포함).
    n2 = await allocate_story_number(session, project.id)
    story_title_contains_number = Story(
        id=uuid.uuid4(), org_id=org.id, project_id=project.id, status="backlog",
        title="iOS 2024 로드맵 정리", story_number=n2,
    )
    session.add(story_title_contains_number)
    await session.commit()

    # 조건② 대조군 — 실제 story_number가 "2024"인 별개 스토리(제목엔 없음). 채번을 강제로
    # 2024까지 밀어야 하므로 story_number를 직접 지정(allocate_story_number의 순차 채번을
    # 우회 — 테스트 전용 시드, race-safety와 무관).
    story_number_is_2024 = Story(
        id=uuid.uuid4(), org_id=org.id, project_id=project.id, status="backlog",
        title="완전히 무관한 제목", story_number=2024,
    )
    session.add(story_number_is_2024)
    await session.commit()

    result = {
        "org_id": org.id, "project_id": project.id, "agent_id": agent.id,
        "story_by_number_only": story_by_number_only.id,
        "story_by_number_only_number": story_by_number_only.story_number,
        "story_title_contains_number": story_title_contains_number.id,
        "story_number_is_2024": story_number_is_2024.id,
    }

    if second_project:
        # 프로젝트간 번호 재사용 — cross-project 유출 확인용(호출부 스코프가 이 헬퍼를
        # 감싸는지 보는 대조군).
        project2 = Project(id=uuid.uuid4(), org_id=org.id, name="P2")
        session.add(project2)
        await session.commit()
        agent2 = Member(id=uuid.uuid4(), org_id=org.id, type="agent", name="Agent2")
        session.add(agent2)
        await session.commit()
        session.add(ProjectAccess(id=uuid.uuid4(), project_id=project2.id, member_id=agent2.id, permission="granted"))
        await session.commit()
        story_p2_same_number = Story(
            id=uuid.uuid4(), org_id=org.id, project_id=project2.id, status="backlog",
            title="다른 프로젝트의 무관한 제목", story_number=story_by_number_only.story_number,
        )
        session.add(story_p2_same_number)
        await session.commit()
        result["project2_id"] = project2.id
        result["story_p2_same_number"] = story_p2_same_number.id

    return result


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


# ── AC1 양성대조 — 실재 번호가 순수 숫자/#숫자 q로 찾아진다(#2645 자신) ────────────
async def test_bare_number_finds_story_with_no_literal_number_in_title():
    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            seeded = await _seed(s)
        async with Session() as s:
            n = seeded["story_by_number_only_number"]
            result = await _call_list_stories(
                s, seeded["org_id"], seeded["agent_id"],
                project_id=seeded["project_id"], q=str(n),
            )
            assert {r.id for r in result} == {seeded["story_by_number_only"]}
    finally:
        await engine.dispose()


async def test_hash_prefixed_number_also_matches():
    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            seeded = await _seed(s)
        async with Session() as s:
            n = seeded["story_by_number_only_number"]
            result = await _call_list_stories(
                s, seeded["org_id"], seeded["agent_id"],
                project_id=seeded["project_id"], q=f"#{n}",
            )
            assert {r.id for r in result} == {seeded["story_by_number_only"]}
    finally:
        await engine.dispose()


# ── AC2 정의 — 숫자가 제목 토큰으로도 실재하는 케이스: OR라 둘 다 반환(가림 없음) ────
async def test_number_that_is_also_a_title_token_returns_both_channels():
    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            seeded = await _seed(s)
        async with Session() as s:
            result = await _call_list_stories(
                s, seeded["org_id"], seeded["agent_id"],
                project_id=seeded["project_id"], q="2024",
            )
            assert {r.id for r in result} == {
                seeded["story_title_contains_number"], seeded["story_number_is_2024"],
            }
    finally:
        await engine.dispose()


async def test_number_matching_both_title_and_own_number_no_duplicate_row():
    """제목에도 그 숫자가 있고 story_number도 같은 경우 — OR 단일 WHERE라 중복 행 없음."""
    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            from app.models.pm import Story
            seeded = await _seed(s)
            n = seeded["story_by_number_only_number"]
            self_titled = Story(
                id=uuid.uuid4(), org_id=seeded["org_id"], project_id=seeded["project_id"],
                status="backlog", title=f"sprint {n} 회고", story_number=n + 1000,
            )
            # 제목에 자기 번호가 아닌 다른 스토리의 번호(n)를 담아 title-channel 매치를 만들고,
            # 동시에 story_number=n 스토리도 존재 — 두 채널이 같은 행을 가리키지 않는 별도
            # 케이스이므로 각각 정확히 1건씩만 나오는지 확인(중복 없음의 최소 pin).
            s.add(self_titled)
            await s.commit()
            seeded["self_titled"] = self_titled.id
        async with Session() as s:
            result = await _call_list_stories(
                s, seeded["org_id"], seeded["agent_id"],
                project_id=seeded["project_id"], q=str(seeded["story_by_number_only_number"]),
            )
            ids = [r.id for r in result]
            assert len(ids) == len(set(ids))  # 중복 행 없음
            assert set(ids) == {seeded["story_by_number_only"], seeded["self_titled"]}
    finally:
        await engine.dispose()


# ── 경계 — 순수 숫자가 아니면(다중 토큰·숫자+문자 결합) 이 분기가 아예 안 걸린다 ──────
async def test_mixed_alnum_token_does_not_trigger_number_branch():
    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            seeded = await _seed(s)
        async with Session() as s:
            n = seeded["story_by_number_only_number"]
            result = await _call_list_stories(
                s, seeded["org_id"], seeded["agent_id"],
                project_id=seeded["project_id"], q=f"{n}번",
            )
            assert result == []  # 제목에 "…번" 리터럴 없고, 숫자전용 분기도 안 걸림
    finally:
        await engine.dispose()


async def test_multi_token_query_does_not_trigger_number_branch():
    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            seeded = await _seed(s)
        async with Session() as s:
            n = seeded["story_by_number_only_number"]
            result = await _call_list_stories(
                s, seeded["org_id"], seeded["agent_id"],
                project_id=seeded["project_id"], q=f"스토리 {n}",
            )
            assert result == []  # PO 스펙 범위 밖(q가 순수 숫자일 때만) — 추측 확장 없음
    finally:
        await engine.dispose()


# ── PO 조건① — 3곳(list/list_board/list_backlog) 공유 헬퍼 그대로 적용 ─────────────
async def test_list_board_number_search_matches():
    from app.repositories.story import StoryRepository

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            seeded = await _seed(s)
        async with Session() as s:
            repo = StoryRepository(s, seeded["org_id"])
            n = seeded["story_by_number_only_number"]
            stories, total = await repo.list_board(
                project_id=seeded["project_id"], status="backlog", q_text=str(n),
            )
            assert {st.id for st in stories} == {seeded["story_by_number_only"]}
            assert total == 1
    finally:
        await engine.dispose()


async def test_list_backlog_number_search_matches():
    from app.repositories.story import StoryRepository

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            seeded = await _seed(s)
        async with Session() as s:
            repo = StoryRepository(s, seeded["org_id"])
            n = seeded["story_by_number_only_number"]
            stories, _total = await repo.list_backlog(project_id=seeded["project_id"], q=str(n))
            assert {st.id for st in stories} == {seeded["story_by_number_only"]}
    finally:
        await engine.dispose()


# ── project 스코프 — 명시 story_number 파라미터와 동형 특성(호출부 AND가 스코프) ───
async def test_project_scoped_call_does_not_leak_other_project_same_number():
    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            seeded = await _seed(s, second_project=True)
        async with Session() as s:
            n = seeded["story_by_number_only_number"]
            result = await _call_list_stories(
                s, seeded["org_id"], seeded["agent_id"],
                project_id=seeded["project_id"], q=str(n),
            )
            assert {r.id for r in result} == {seeded["story_by_number_only"]}
            assert seeded["story_p2_same_number"] not in {r.id for r in result}
    finally:
        await engine.dispose()
