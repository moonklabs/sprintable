"""doc-payload enrich: doc 상세에 담당자 member 요약 + 수정이력 요약 동봉(FE 이중 fetch 제거).

검증: assignee_id → member(id/name/avatar_url) org-scope resolve · revisions count/latest agg ·
타org/미존재 assignee 는 None(노출 0) · assignee 없으면 member 쿼리 skip · org-scope SQL.
"""
from __future__ import annotations

import uuid
from datetime import datetime, timezone
from types import SimpleNamespace
from unittest.mock import AsyncMock, MagicMock

import pytest

from app.routers.docs import _enrich_doc_response

ORG = uuid.uuid4()
T = datetime(2026, 6, 24, tzinfo=timezone.utc)


@pytest.fixture
def anyio_backend():
    return "asyncio"


def _doc(assignee_id=None):
    return SimpleNamespace(
        id=uuid.uuid4(), project_id=uuid.uuid4(), org_id=ORG, parent_id=None,
        created_by=None, assignee_id=assignee_id, status="draft", superseded_by=None,
        title="t", slug="s", canonical_slug="s", slug_locked=False, content="c",
        icon=None, sort_order=0, doc_type="page", content_format="markdown", tags=[],
        created_at=T, updated_at=T,
    )


@pytest.mark.anyio
async def test_enrich_assignee_and_revisions():
    aid = uuid.uuid4()
    doc = _doc(assignee_id=aid)
    session = AsyncMock()
    member_res = MagicMock()
    member_res.first.return_value = (aid, "Didi", "https://av/didi.png")
    rev_res = MagicMock()
    rev_res.one.return_value = (3, T)
    session.execute = AsyncMock(side_effect=[member_res, rev_res])  # member → revisions 순.

    resp = await _enrich_doc_response(doc, session)
    assert resp.assignee is not None
    assert resp.assignee.id == aid and resp.assignee.name == "Didi"
    assert resp.assignee.avatar_url == "https://av/didi.png"
    assert resp.revisions.count == 3 and resp.revisions.latest_at == T


@pytest.mark.anyio
async def test_enrich_no_assignee_skips_member_query():
    doc = _doc(assignee_id=None)
    session = AsyncMock()
    rev_res = MagicMock()
    rev_res.one.return_value = (0, None)
    session.execute = AsyncMock(return_value=rev_res)

    resp = await _enrich_doc_response(doc, session)
    assert resp.assignee is None              # assignee 없으면 member 해소 skip.
    assert resp.revisions.count == 0 and resp.revisions.latest_at is None
    assert session.execute.await_count == 1  # revisions 쿼리 1건만(member skip).


@pytest.mark.anyio
async def test_enrich_assignee_not_found_is_none():
    doc = _doc(assignee_id=uuid.uuid4())
    session = AsyncMock()
    member_res = MagicMock()
    member_res.first.return_value = None       # 타org/삭제/미존재 → 미발견.
    rev_res = MagicMock()
    rev_res.one.return_value = (1, T)
    session.execute = AsyncMock(side_effect=[member_res, rev_res])

    resp = await _enrich_doc_response(doc, session)
    assert resp.assignee is None               # 미발견 → 조용히 None(노출 0).
    assert resp.revisions.count == 1


@pytest.mark.anyio
async def test_enrich_org_scoped_queries():
    """member·revisions 쿼리가 doc.org_id 로 스코프되는지(anti-IDOR) — 컴파일 SQL 확인."""
    doc = _doc(assignee_id=uuid.uuid4())
    session = AsyncMock()
    member_res = MagicMock(); member_res.first.return_value = None
    rev_res = MagicMock(); rev_res.one.return_value = (0, None)
    session.execute = AsyncMock(side_effect=[member_res, rev_res])
    await _enrich_doc_response(doc, session)
    member_sql = str(session.execute.await_args_list[0].args[0])
    rev_sql = str(session.execute.await_args_list[1].args[0])
    assert "org_id" in member_sql and "deleted_at" in member_sql  # member org-scope + soft-delete.
    assert "org_id" in rev_sql                                    # revisions org-scope.
