"""a9e67531: 스탠드업 plan_stories org-scope enrich — 백로그→데일리 할일 미노출 버그 근본 fix.

BE 가 plan_story_ids 를 org-scope resolve 해 plan_stories[{id,title,status,...}] 로 내려줌(FE 가 active-sprint
stories 배열 의존 제거). 검증: 입력 순서 보존·타org/삭제/미존재 조용히 제외·plan_story_ids 하위호환 유지.
"""
from __future__ import annotations

import uuid
from datetime import date as _date, datetime, timezone
from types import SimpleNamespace
from unittest.mock import AsyncMock, MagicMock

import pytest

from app.routers.standups import _entries_with_plan_stories

ORG = uuid.uuid4()


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


def _row(sid, title="S", status="in-progress"):
    return (sid, title, status, "medium", None, None)


@pytest.mark.anyio
async def test_plan_stories_resolve_order_preserved_and_missing_excluded():
    s1, s2, s_missing = uuid.uuid4(), uuid.uuid4(), uuid.uuid4()
    entry = _entry([s2, s_missing, s1])  # 입력 순서 [s2, missing, s1].
    session = AsyncMock()
    result = MagicMock()
    # s_missing 은 타org/삭제라 쿼리 결과서 빠짐(s1,s2만 반환·순서 무관).
    result.all.return_value = [_row(s1, "One"), _row(s2, "Two")]
    session.execute = AsyncMock(return_value=result)

    out = await _entries_with_plan_stories([entry], session, ORG)
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
    out = await _entries_with_plan_stories([entry], session, ORG)
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
    await _entries_with_plan_stories([entry], session, ORG)
    stmt = str(session.execute.await_args.args[0])
    assert "org_id" in stmt and "deleted_at" in stmt  # org-scope + soft-delete 필터.
