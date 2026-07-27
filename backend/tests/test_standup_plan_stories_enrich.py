"""a9e67531: 스탠드업 plan_stories org-scope enrich — 백로그→데일리 할일 미노출 버그 근본 fix.

BE 가 plan_story_ids 를 org-scope resolve 해 plan_stories[{id,title,status,...}] 로 내려줌(FE 가 active-sprint
stories 배열 의존 제거). 검증: 입력 순서 보존·타org/삭제/미존재 조용히 제외·plan_story_ids 하위호환 유지.

E-SECURITY SEC-S8(story 83ea3d6a) Z: viewer의 accessible_project_ids_in_org로도 필터(접근권 밖
project story는 조용히 제외) — 테스트는 accessible_project_ids_in_org를 patch해 격리 검증한다.
"""
from __future__ import annotations

import uuid
from datetime import date as _date, datetime, timezone
from types import SimpleNamespace
from unittest.mock import AsyncMock, MagicMock, patch

import pytest

from app.routers.standups import _entries_with_plan_stories

ORG = uuid.uuid4()
PROJECT_ID = uuid.uuid4()  # accessible-by-default project used across tests.
VIEWER_ID = uuid.uuid4()


@pytest.fixture
def anyio_backend():
    return "asyncio"


def _entry(plan_story_ids):
    now = datetime(2026, 6, 23, tzinfo=timezone.utc)
    return SimpleNamespace(
        id=uuid.uuid4(), project_id=None, org_id=ORG, sprint_id=None, author_id=uuid.uuid4(),
        date=_date(2026, 6, 23), done="d", plan="p", blockers=None,
        plan_story_ids=plan_story_ids, created_at=now, updated_at=now,
    )


def _row(sid, title="S", status="in-progress", project_id=PROJECT_ID):
    return (sid, title, status, "medium", project_id, None)


def _accessible(*ids):
    return patch(
        "app.services.project_auth.accessible_project_ids_in_org",
        new=AsyncMock(return_value=list(ids)),
    )


@pytest.mark.anyio
async def test_plan_stories_resolve_order_preserved_and_missing_excluded():
    s1, s2, s_missing = uuid.uuid4(), uuid.uuid4(), uuid.uuid4()
    entry = _entry([s2, s_missing, s1])  # 입력 순서 [s2, missing, s1].
    session = AsyncMock()
    result = MagicMock()
    # s_missing 은 타org/삭제라 쿼리 결과서 빠짐(s1,s2만 반환·순서 무관).
    result.all.return_value = [_row(s1, "One"), _row(s2, "Two")]
    session.execute = AsyncMock(return_value=result)

    with _accessible(PROJECT_ID):
        out = await _entries_with_plan_stories([entry], session, ORG, VIEWER_ID)
    resp = out[0]
    # ⭐입력 순서 보존(s2→s1)·missing 조용히 제외.
    assert [ps.id for ps in resp.plan_stories] == [s2, s1]
    assert [ps.title for ps in resp.plan_stories] == ["Two", "One"]
    # plan_story_ids 하위호환 유지(원본 3개 그대로).
    assert resp.plan_story_ids == [s2, s_missing, s1]


@pytest.mark.anyio
async def test_no_plan_story_ids_no_query():
    entry = _entry([])
    session = AsyncMock()
    session.execute = AsyncMock()
    with _accessible(PROJECT_ID):
        out = await _entries_with_plan_stories([entry], session, ORG, VIEWER_ID)
    assert out[0].plan_stories == []
    session.execute.assert_not_awaited()  # 빈 id → 쿼리 0.


@pytest.mark.anyio
async def test_org_scope_in_query():
    """resolve 쿼리가 org_id 로 스코프되는지(anti-IDOR·타org 해소 0) — 컴파일 SQL 확인."""
    s1 = uuid.uuid4()
    entry = _entry([s1])
    session = AsyncMock()
    result = MagicMock()
    result.all.return_value = [_row(s1)]
    session.execute = AsyncMock(return_value=result)
    with _accessible(PROJECT_ID):
        await _entries_with_plan_stories([entry], session, ORG, VIEWER_ID)
    stmt = str(session.execute.await_args.args[0])
    assert "org_id" in stmt and "deleted_at" in stmt  # org-scope + soft-delete 필터.


@pytest.mark.anyio
async def test_inaccessible_project_story_excluded():
    """E-SECURITY SEC-S8 Z: viewer가 접근권 없는 project의 story는 org-scope 통과해도 제외."""
    s1 = uuid.uuid4()
    other_project = uuid.uuid4()
    entry = _entry([s1])
    session = AsyncMock()
    result = MagicMock()
    result.all.return_value = [_row(s1, "Hidden", project_id=other_project)]
    session.execute = AsyncMock(return_value=result)
    with _accessible(PROJECT_ID):  # viewer는 other_project 접근권 없음.
        out = await _entries_with_plan_stories([entry], session, ORG, VIEWER_ID)
    assert out[0].plan_stories == []
    assert out[0].plan_story_ids == [s1]  # 원본 id 하위호환은 유지.


# ─── b47f9b05: history + get_standup enrich 갭 회귀(원 시나리오) ──────────────

def _repo(*, list_ret=None, get_ret=None, session=None):
    return SimpleNamespace(
        list=AsyncMock(return_value=list_ret),
        get=AsyncMock(return_value=get_ret),
        session=session, org_id=ORG,
    )


def _auth():
    return MagicMock(user_id=str(VIEWER_ID))


@pytest.mark.anyio
async def test_history_endpoint_enriches_backlog_plan_story():
    """history 가 백로그(cross-board) plan_story 를 enrich — 미적용 시 plan_stories 빈 채 미노출 회귀."""
    from app.routers.standups import list_standup_history
    backlog = uuid.uuid4()
    session = AsyncMock()
    result = MagicMock(); result.all.return_value = [_row(backlog, "Backlog", "backlog")]
    session.execute = AsyncMock(return_value=result)
    repo = _repo(list_ret=[_entry([backlog])], session=session)
    with _accessible(PROJECT_ID):
        out = await list_standup_history(project_id=uuid.uuid4(), limit=30, repo=repo, auth=_auth())
    assert [ps.id for ps in out[0].plan_stories] == [backlog]  # 백로그 노출(enrich)


@pytest.mark.anyio
async def test_get_standup_endpoint_enriches_backlog_plan_story():
    """단건 조회도 백로그 plan_story enrich(list/upsert/update 와 일관)."""
    from app.routers.standups import get_standup
    backlog = uuid.uuid4()
    entry = _entry([backlog])
    session = AsyncMock()
    result = MagicMock(); result.all.return_value = [_row(backlog, "Backlog", "backlog")]
    session.execute = AsyncMock(return_value=result)
    repo = _repo(get_ret=entry, session=session)
    with _accessible(PROJECT_ID):
        out = await get_standup(id=entry.id, repo=repo, auth=_auth())
    assert [ps.id for ps in out.plan_stories] == [backlog]
