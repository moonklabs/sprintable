"""E-LOOP-LEDGER P1-S3: embed-backlog cron 단위 테스트(mock session, 블루프린트 §P1).

핵심 불변식: embed_text 성공→ready(벡터+model_version+dimension 저장)·None(인증불가/API오류
원인 불문)→pending 유지(false-hit 0, 원인 구분 없이 재시도)·예외 발생 row만 격리적으로 failed.
한 row의 예외가 배치 전체를 막지 않는다(개별 try/except).
"""
import uuid
from types import SimpleNamespace
from unittest.mock import AsyncMock, MagicMock, patch

import pytest

from app.services import embedding_backlog as backlog


@pytest.fixture
def anyio_backend():
    return "asyncio"


def _row(status="pending", embedding_text="loop: 신규 온보딩 개선", retry_count=0):
    return SimpleNamespace(
        id=uuid.uuid4(), status=status, embedding_text=embedding_text,
        embedding=None, model_version=None, dimension=None, error_message=None,
        retry_count=retry_count,
    )


def _result(items):
    r = MagicMock()
    r.scalars.return_value.all.return_value = items
    return r


def _session(rows):
    s = AsyncMock()
    s.execute = AsyncMock(return_value=_result(rows))
    return s


async def test_embed_success_marks_ready_and_stores_vector():
    row = _row()
    session = _session([row])
    vector = [0.1] * 768
    with patch("app.services.embedding_client.embed_text", return_value=vector):
        summary = await backlog.process_embedding_backlog(session)
    assert row.status == "ready"
    assert row.embedding == vector
    assert row.model_version == "gemini-embedding-001"
    assert row.dimension == 768
    assert row.error_message is None
    assert summary["embedded"] == [str(row.id)]
    assert summary["pending_retry"] == []
    assert summary["failed"] == []


async def test_embed_none_keeps_pending_no_failure_signal():
    """인증불가/API오류 등 embed_text가 None을 반환하는 모든 경우 — 원인 구분 없이 pending 유지."""
    row = _row(status="pending")
    session = _session([row])
    with patch("app.services.embedding_client.embed_text", return_value=None):
        summary = await backlog.process_embedding_backlog(session)
    assert row.status == "pending"
    assert summary["embedded"] == []
    assert summary["pending_retry"] == [str(row.id)]
    assert summary["failed"] == []


async def test_failed_row_reselected_resets_to_pending_on_none():
    """기존 status='failed' row도 이 cron이 재선정 — embed_text가 다시 None이면 pending으로 되돌림
    (app/models/embedding.py 문서화된 FSM: '재시도는 cron이 pending으로 되돌림')."""
    row = _row(status="failed")
    row.error_message = "이전 실패"
    session = _session([row])
    with patch("app.services.embedding_client.embed_text", return_value=None):
        await backlog.process_embedding_backlog(session)
    assert row.status == "pending"


async def test_one_row_exception_does_not_block_batch():
    good = _row()
    bad = _row()
    session = _session([bad, good])
    vector = [0.2] * 768

    calls = {"n": 0}

    def _embed(text):
        calls["n"] += 1
        if calls["n"] == 1:
            raise RuntimeError("unexpected SDK crash")
        return vector

    with patch("app.services.embedding_client.embed_text", side_effect=_embed):
        summary = await backlog.process_embedding_backlog(session)

    assert bad.status == "failed"
    assert "unexpected SDK crash" in bad.error_message
    assert good.status == "ready"
    assert summary["embedded"] == [str(good.id)]
    assert len(summary["failed"]) == 1
    assert summary["failed"][0]["id"] == str(bad.id)


async def test_empty_backlog_returns_zero_counts():
    session = _session([])
    summary = await backlog.process_embedding_backlog(session)
    assert summary == {
        "scanned": 0, "embedded": [], "pending_retry": [], "failed": [], "terminal": [],
    }


async def test_batch_limit_passed_through_to_query():
    from sqlalchemy.dialects import postgresql

    session = _session([])
    await backlog.process_embedding_backlog(session, limit=5)
    executed_query = session.execute.call_args[0][0]
    compiled = str(executed_query.compile(
        dialect=postgresql.dialect(), compile_kwargs={"literal_binds": True}
    ))
    assert "LIMIT 5" in compiled
