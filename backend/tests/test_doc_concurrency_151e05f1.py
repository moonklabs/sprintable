"""151e05f1: 문서 동시편집 낙관적 동시성(409 DOC_CONFLICT) — BE 구현.

근본 갭(verify-first): BE update_doc 가 expected_updated_at/force_overwrite 를 미구현(DocUpdate
스키마에 필드 없어 silent-drop) → 동시편집 last-write-wins clobber. opt-in 409 추가.
"""
from __future__ import annotations

import uuid
from datetime import datetime, timezone
from types import SimpleNamespace
from unittest.mock import AsyncMock, MagicMock

import pytest

from app.routers.docs import update_doc
from app.schemas.doc import DocUpdate

T1 = datetime(2026, 6, 10, 10, 0, 0, tzinfo=timezone.utc)
T2 = datetime(2026, 6, 10, 11, 0, 0, tzinfo=timezone.utc)


@pytest.fixture
def anyio_backend():
    return "asyncio"


def _doc(updated_at=T1):
    return SimpleNamespace(
        id=uuid.uuid4(), project_id=uuid.uuid4(), org_id=uuid.uuid4(), parent_id=None,
        created_by=None, assignee_id=None, title="t", slug="s", canonical_slug="s",
        slug_locked=False, content="c", icon=None, sort_order=0, doc_type="page",
        content_format="markdown", tags=[], created_at=T1, updated_at=updated_at,
    )


async def _call(body_kwargs, doc_updated_at=T1):
    repo = MagicMock()
    repo.org_id = uuid.uuid4()
    d = _doc(doc_updated_at)
    repo.get = AsyncMock(return_value=d)
    session = AsyncMock()
    session.execute = AsyncMock()
    session.flush = AsyncMock()
    session.refresh = AsyncMock()
    resp = await update_doc(d.id, DocUpdate(**body_kwargs), repo, session)
    return resp, d


# ── strip-trap 재발 방지: DocUpdate 가 2필드 수용 ───────────────────────────────

def test_docupdate_accepts_concurrency_fields():
    """BE 스키마가 expected_updated_at/force_overwrite 를 strip 하지 않고 수용(ISO str→datetime)."""
    m = DocUpdate(expected_updated_at="2026-06-10T10:00:00+00:00", force_overwrite=True)
    assert m.expected_updated_at == T1
    assert m.force_overwrite is True


# ── 409 동시성 ─────────────────────────────────────────────────────────────────

@pytest.mark.anyio
async def test_stale_expected_updated_at_409():
    """expected_updated_at ≠ 현재 updated_at → 409 DOC_CONFLICT + current_updated_at."""
    with pytest.raises(Exception) as ei:
        await _call({"title": "x", "expected_updated_at": T2}, doc_updated_at=T1)
    exc = ei.value
    assert getattr(exc, "status_code", None) == 409
    assert exc.detail["code"] == "DOC_CONFLICT"
    assert exc.detail["current_updated_at"] == T1.isoformat()


@pytest.mark.anyio
async def test_matching_expected_updated_at_proceeds():
    """expected_updated_at == 현재 → 통과(title 적용·409 없음)."""
    resp, d = await _call({"title": "x", "expected_updated_at": T1}, doc_updated_at=T1)
    assert d.title == "x"
    assert resp.title == "x"


@pytest.mark.anyio
async def test_force_overwrite_bypasses_check():
    """force_overwrite=True → stale여도 우회(last-write-wins 의도적)."""
    resp, d = await _call(
        {"title": "forced", "expected_updated_at": T2, "force_overwrite": True}, doc_updated_at=T1
    )
    assert d.title == "forced"


@pytest.mark.anyio
async def test_omitted_expected_updated_at_no_check():
    """expected_updated_at 미제공 → 무체크(하위호환·stale여도 통과)."""
    resp, d = await _call({"title": "legacy"}, doc_updated_at=T1)
    assert d.title == "legacy"
