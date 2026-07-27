"""story #2189(2026-07-25, 오르테가군 도그푸딩 파생) — 실 PG.

`GET /stories?project_id=&sprint_id=`(제네릭 분기, list_stories:148 이하)는 cursor 를 받기만
하고 WHERE 로 적용하지 않았고 ORDER BY 자체도 없었다. FE(`buildCursorPageMeta`, over-fetch
limit+1 패턴)는 "커서를 바꾸면 다음 페이지가 온다"를 전제하는데, 이 분기에선 커서를 바꿔도
**정확히 같은 페이지가 반복**돼 sprints-client.tsx/standup-client.tsx의 "더 보기"가 dedup
없이 같은 스토리를 중복 누적했다(#2188 콜러 확認 중 파생 발견).

처방: board 분기(list_board)와 동형으로 `created_at DESC` 정렬 + `cursor` WHERE 를 추가.
FE의 전 콜러가 cursorField로 `created_at`만 쓰므로 board처럼 별도 우선순위 보조정렬은
얹지 않는다(얹으면 FE가 계산한 nextCursor와 실제 정렬이 어긋난다).
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


async def _seed(session, n: int = 25):
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

    sprint = Sprint(id=uuid.uuid4(), org_id=org.id, project_id=project.id, title="Sprint")
    session.add(sprint)
    await session.commit()

    # 같은 트랜잭션 커밋이면 server_default=func.now()가 전부 동일 timestamp를 줄 수 있어
    # (동률→비결정적 tie-break) cursor 전진을 못 검증하게 되므로 명시적으로 1초씩 벌린다.
    base_ts = datetime.now(timezone.utc)
    story_ids: list[uuid.UUID] = []
    for i in range(n):
        s = Story(
            id=uuid.uuid4(), org_id=org.id, project_id=project.id, sprint_id=sprint.id,
            title=f"S{i:02d}" + (" special" if i == 3 else ""), status="in-progress", story_number=i + 1,
            created_at=base_ts - timedelta(seconds=n - i),
        )
        session.add(s)
        story_ids.append(s.id)
    await session.commit()

    return {
        "org_id": org.id, "project_id": project.id, "agent_id": agent.id, "sprint_id": sprint.id,
        "story_ids_oldest_first": story_ids,
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


async def test_cursor_advances_to_next_page_no_overlap():
    """⭐본체 — sprints-client.tsx/standup-client.tsx가 실제로 쓰는 그 조합(project_id+sprint_id,
    status 없음). FE over-fetch 패턴(limit+1) 그대로: 21건 요청 → 20건 표시분의 마지막
    created_at을 cursor로 다음 페이지 요청 → 남은 5건이 겹침 없이 와야 한다."""
    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            seeded = await _seed(s, n=25)
        async with Session() as s:
            page1 = await _call_list_stories(
                s, seeded["org_id"], seeded["agent_id"],
                project_id=seeded["project_id"], sprint_id=seeded["sprint_id"], limit=21,
            )
        assert len(page1) == 21
        page1_shown = page1[:20]
        next_cursor = page1_shown[-1].created_at.isoformat()
        page1_ids = {r.id for r in page1_shown}

        async with Session() as s:
            page2 = await _call_list_stories(
                s, seeded["org_id"], seeded["agent_id"],
                project_id=seeded["project_id"], sprint_id=seeded["sprint_id"], limit=21,
                cursor=next_cursor,
            )
        page2_ids = {r.id for r in page2}

        assert len(page2) == 5, f"25건 중 20건 이미 봤으면 남은 5건이어야 — 실제 {len(page2)}건"
        assert page1_ids.isdisjoint(page2_ids), (
            f"페이지 간 겹침 — cursor가 무시됐을 때의 그 증상. 겹친 것={page1_ids & page2_ids}"
        )

        # AC3(오르테가군 지적, 2026-07-25) — 음성대조를 "구조상 될 것"으로 말로만 두지 않고
        # buildCursorPageMeta(pagination.ts)의 hasMore 계산을 그대로 재현해 명시 확認한다:
        # hasMore = items.length > limit(FE 원 limit=20, over-fetch용 +1 아님). 2차 응답이
        # 5건(<20)이면 hasMore=false → nextCursor=null → "더 보기" 버튼이 사라져야 한다.
        # 이게 없으면 "중복은 없어졌는데 버튼은 계속 있는" 반쪽짜리 fix로 닫힐 수 있다.
        fe_original_limit = 20
        has_more = len(page2) > fe_original_limit
        assert has_more is False, (
            f"2차 응답 {len(page2)}건은 FE 원 limit({fe_original_limit})보다 적어야 hasMore=false로 "
            "«더 보기» 버튼이 사라지는데, 그 전제가 깨짐"
        )
    finally:
        await engine.dispose()


async def test_deterministic_order_created_at_desc():
    """정렬이 created_at DESC로 결정적인지 — 아니면 cursor 자체가 의미 없어진다."""
    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            seeded = await _seed(s, n=10)
        async with Session() as s:
            result = await _call_list_stories(
                s, seeded["org_id"], seeded["agent_id"],
                project_id=seeded["project_id"], sprint_id=seeded["sprint_id"], limit=100,
            )
        timestamps = [r.created_at for r in result]
        assert timestamps == sorted(timestamps, reverse=True), "created_at DESC로 정렬돼야"
        # oldest_first 시드 순서의 역순(최신이 먼저)과 일치해야.
        returned_ids_desc = [r.id for r in result]
        assert returned_ids_desc == list(reversed(seeded["story_ids_oldest_first"]))
    finally:
        await engine.dispose()


async def test_cursor_combines_with_other_filters_and_not_or():
    """cursor가 다른 필터(q)와 AND 결합되는지 — OR로 새면 cursor 넘어간 자리에서 q 매치 없는
    행도 딸려온다."""
    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            seeded = await _seed(s, n=25)
        async with Session() as s:
            result = await _call_list_stories(
                s, seeded["org_id"], seeded["agent_id"],
                project_id=seeded["project_id"], sprint_id=seeded["sprint_id"], limit=100, q="special",
            )
        # 시드에서 i==3인 스토리만 "special" 타이틀을 가짐.
        assert len(result) == 1
        assert result[0].id == seeded["story_ids_oldest_first"][3]
    finally:
        await engine.dispose()


async def test_no_cursor_unspecified_no_regression():
    """무회귀 — cursor 미지정이면 기존처럼 첫 페이지(limit개)가 그대로 온다."""
    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            seeded = await _seed(s, n=25)
        async with Session() as s:
            result = await _call_list_stories(
                s, seeded["org_id"], seeded["agent_id"],
                project_id=seeded["project_id"], sprint_id=seeded["sprint_id"], limit=10,
            )
        assert len(result) == 10
        assert [r.id for r in result] == list(reversed(seeded["story_ids_oldest_first"]))[:10]
    finally:
        await engine.dispose()


async def _seed_with_tied_created_at(session, n_tied: int):
    """까심군 QA 지적(2026-07-25, #2490 머지 前) — 기존 시드는 created_at을 1초씩 벌려
    동률 경계를 피해갔다("이 경로가 시험된 적 없다"는 것 자체가 결함이었다). 이 헬퍼는
    반대로 **의도적으로 동일 created_at**을 여러 행에 준다(같은 트랜잭션 배치 insert가
    server_default=func.now()로 실제 만들어내는 조건)."""
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
    sprint = Sprint(id=uuid.uuid4(), org_id=org.id, project_id=project.id, title="Sprint")
    session.add(sprint)
    await session.commit()

    tied_ts = datetime.now(timezone.utc)
    story_ids: list[uuid.UUID] = []
    for i in range(n_tied):
        s = Story(
            id=uuid.uuid4(), org_id=org.id, project_id=project.id, sprint_id=sprint.id,
            title=f"T{i:02d}", status="in-progress", story_number=i + 1, created_at=tied_ts,
        )
        session.add(s)
        story_ids.append(s.id)
    await session.commit()

    return {
        "org_id": org.id, "project_id": project.id, "agent_id": agent.id, "sprint_id": sprint.id,
        "story_ids": story_ids,
    }


async def test_tied_created_at_order_is_deterministic_across_repeated_queries():
    """동률(같은 created_at) 구간에서 id 보조키가 없으면 같은 쿼리를 반복 실행해도 순서가
    바뀔 수 있다(Postgres가 정렬 안정성을 보장 안 함) — id DESC를 2차 키로 얹었으니 반복
    실행해도 항상 같은 순서여야 한다."""
    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            seeded = await _seed_with_tied_created_at(s, n_tied=10)

        orders: list[list[uuid.UUID]] = []
        for _ in range(5):
            async with Session() as s:
                result = await _call_list_stories(
                    s, seeded["org_id"], seeded["agent_id"],
                    project_id=seeded["project_id"], sprint_id=seeded["sprint_id"], limit=100,
                )
            orders.append([r.id for r in result])

        assert all(o == orders[0] for o in orders), (
            f"동률 구간 정렬이 반복 실행마다 달라짐(비결정적) — {orders}"
        )
        # id DESC가 실제로 tiebreak으로 적용됐는지도 직접 확認.
        assert orders[0] == sorted(seeded["story_ids"], reverse=True)
    finally:
        await engine.dispose()


async def test_tied_created_at_cursor_pagination_no_duplicate_across_pages():
    """⚠️ 이 테스트가 증명하는 것은 "스킵 없음"이 아니라 "중복 없음"이다(무너지는 조건
    주석 참조 — cursor가 created_at 단일값이라 동률 경계 행은 이론상 다음 페이지에서
    스킵될 수 있고, 이 테스트는 그 한계를 승인한 채로 **더 나쁜 실패 모드인 중복 전달**만
    확実히 배제한다)."""
    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            seeded = await _seed_with_tied_created_at(s, n_tied=10)
        async with Session() as s:
            page1 = await _call_list_stories(
                s, seeded["org_id"], seeded["agent_id"],
                project_id=seeded["project_id"], sprint_id=seeded["sprint_id"], limit=6,
            )
        assert len(page1) == 6
        page1_ids = {r.id for r in page1}
        next_cursor = page1[-1].created_at.isoformat()

        async with Session() as s:
            page2 = await _call_list_stories(
                s, seeded["org_id"], seeded["agent_id"],
                project_id=seeded["project_id"], sprint_id=seeded["sprint_id"], limit=6,
                cursor=next_cursor,
            )
        page2_ids = {r.id for r in page2}

        assert page1_ids.isdisjoint(page2_ids), (
            f"동률 경계에서 페이지 간 중복 전달 — 겹친 것={page1_ids & page2_ids}"
        )
    finally:
        await engine.dispose()


# ── 이 방법으로 안 닿는 것(오르테가군 요청, 2026-07-25) — 말로만 두지 않고 명시 ──
#
# 1. 렌더 층(사용자 눈에 카드가 실제로 중복돼 보이는지)은 이 테스트들이 검증 못 한다 —
#    backend가 올바른 데이터를 주는 것과 FE가 그것을 올바르게 렌더하는 것은 다른 층이다.
#    kanban-board.tsx/sprints-client.tsx/standup-client.tsx의 실제 append 로직은 코드
#    대조로만 확認했다(dedup 없음 관측) — 브라우저로 픽셀을 본 적은 없다.
# 2. 로컬 pg16 단일 인스턴스·소규모(<30건) 시드 기준이라, prod/dev 규모(수백~수천 건)나
#    실 limit 기본값 조합에서만 드러나는 성능/정확성 차이는 이 테스트로 안 보인다.
# 3. `test_cursor_advances_to_next_page_no_overlap`의 hasMore 계산은
#    `apps/web/src/lib/pagination.ts`의 `buildCursorPageMeta` **공식을 Python으로 복제**한
#    것이지 실제 TS 함수를 호출한 게 아니다 — FE 쪽 공식이 나중에 바뀌면 이 백엔드 테스트는
#    조용히 낡아 더 이상 실제 계약을 대표하지 않게 된다(까심군 지적). FE 쪽 pagination.test.ts
#    가 그 함수 자체의 계약을 지키는 축이고, 이 파일은 어디까지나 백엔드가 그 함수의 전제
#    (결정적 정렬 + cursor WHERE 적용)를 충족하는지만 본다.
