"""story #3148(2026-08-27, PO 실사용 오배분 사고) — 실 PG.

`sprintable_list_backlog`(no_sprint=True 분기)가 sprint 미배정만 걸고 status는 안 걸러
done/in-review까지 «백로그」로 반환 — PO가 이 목록으로 이미 끝난 스토리에 새 작업을
배분한 실사고의 원인. `list_backlog()`에 opt-in `exclude_statuses` 축을 신설하고 MCP
`sprintable_list_backlog` 툴이 이를 항상 고정 전송(`exclude_status=done,in-review`)하도록
배선한 fix — 이 파일은 SQL 필터 그 자체(repo→router 경로)를 실 PG로 검증한다(MCP 계층
쪽 "고정 전송" 자체는 test_mcp_list_backlog_b5870c4c.py::
test_list_backlog_always_excludes_done_and_in_review가 별도로 고정).

⛔ exclude_statuses 미지정 시 기존 계약(done 포함 전량 반환)은 절대 안 바뀐다 —
test_2188_list_backlog_filter_drop_realdb.py::test_backlog_no_extra_filters_unspecified_
no_regression이 그 축을 이미 고정하고 있어 이 파일에서 재확인하지 않는다(중복 아님, 축이
다르다: 그 테스트는 "미지정 무회귀", 이 테스트는 "지정 시 실제로 걸러지는지").
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

    # 전부 sprint_id=None(no_sprint 분기 대상) — status만 4갈래.
    s_backlog = Story(id=uuid.uuid4(), org_id=org.id, project_id=project.id, title="B", status="backlog", story_number=1)
    s_progress = Story(id=uuid.uuid4(), org_id=org.id, project_id=project.id, title="IP", status="in-progress", story_number=2)
    s_review = Story(id=uuid.uuid4(), org_id=org.id, project_id=project.id, title="IR", status="in-review", story_number=3)
    s_done = Story(id=uuid.uuid4(), org_id=org.id, project_id=project.id, title="D", status="done", story_number=4)
    session.add_all([s_backlog, s_progress, s_review, s_done])
    await session.commit()

    return {
        "org_id": org.id, "project_id": project.id, "agent_id": agent.id,
        "s_backlog": s_backlog.id, "s_progress": s_progress.id,
        "s_review": s_review.id, "s_done": s_done.id,
    }


async def _call_list_stories(session, org_id, agent_id, **kwargs):
    from app.repositories.story import StoryRepository
    from app.routers.stories import list_stories

    repo = StoryRepository(session, org_id)
    params = dict(
        project_id=None, epic_id=None, sprint_id=None, assignee_id=None,
        status_filter=None, no_sprint=False, exclude_status=None, ids=None,
        story_number=None, q=None, limit=1000, cursor=None, response=None,
    )
    params.update(kwargs)
    return await list_stories(repo=repo, auth=_auth(agent_id), **params)


async def test_exclude_status_filters_done_and_in_review():
    """⭐본체 — exclude_status="done,in-review" 지정 시 그 둘만 빠지고 나머지(backlog·
    in-progress)는 그대로 남는다(«백로그» 이름이 약속한 «아직 할 일»만)."""
    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            seeded = await _seed(s)
        async with Session() as s:
            result = await _call_list_stories(
                s, seeded["org_id"], seeded["agent_id"],
                project_id=seeded["project_id"], no_sprint=True, exclude_status="done,in-review",
            )
            returned_ids = {r.id for r in result}
            assert returned_ids == {seeded["s_backlog"], seeded["s_progress"]}
            assert seeded["s_done"] not in returned_ids
            assert seeded["s_review"] not in returned_ids
    finally:
        await engine.dispose()


async def test_exclude_status_total_count_reflects_post_filter_not_pre_filter():
    """X-Total-Count(응답 헤더)가 exclude 적용 「後」 값이어야 한다 — pagination truncation
    함정(unattached 선례, Python 후필터 방식이 헤더 거짓값을 냈던 결함 클래스)과 동형 회귀
    가드. SQL WHERE 레벨 필터라 이 값이 자동으로 맞는지 실증."""
    from unittest.mock import MagicMock

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            seeded = await _seed(s)
        async with Session() as s:
            fake_response = MagicMock()
            fake_response.headers = {}
            await _call_list_stories(
                s, seeded["org_id"], seeded["agent_id"],
                project_id=seeded["project_id"], no_sprint=True, exclude_status="done,in-review",
                response=fake_response,
            )
            assert fake_response.headers["X-Total-Count"] == "2"
    finally:
        await engine.dispose()


async def test_exclude_status_whitespace_tolerant():
    """comma-separated 파싱이 공백에도 관대한지(사람이 "done, in-review"처럼 보낼 수 있음)."""
    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            seeded = await _seed(s)
        async with Session() as s:
            result = await _call_list_stories(
                s, seeded["org_id"], seeded["agent_id"],
                project_id=seeded["project_id"], no_sprint=True, exclude_status="done, in-review",
            )
            returned_ids = {r.id for r in result}
            assert seeded["s_done"] not in returned_ids
            assert seeded["s_review"] not in returned_ids
    finally:
        await engine.dispose()


async def test_exclude_status_unspecified_still_returns_done_no_regression():
    """이 파일 자체 내에서도 재확인 — exclude_status=None(기본)이면 done도 그대로 섞여 온다
    (기존 계약 무회귀, test_2188 쌍둥이 축과 별개로 이 파일의 seed 데이터로도 재현)."""
    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            seeded = await _seed(s)
        async with Session() as s:
            result = await _call_list_stories(
                s, seeded["org_id"], seeded["agent_id"],
                project_id=seeded["project_id"], no_sprint=True,
            )
            returned_ids = {r.id for r in result}
            assert returned_ids == {
                seeded["s_backlog"], seeded["s_progress"], seeded["s_review"], seeded["s_done"],
            }
    finally:
        await engine.dispose()
