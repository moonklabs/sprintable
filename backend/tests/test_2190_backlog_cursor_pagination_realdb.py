"""story #2190(2026-07-25, 까심군 QA 적발) — 실 PG.

#2188 조사 당시 「no_sprint 분기의 cursor는 콜러 0」이라 스코프 밖으로 뺐던 판정이 틀렸다 —
`sprints-client.tsx:460`의 "백로그 더 보기"가 `/api/stories/backlog?...&cursor=`로 이
분기(`no_sprint`+`project_id`)를 실제로 타는데, `list_backlog()`가 cursor를 받지 않고
ORDER BY도 없어 #2189(제네릭 분기)와 동일한 "커서를 바꿔도 같은 페이지가 반복" 증상이
났다(dedup 없는 append로 중복 누적).

#2189/#2490과 완전 동형 처방: `created_at DESC` + `id DESC`(2차 정렬키) + `cursor` WHERE.
"""
from __future__ import annotations

import os
import uuid
from datetime import datetime, timedelta, timezone

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


async def _seed_backlog(session, n: int):
    """전부 sprint_id=None(backlog 조건). #2189와 동일하게 1초씩 벌린 created_at."""
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

    base_ts = datetime.now(timezone.utc)
    story_ids: list[uuid.UUID] = []
    for i in range(n):
        s = Story(
            id=uuid.uuid4(), org_id=org.id, project_id=project.id, sprint_id=None,
            title=f"S{i:02d}", status="backlog", story_number=i + 1,
            created_at=base_ts - timedelta(seconds=n - i),
        )
        session.add(s)
        story_ids.append(s.id)
    await session.commit()

    return {
        "org_id": org.id, "project_id": project.id, "agent_id": agent.id,
        "story_ids_oldest_first": story_ids,
    }


async def _seed_backlog_tied(session, n_tied: int):
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

    tied_ts = datetime.now(timezone.utc)
    story_ids: list[uuid.UUID] = []
    for i in range(n_tied):
        s = Story(
            id=uuid.uuid4(), org_id=org.id, project_id=project.id, sprint_id=None,
            title=f"T{i:02d}", status="backlog", story_number=i + 1, created_at=tied_ts,
        )
        session.add(s)
        story_ids.append(s.id)
    await session.commit()

    return {"org_id": org.id, "project_id": project.id, "agent_id": agent.id, "story_ids": story_ids}


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


async def test_backlog_cursor_advances_to_next_page_no_overlap():
    """⭐본체 — sprints-client.tsx:460이 실제로 쓰는 조합(project_id+no_sprint). FE
    over-fetch 패턴(limit+1) 그대로: 21건 요청 → 20건 표시분의 마지막 created_at을
    cursor로 다음 페이지 요청 → 남은 5건이 겹침 없이 와야 한다."""
    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            seeded = await _seed_backlog(s, n=25)
        async with Session() as s:
            page1 = await _call_list_stories(
                s, seeded["org_id"], seeded["agent_id"],
                project_id=seeded["project_id"], no_sprint=True, limit=21,
            )
        assert len(page1) == 21
        page1_shown = page1[:20]
        next_cursor = page1_shown[-1].created_at.isoformat()
        page1_ids = {r.id for r in page1_shown}

        async with Session() as s:
            page2 = await _call_list_stories(
                s, seeded["org_id"], seeded["agent_id"],
                project_id=seeded["project_id"], no_sprint=True, limit=21, cursor=next_cursor,
            )
        page2_ids = {r.id for r in page2}

        assert len(page2) == 5, f"25건 중 20건 이미 봤으면 남은 5건이어야 — 실제 {len(page2)}건"
        assert page1_ids.isdisjoint(page2_ids), (
            f"페이지 간 겹침 — cursor가 무시됐을 때의 그 증상. 겹친 것={page1_ids & page2_ids}"
        )

        # AC3(오르테가군 요구, #2189와 동형) — hasMore=false 명시 확認.
        fe_original_limit = 20
        assert (len(page2) > fe_original_limit) is False
    finally:
        await engine.dispose()


async def test_backlog_deterministic_order_created_at_desc():
    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            seeded = await _seed_backlog(s, n=10)
        async with Session() as s:
            result = await _call_list_stories(
                s, seeded["org_id"], seeded["agent_id"],
                project_id=seeded["project_id"], no_sprint=True, limit=100,
            )
        assert [r.id for r in result] == list(reversed(seeded["story_ids_oldest_first"]))
    finally:
        await engine.dispose()


async def test_backlog_no_cursor_unspecified_no_regression():
    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            seeded = await _seed_backlog(s, n=25)
        async with Session() as s:
            result = await _call_list_stories(
                s, seeded["org_id"], seeded["agent_id"],
                project_id=seeded["project_id"], no_sprint=True, limit=10,
            )
        assert len(result) == 10
        assert [r.id for r in result] == list(reversed(seeded["story_ids_oldest_first"]))[:10]
    finally:
        await engine.dispose()


async def test_backlog_tied_created_at_order_is_deterministic_across_repeated_queries():
    """#2189/#2490과 동형 — 까심군이 짚은 동률 구간 정렬 비결정성이 이 분기에도 있었을
    자리라 같은 축으로 고정한다."""
    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            seeded = await _seed_backlog_tied(s, n_tied=10)

        orders: list[list[uuid.UUID]] = []
        for _ in range(5):
            async with Session() as s:
                result = await _call_list_stories(
                    s, seeded["org_id"], seeded["agent_id"],
                    project_id=seeded["project_id"], no_sprint=True, limit=100,
                )
            orders.append([r.id for r in result])

        assert all(o == orders[0] for o in orders), (
            f"동률 구간 정렬이 반복 실행마다 달라짐(비결정적) — {orders}"
        )
        assert orders[0] == sorted(seeded["story_ids"], reverse=True)
    finally:
        await engine.dispose()


async def test_backlog_tied_created_at_cursor_pagination_no_duplicate_across_pages():
    """⚠️ "스킵 없음"이 아니라 "중복 없음"을 증명 — #2189와 동일한 무너지는 조건을 승인."""
    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            seeded = await _seed_backlog_tied(s, n_tied=10)
        async with Session() as s:
            page1 = await _call_list_stories(
                s, seeded["org_id"], seeded["agent_id"],
                project_id=seeded["project_id"], no_sprint=True, limit=6,
            )
        assert len(page1) == 6
        page1_ids = {r.id for r in page1}
        next_cursor = page1[-1].created_at.isoformat()

        async with Session() as s:
            page2 = await _call_list_stories(
                s, seeded["org_id"], seeded["agent_id"],
                project_id=seeded["project_id"], no_sprint=True, limit=6, cursor=next_cursor,
            )
        page2_ids = {r.id for r in page2}

        assert page1_ids.isdisjoint(page2_ids), (
            f"동률 경계에서 페이지 간 중복 전달 — 겹친 것={page1_ids & page2_ids}"
        )
    finally:
        await engine.dispose()


# ── 이 방법으로 안 닿는 것 — #2189/#2490과 동형으로 명시 ──
#
# 1. 렌더 층(sprints-client.tsx의 dedup 없는 append가 사용자 눈에 실제로 중복돼 보이는지)은
#    코드 대조로만 확認했다 — 브라우저로 픽셀을 본 적은 없다.
# 2. 로컬 pg16 단일 인스턴스·소규모(<30건) 시드 기준 — prod/dev 규모 차이는 안 보인다.
# 3. hasMore 계산은 `buildCursorPageMeta` 공식을 Python으로 복제한 것이지 실제 TS 함수를
#    호출한 게 아니다 — FE 공식이 바뀌면 이 백엔드 테스트는 조용히 낡을 수 있다.
# 4. 동률 커서 경계에서의 스킵(중복은 아님)은 이론상 남는 한계 — cursor가 created_at
#    단일값 계약이라 서버 혼자 복합 커서로 못 바꾼다. 실제 관측되면 승격.
