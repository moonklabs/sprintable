"""story #2188(2026-07-25, 오르테가군 도그푸딩 적발) — 실 PG.

`GET /stories?project_id=&status=`(CB-S4 board 분기, list_stories:130)로 빠지면
epic_id/story_number/q가 조용히 무시돼 **필터를 추가했는데 결과가 5배로 늘어나는**
계약 위반이 났다(51건 → 278건, epic 불일치 97%). sprint_id/assignee_id는 이미
넘어가고 있었고 epic_id/story_number/q만 board 분기에 없었다.

board 분기 자체(cursor·done 7일 제한)는 그대로 두고 list_board()에 세 파라미터만
추가 배선한다. 회귀가드는 개별 파라미터 단위 테스트보다 **불변식**으로 건다 —
"필터를 추가했는데 결과 집합이 늘어나면 실패"(A AND B ⊆ A)가 미래의 같은 종류
결함(다음에 새 필터가 또 이 분기에 안 붙는 경우)까지 잡는다.
"""
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
    from app.models.pm import Goal, Story
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

    epic_a = Goal(id=uuid.uuid4(), org_id=org.id, project_id=project.id, title="Epic A")
    epic_b = Goal(id=uuid.uuid4(), org_id=org.id, project_id=project.id, title="Epic B")
    session.add_all([epic_a, epic_b])
    await session.commit()

    # story #2188 재현 조건: 같은 project·같은 status(backlog)에 epic이 갈리는 스토리들.
    # story_number는 서버(allocate_story_number)만 채번하는 것이 정상 경로지만, 이 테스트는
    # 리포지토리 생성 경로를 안 거치므로(모델 직접 삽입) story_number 필터 검증을 위해
    # 명시적으로 채운다 — None으로 두면 라우터의 "story_number is not None" 가드에 걸려
    # 필터 자체가 적용 안 되고 "전부 통과"가 돼 이 축을 실제로 검증 못 하게 된다.
    s_a1 = Story(id=uuid.uuid4(), org_id=org.id, project_id=project.id, epic_id=epic_a.id, title="A1", status="backlog", story_number=1)
    s_a2 = Story(id=uuid.uuid4(), org_id=org.id, project_id=project.id, epic_id=epic_a.id, title="A2 special", status="backlog", story_number=2)
    s_b1 = Story(id=uuid.uuid4(), org_id=org.id, project_id=project.id, epic_id=epic_b.id, title="B1", status="backlog", story_number=3)
    s_b2 = Story(id=uuid.uuid4(), org_id=org.id, project_id=project.id, epic_id=epic_b.id, title="B2", status="backlog", story_number=4)
    # status가 다른 형제 — status 필터 자체는 여전히 걸려야 함(음성대조 축).
    s_a_done = Story(id=uuid.uuid4(), org_id=org.id, project_id=project.id, epic_id=epic_a.id, title="A-done", status="done", story_number=5)
    session.add_all([s_a1, s_a2, s_b1, s_b2, s_a_done])
    await session.commit()

    return {
        "org_id": org.id, "project_id": project.id, "agent_id": agent.id,
        "epic_a": epic_a.id, "epic_b": epic_b.id,
        "s_a1": s_a1.id, "s_a2": s_a2.id, "s_b1": s_b1.id, "s_b2": s_b2.id,
        "s_a2_number": s_a2.story_number,
    }


async def _call_list_stories(session, org_id, agent_id, **kwargs):
    """FastAPI Query() 기본값은 라우터를 직접 호출하면 unwrap 안 되므로(test_083176e8와 동일
    사유) 관련 파라미터 전부 명시 None/False로 채운다."""
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


async def test_board_branch_epic_id_narrows_not_ignored():
    """⭐본체 — 오르테가군이 실측한 그 조합. project_id+status만 걸면 4건(A1/A2/B1/B2),
    epic_id를 더하면 **줄어야** 하는데 고치기 前엔 그대로 4건(무시)이었다."""
    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            seeded = await _seed(s)
        async with Session() as s:
            result = await _call_list_stories(
                s, seeded["org_id"], seeded["agent_id"],
                project_id=seeded["project_id"], status_filter="backlog", epic_id=seeded["epic_a"],
            )
            returned_ids = {r.id for r in result}
            assert returned_ids == {seeded["s_a1"], seeded["s_a2"]}, (
                f"epic_id=A 로 좁혔는데 B 스토리가 섞여 나옴: {returned_ids}"
            )
    finally:
        await engine.dispose()


async def test_board_branch_story_number_narrows():
    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            seeded = await _seed(s)
        async with Session() as s:
            result = await _call_list_stories(
                s, seeded["org_id"], seeded["agent_id"],
                project_id=seeded["project_id"], status_filter="backlog",
                story_number=seeded["s_a2_number"],
            )
            assert {r.id for r in result} == {seeded["s_a2"]}
    finally:
        await engine.dispose()


async def test_board_branch_q_narrows():
    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            seeded = await _seed(s)
        async with Session() as s:
            result = await _call_list_stories(
                s, seeded["org_id"], seeded["agent_id"],
                project_id=seeded["project_id"], status_filter="backlog", q="special",
            )
            assert {r.id for r in result} == {seeded["s_a2"]}
    finally:
        await engine.dispose()


async def test_board_branch_status_filter_still_excludes_other_status_no_regression():
    """무회귀 — status=backlog 는 done 형제(s_a_done)를 여전히 제외해야 하는(board 분기의
    원래 목적 자체는 안 깨졌는지)."""
    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            seeded = await _seed(s)
        async with Session() as s:
            result = await _call_list_stories(
                s, seeded["org_id"], seeded["agent_id"],
                project_id=seeded["project_id"], status_filter="backlog",
            )
            returned_ids = {r.id for r in result}
            assert returned_ids == {seeded["s_a1"], seeded["s_a2"], seeded["s_b1"], seeded["s_b2"]}
    finally:
        await engine.dispose()


async def test_filter_monotonicity_invariant_status_must_not_undo_other_filters():
    """⭐AC2 — «필터를 추가했는데 결과 집합이 늘어나면 실패» 불변식. 오르테가군이 실제로 밟은
    방향 그대로 짜야 의미가 있다: (epic_id만, 제네릭 분기) → (epic_id+status, board 분기)로
    **status를 더했을 때** 결과가 baseline 밖으로 늘면 실패.

    ⚠️ 주의(자가검출) — 처음엔 "board 분기 안에서 필터 有/無"를 비교했는데, 그건 이 결함을
    못 잡는다: 필터가 통째로 무시되면 narrowed == base(자기 자신의 부분집합)라 subset 체크가
    거짓으로 통과한다. 실제 사고는 **분기가 바뀌면서 이전 필터가 사라지는 것**이라, 비교 축도
    "필터 추가 前 분기 vs 후 분기"여야 한다 — 이 방향으로 짜자 고치기 前 코드에서 실제로
    깨지는 것을 아래 self-check(주석)로 확認했다."""
    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            seeded = await _seed(s)
        async with Session() as s:
            # baseline: epic_id만(제네릭 분기, status 없음) — A만 → A1/A2/A-done 전부.
            baseline = await _call_list_stories(
                s, seeded["org_id"], seeded["agent_id"],
                project_id=seeded["project_id"], epic_id=seeded["epic_a"],
            )
            baseline_ids = {r.id for r in baseline}

            for extra in (
                dict(status_filter="backlog"),
                dict(status_filter="backlog", story_number=seeded["s_a2_number"]),
                dict(status_filter="backlog", q="special"),
            ):
                narrowed = await _call_list_stories(
                    s, seeded["org_id"], seeded["agent_id"],
                    project_id=seeded["project_id"], epic_id=seeded["epic_a"], **extra,
                )
                narrowed_ids = {r.id for r in narrowed}
                assert narrowed_ids.issubset(baseline_ids), (
                    f"epic_id={seeded['epic_a']} 위에 필터 추가({extra})가 baseline(epic_id만) "
                    f"밖으로 결과를 늘림 — 추가분={narrowed_ids - baseline_ids}. "
                    "필터 추가는 좁히기만 해야 한다(오르테가군 도그푸딩 재현 조건)."
                )
    finally:
        await engine.dispose()


async def test_board_branch_no_extra_filters_unspecified_no_regression():
    """무회귀 — epic_id/story_number/q 전부 미지정이면 기존 4건 그대로(board 분기 기본 동작 안 깨짐)."""
    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            seeded = await _seed(s)
        async with Session() as s:
            result = await _call_list_stories(
                s, seeded["org_id"], seeded["agent_id"],
                project_id=seeded["project_id"], status_filter="backlog",
                epic_id=None, story_number=None, q=None,
            )
            returned_ids = {r.id for r in result}
            assert returned_ids == {seeded["s_a1"], seeded["s_a2"], seeded["s_b1"], seeded["s_b2"]}
    finally:
        await engine.dispose()
