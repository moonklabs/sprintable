"""doc-payload enrich 후속: slug-query 단건 경로(FE 상세 fetchDoc 실 경로) enrich.

#1691 은 GET /{id}(detail-by-id)만 enrich 했으나 FE 상세는 GET /api/docs?slug=(list_docs→
DocSummaryResponse·비enrich)를 써서 #1693 payload 소비가 항상 null→fallback이었다(숨은 회귀). 이 패스가
slug 단건 경로도 동일하게 담당자/수정이력을 채우는지 검증. org-scope·count/latest only·미발견 None.
"""
from __future__ import annotations

import uuid
from datetime import datetime, timezone
from types import SimpleNamespace
from unittest.mock import AsyncMock, MagicMock

import pytest

from app.routers.docs import _enrich_doc_summary

ORG = uuid.uuid4()
T = datetime(2026, 6, 24, tzinfo=timezone.utc)


@pytest.fixture
def anyio_backend():
    return "asyncio"


def _doc(assignee_id=None):
    # DocSummaryResponse 가 읽는 필드 + enrich 가 읽는 org_id/assignee_id/id.
    return SimpleNamespace(
        id=uuid.uuid4(), project_id=uuid.uuid4(), org_id=ORG, parent_id=None,
        title="t", slug="s", canonical_slug="s", slug_locked=False, icon=None,
        sort_order=0, doc_type="page", is_folder=False, tags=[], updated_at=T,
        snippet=None, assignee_id=assignee_id,
    )


@pytest.mark.anyio
async def test_summary_enrich_assignee_and_revisions():
    aid = uuid.uuid4()
    doc = _doc(assignee_id=aid)
    session = AsyncMock()
    member_res = MagicMock(); member_res.first.return_value = (aid, "Didi", "https://av/d.png")
    rev_res = MagicMock(); rev_res.one.return_value = (5, T)
    session.execute = AsyncMock(side_effect=[member_res, rev_res])

    resp = await _enrich_doc_summary(doc, session)
    # ⭐FE 상세가 쓰는 DocSummaryResponse 에 payload 가 실제로 채워짐(이전 회귀 = 항상 None).
    assert resp.assignee is not None and resp.assignee.name == "Didi"
    assert resp.assignee.avatar_url == "https://av/d.png"
    assert resp.revisions.count == 5 and resp.revisions.latest_at == T


@pytest.mark.anyio
async def test_summary_no_assignee_skips_member_query():
    doc = _doc(assignee_id=None)
    session = AsyncMock()
    rev_res = MagicMock(); rev_res.one.return_value = (0, None)
    session.execute = AsyncMock(return_value=rev_res)

    resp = await _enrich_doc_summary(doc, session)
    assert resp.assignee is None
    assert resp.revisions.count == 0
    assert session.execute.await_count == 1  # member skip → revisions 1쿼리만.


@pytest.mark.anyio
async def test_summary_assignee_not_found_none():
    doc = _doc(assignee_id=uuid.uuid4())
    session = AsyncMock()
    member_res = MagicMock(); member_res.first.return_value = None  # 타org/삭제/미존재.
    rev_res = MagicMock(); rev_res.one.return_value = (2, T)
    session.execute = AsyncMock(side_effect=[member_res, rev_res])

    resp = await _enrich_doc_summary(doc, session)
    assert resp.assignee is None and resp.revisions.count == 2


@pytest.mark.anyio
async def test_summary_org_scoped():
    doc = _doc(assignee_id=uuid.uuid4())
    session = AsyncMock()
    member_res = MagicMock(); member_res.first.return_value = None
    rev_res = MagicMock(); rev_res.one.return_value = (0, None)
    session.execute = AsyncMock(side_effect=[member_res, rev_res])
    await _enrich_doc_summary(doc, session)
    member_sql = str(session.execute.await_args_list[0].args[0])
    rev_sql = str(session.execute.await_args_list[1].args[0])
    assert "org_id" in member_sql and "deleted_at" in member_sql
    assert "org_id" in rev_sql
