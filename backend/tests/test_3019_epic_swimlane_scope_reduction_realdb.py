"""story #3019(실사고, PO 확定 2026-08-24) — 에픽 스윔레인 뷰가 매 로드마다 프로젝트 전체
역사(그라운딩 시점 실측 3018건)를 페이지네이션으로 소진해 37초+ 멈춤을 냈다. 근본 처방은
StoryRepository.list()에 epic_ids(IN)+include_unassigned(OR)+done_within_days 필터를 얹어
"화면이 실제로 그리는 것"만 서버측에서 좁히는 것 — 이 파일은 그 세 파라미터의 실PG 검증.

핵심 회귀 축(신규 파라미터라 실측 0이던 것들):
① epic_ids+include_unassigned는 AND가 아니라 OR(합집합) — 잘못 짜면 공집합.
② include_unassigned는 기존 `unattached`(#2532, 가설 링크까지 검사)와 다른 개념 —
   가설이 매달린 미배정 스토리도 include_unassigned=True엔 포함돼야 한다.
③ done_within_days는 status=done row만 좁히고 그 외 상태는 나이 무관 전부 포함."""
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


async def _call_list_stories(session, org_id, agent_id, **kwargs):
    """test_083176e8와 동형 관례 — Query() 센티널 함정 회피(신규 3종 포함 전부 명시)."""
    from app.repositories.story import StoryRepository
    from app.routers.stories import list_stories

    repo = StoryRepository(session, org_id)
    params = dict(
        project_id=None, epic_id=None, sprint_id=None, assignee_id=None,
        status_filter=None, no_sprint=False, unattached=False, ids=None, story_number=None,
        q=None, boost_candidates_from=None, epic_ids=None, include_unassigned=False,
        done_within_days=None, limit=1000, cursor=None, response=None,
    )
    params.update(kwargs)
    return await list_stories(repo=repo, auth=_auth(agent_id), **params)


async def _seed(session):
    from app.models.hypothesis import Hypothesis, HypothesisStoryLink
    from app.models.member import Member
    from app.models.organization import Organization
    from app.models.pm import Goal, Story
    from app.models.project import Project
    from app.models.project_access import ProjectAccess

    org = Organization(id=uuid.uuid4(), name="Org3019", slug=f"org3019-{uuid.uuid4().hex[:8]}")
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

    epic_active = Goal(id=uuid.uuid4(), org_id=org.id, project_id=project.id, title="Active epic", status="active")
    epic_other = Goal(id=uuid.uuid4(), org_id=org.id, project_id=project.id, title="Other epic", status="active")
    session.add_all([epic_active, epic_other])
    await session.commit()

    now = datetime.now(timezone.utc)
    old = now - timedelta(days=30)
    recent = now - timedelta(days=1)

    s_epic_active = Story(
        id=uuid.uuid4(), org_id=org.id, project_id=project.id, title="Story under active epic",
        status="in-progress", epic_id=epic_active.id,
    )
    s_epic_other = Story(
        id=uuid.uuid4(), org_id=org.id, project_id=project.id, title="Story under other epic",
        status="in-progress", epic_id=epic_other.id,
    )
    s_unassigned_open = Story(
        id=uuid.uuid4(), org_id=org.id, project_id=project.id, title="Unassigned open story",
        status="backlog", epic_id=None,
    )
    s_unassigned_done_recent = Story(
        id=uuid.uuid4(), org_id=org.id, project_id=project.id, title="Unassigned done recent",
        status="done", epic_id=None,
    )
    s_unassigned_done_old = Story(
        id=uuid.uuid4(), org_id=org.id, project_id=project.id, title="Unassigned done old",
        status="done", epic_id=None,
    )
    s_epic_active_done_old = Story(
        id=uuid.uuid4(), org_id=org.id, project_id=project.id, title="Active epic done old",
        status="done", epic_id=epic_active.id,
    )
    # story #2532 unattached와 include_unassigned의 개념 분리 검증용 — epic_id는 없지만
    # 가설이 매달려 있어 기존 _unattached_clause()는 이걸 걸러낸다(unattached=True 시 제외).
    s_unassigned_with_hypothesis = Story(
        id=uuid.uuid4(), org_id=org.id, project_id=project.id, title="Unassigned but has hypothesis",
        status="backlog", epic_id=None,
    )
    session.add_all([
        s_epic_active, s_epic_other, s_unassigned_open, s_unassigned_done_recent,
        s_unassigned_done_old, s_epic_active_done_old, s_unassigned_with_hypothesis,
    ])
    await session.commit()

    # created_at은 서버 default(now)라 커밋 後 직접 UPDATE로 시점을 조작한다(seed 전용, 실제
    # 쓰기경로가 아니므로 raw update 허용 — 기존 realdb 시딩 관례와 동형).
    from sqlalchemy import update
    await session.execute(update(Story).where(Story.id == s_unassigned_done_recent.id).values(created_at=recent))
    await session.execute(update(Story).where(Story.id == s_unassigned_done_old.id).values(created_at=old))
    await session.execute(update(Story).where(Story.id == s_epic_active_done_old.id).values(created_at=old))
    await session.commit()

    hyp = Hypothesis(
        id=uuid.uuid4(), org_id=org.id, project_id=project.id, owner_member_id=agent.id,
        statement="H", metric_definition={"metric": "x", "target": 1, "direction": "up"},
        measure_after=now + timedelta(days=7),
    )
    session.add(hyp)
    await session.commit()
    session.add(HypothesisStoryLink(
        id=uuid.uuid4(), hypothesis_id=hyp.id, story_id=s_unassigned_with_hypothesis.id,
    ))
    await session.commit()

    return {
        "org_id": org.id, "project_id": project.id, "agent_id": agent.id,
        "epic_active": epic_active.id, "epic_other": epic_other.id,
        "s_epic_active": s_epic_active.id, "s_epic_other": s_epic_other.id,
        "s_unassigned_open": s_unassigned_open.id,
        "s_unassigned_done_recent": s_unassigned_done_recent.id,
        "s_unassigned_done_old": s_unassigned_done_old.id,
        "s_epic_active_done_old": s_epic_active_done_old.id,
        "s_unassigned_with_hypothesis": s_unassigned_with_hypothesis.id,
    }


async def test_epic_ids_filters_to_that_set_only():
    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            seeded = await _seed(s)
        async with Session() as s:
            result = await _call_list_stories(
                s, seeded["org_id"], seeded["agent_id"],
                project_id=seeded["project_id"], epic_ids=str(seeded["epic_active"]),
            )
            ids = {r.id for r in result}
            assert seeded["s_epic_active"] in ids
            assert seeded["s_epic_active_done_old"] in ids  # done_within_days 미지정 — 나이 무관 포함.
            assert seeded["s_epic_other"] not in ids
            assert seeded["s_unassigned_open"] not in ids
    finally:
        await engine.dispose()


async def test_epic_ids_and_include_unassigned_is_or_not_and():
    """① 회귀축 — epic_ids(활성 에픽 집합)+include_unassigned=True는 합집합이어야 한다."""
    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            seeded = await _seed(s)
        async with Session() as s:
            result = await _call_list_stories(
                s, seeded["org_id"], seeded["agent_id"],
                project_id=seeded["project_id"], epic_ids=str(seeded["epic_active"]),
                include_unassigned=True,
            )
            ids = {r.id for r in result}
            assert seeded["s_epic_active"] in ids
            assert seeded["s_unassigned_open"] in ids
            assert seeded["s_unassigned_with_hypothesis"] in ids
            assert seeded["s_epic_other"] not in ids  # 다른(요청 안 한) 에픽은 여전히 제외.
    finally:
        await engine.dispose()


async def test_include_unassigned_differs_from_legacy_unattached():
    """② 회귀축 — include_unassigned은 가설 링크 유무를 안 본다(#2532 unattached와 다른 축).
    unattached=True로 같은 질의를 하면 가설 매달린 미배정 스토리가 빠진다(대조군)."""
    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            seeded = await _seed(s)
        async with Session() as s:
            result = await _call_list_stories(
                s, seeded["org_id"], seeded["agent_id"],
                project_id=seeded["project_id"], include_unassigned=True,
            )
            ids = {r.id for r in result}
            assert seeded["s_unassigned_with_hypothesis"] in ids

            legacy = await _call_list_stories(
                s, seeded["org_id"], seeded["agent_id"],
                project_id=seeded["project_id"], unattached=True,
            )
            legacy_ids = {r.id for r in legacy}
            assert seeded["s_unassigned_with_hypothesis"] not in legacy_ids  # 대조군 — 기존 동작 무변화.
            assert seeded["s_unassigned_open"] in legacy_ids
    finally:
        await engine.dispose()


async def test_done_within_days_bounds_only_done_status():
    """③ 회귀축 — done_within_days는 done row만 나이 제한. non-done은 나이 무관 전부 포함."""
    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            seeded = await _seed(s)
        async with Session() as s:
            result = await _call_list_stories(
                s, seeded["org_id"], seeded["agent_id"],
                project_id=seeded["project_id"], include_unassigned=True, done_within_days=7,
            )
            ids = {r.id for r in result}
            assert seeded["s_unassigned_done_recent"] in ids  # 1일 전 done — 포함.
            assert seeded["s_unassigned_done_old"] not in ids  # 30일 전 done — 제외.
            assert seeded["s_unassigned_open"] in ids  # backlog(non-done) — 나이 무관 포함.

            with_epic = await _call_list_stories(
                s, seeded["org_id"], seeded["agent_id"],
                project_id=seeded["project_id"], epic_ids=str(seeded["epic_active"]), done_within_days=7,
            )
            epic_ids = {r.id for r in with_epic}
            assert seeded["s_epic_active"] in epic_ids  # in-progress — 나이 무관.
            assert seeded["s_epic_active_done_old"] not in epic_ids  # 30일 전 done — 에픽 소속이어도 제외.
    finally:
        await engine.dispose()


async def test_no_new_params_no_regression():
    """무회귀 — 신규 파라미터 셋 다 미지정 시 기존 동작(project 전체) 그대로."""
    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            seeded = await _seed(s)
        async with Session() as s:
            result = await _call_list_stories(s, seeded["org_id"], seeded["agent_id"], project_id=seeded["project_id"])
            ids = {r.id for r in result}
            assert ids == {
                seeded["s_epic_active"], seeded["s_epic_other"], seeded["s_unassigned_open"],
                seeded["s_unassigned_done_recent"], seeded["s_unassigned_done_old"],
                seeded["s_epic_active_done_old"], seeded["s_unassigned_with_hypothesis"],
            }
    finally:
        await engine.dispose()


async def test_epic_ids_too_many_rejected_422():
    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            seeded = await _seed(s)
        async with Session() as s:
            too_many = ",".join(str(uuid.uuid4()) for _ in range(201))
            from fastapi import HTTPException
            with pytest.raises(HTTPException) as exc_info:
                await _call_list_stories(s, seeded["org_id"], seeded["agent_id"], epic_ids=too_many)
            assert exc_info.value.status_code == 422
    finally:
        await engine.dispose()
