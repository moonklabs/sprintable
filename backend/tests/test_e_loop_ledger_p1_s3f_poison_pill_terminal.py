"""E-LOOP-LEDGER P1-S3f(story 00ff282b): embed-backlog poison-pill row 종결 정책.

핵심(비-tautological):
ⓐ retry_count가 embed_text() None/예외마다 증가·성공 시 0 리셋(mock 세션).
ⓑ N(5)회 연속 실패 도달 시 status='failed'로 terminal — 이후 배치 SELECT에서 영구 제외.
ⓒ ⭐starvation 방지 실증(realdb) — poison-pill row가 항상 배치 슬롯(1건)을 점유하던 구간이
   N회 후 끝나고, 그제서야 정상 row가 실제로 처리됨을 직접 검증. fix 제거 시 이 테스트가
   실제로 무한정 실패(정상 row 영원히 미처리)함을 로컬 확인 후 복원(비-tautological).

DB env(PARITY_TEST_DATABASE_URL/ALEMBIC_DATABASE_URL) 없으면 realdb 파트 skip.
"""
from __future__ import annotations

import os
import uuid
from types import SimpleNamespace
from unittest.mock import AsyncMock, MagicMock, patch

import pytest

from app.services import embedding_backlog as backlog

_REAL_DB_URL = os.getenv("PARITY_TEST_DATABASE_URL") or os.getenv("ALEMBIC_DATABASE_URL")

# story 8236bbc3: create_all/drop_all로 자체 스키마 직접 관리 — 공유 alembic-migrated DB
# 오염 방지 위해 격리 DB 전용(conftest.py 가드가 마커 누락을 자동 검출).
pytestmark = pytest.mark.destructive_schema


@pytest.fixture
def anyio_backend():
    return "asyncio"


# ── ⓐⓑ retry_count 증가/리셋 + terminal 전환(mock 세션) ─────────────────────────

def _row(status="pending", retry_count=0, embedding_text="x"):
    return SimpleNamespace(
        id=uuid.uuid4(), status=status, embedding_text=embedding_text,
        embedding=None, model_version=None, dimension=None, error_message=None,
        retry_count=retry_count,
    )


def _session(rows):
    s = AsyncMock()
    res = MagicMock()
    res.scalars.return_value.all.return_value = rows
    s.execute = AsyncMock(return_value=res)
    return s


async def test_success_resets_retry_count_to_zero():
    row = _row(status="pending", retry_count=3)  # 이전에 3회 실패했다가 이번엔 성공.
    session = _session([row])
    with patch("app.services.embedding_client.embed_text", return_value=[0.1] * 768):
        await backlog.process_embedding_backlog(session)
    assert row.status == "ready"
    assert row.retry_count == 0


async def test_none_increments_retry_count_stays_pending_below_threshold():
    row = _row(status="pending", retry_count=2)
    session = _session([row])
    with patch("app.services.embedding_client.embed_text", return_value=None):
        summary = await backlog.process_embedding_backlog(session)
    assert row.retry_count == 3
    assert row.status == "pending"
    assert summary["pending_retry"] == [str(row.id)]
    assert summary["terminal"] == []


async def test_none_at_threshold_minus_one_becomes_terminal_failed():
    """4회 이미 실패한 row가 5번째도 실패 → terminal(_MAX_RETRY_COUNT=5 도달)."""
    row = _row(status="failed", retry_count=4)
    session = _session([row])
    with patch("app.services.embedding_client.embed_text", return_value=None):
        summary = await backlog.process_embedding_backlog(session)
    assert row.retry_count == 5
    assert row.status == "failed"
    assert "반복 실패" in row.error_message
    assert summary["terminal"] == [str(row.id)]
    assert summary["pending_retry"] == []


async def test_exception_also_counts_toward_terminal_threshold():
    """embed_text 자체가 예외를 던지는 경로도 동일 retry_count 임계값으로 terminal 전환."""
    row = _row(status="failed", retry_count=4)
    session = _session([row])
    with patch("app.services.embedding_client.embed_text", side_effect=RuntimeError("boom")):
        summary = await backlog.process_embedding_backlog(session)
    assert row.retry_count == 5
    assert row.status == "failed"
    assert "반복 실패" in row.error_message
    assert summary["terminal"] == [str(row.id)]
    assert summary["failed"] == []  # terminal 목록으로만 집계(retryable failed 목록엔 안 들어감).


async def test_terminal_reason_matches_actual_failure_mode():
    row = _row(status="failed", retry_count=4)
    session = _session([row])
    with patch("app.services.embedding_client.embed_text", side_effect=RuntimeError("quota exceeded")):
        await backlog.process_embedding_backlog(session)
    assert "quota exceeded" in row.error_message
    assert "반복 실패" in row.error_message


# ── realdb ───────────────────────────────────────────────────────────────────

async def _real_session():
    from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine
    from app.core.database import Base
    import app.models  # noqa: F401
    url = _REAL_DB_URL
    for prefix in ("postgresql+psycopg2://", "postgresql+asyncpg://", "postgresql://"):
        if url.startswith(prefix):
            url = "postgresql+asyncpg://" + url[len(prefix):]
            break
    engine = create_async_engine(url)
    async with engine.begin() as conn:
        await conn.run_sync(Base.metadata.create_all)
    return engine, async_sessionmaker(engine, expire_on_commit=False)


def _embedding(**ov):
    from app.models.embedding import Embedding
    base = dict(
        id=uuid.uuid4(), org_id=uuid.uuid4(), project_id=uuid.uuid4(),
        entity_type="loop", entity_id=uuid.uuid4(),
        embedding_text=f"loop: {uuid.uuid4().hex[:8]}", content_hash="deadbeef", status="pending",
    )
    base.update(ov)
    return Embedding(**base)


@pytest.mark.skipif(not _REAL_DB_URL, reason="real Postgres 필요(PARITY/ALEMBIC_DATABASE_URL)")
@pytest.mark.anyio
async def test_poison_pill_stops_starving_normal_row_after_max_retries_real_db():
    """⭐핵심 회귀 — poison-pill row(항상 embed_text=None)가 배치 slot=1을 5틱 동안 독점하다가
    terminal 전환 후 놓아줘야 정상 row가 마침내 처리된다. fix 제거 시 poison-pill이 영원히
    slot을 독점해(오래된 순 정렬) 정상 row가 6틱째도 처리 안 되는 것으로 직접 확인 가능."""
    from sqlalchemy import select, text as _text
    from app.core.database import Base
    from app.models.embedding import Embedding
    from app.services.embedding_backlog import process_embedding_backlog

    engine, Session = await _real_session()
    poison = _embedding()  # 먼저 생성 — created_at 더 오래됨 = 항상 우선 선정.
    try:
        async with Session() as s:
            await s.execute(_text("SET session_replication_role = replica"))
            s.add(poison)
            await s.commit()
        # poison보다 나중에 생성되는 정상 row(같은 세션 재사용 시 created_at 해상도 문제 회피 위해 별도 flush).
        normal = _embedding()
        async with Session() as s:
            await s.execute(_text("SET session_replication_role = replica"))
            s.add(normal)
            await s.commit()

        def _embed(text):
            # poison_pill 텍스트는 계속 None, 그 외(정상 row)는 성공.
            return None if text == poison.embedding_text else [0.3] * 768

        # tick 1~5: limit=1 → 항상 더 오래된 poison만 선정(starvation 구간 그대로 재현).
        for tick in range(1, 6):
            async with Session() as s:
                with patch("app.services.embedding_client.embed_text", side_effect=_embed):
                    summary = await process_embedding_backlog(s, limit=1)
                await s.commit()
            assert summary["scanned"] == 1
            if tick < 5:
                assert summary["pending_retry"] == [str(poison.id)], f"tick={tick}"
            else:
                assert summary["terminal"] == [str(poison.id)], "5번째 틱에 terminal 전환돼야 함"

        async with Session() as s:
            row = (await s.execute(select(Embedding).where(Embedding.id == poison.id))).scalar_one()
            assert row.status == "failed"
            assert row.retry_count == 5

        # tick 6: poison은 이제 배치 SELECT에서 제외 → 정상 row가 드디어 선정+성공.
        async with Session() as s:
            with patch("app.services.embedding_client.embed_text", side_effect=_embed):
                summary6 = await process_embedding_backlog(s, limit=1)
            await s.commit()
        assert summary6["scanned"] == 1
        assert summary6["embedded"] == [str(normal.id)], "poison 종결 후에야 정상 row 처리(starvation 해소)"

        async with Session() as s:
            normal_row = (await s.execute(select(Embedding).where(Embedding.id == normal.id))).scalar_one()
            assert normal_row.status == "ready"

        # tick 7: poison은 여전히 재선정 안 됨(terminal 영구 고정 — 재시도 안 함).
        async with Session() as s:
            with patch("app.services.embedding_client.embed_text") as mock_embed:
                summary7 = await process_embedding_backlog(s, limit=5)
        assert summary7["scanned"] == 0
        mock_embed.assert_not_called()
    finally:
        async with engine.begin() as conn:
            await conn.run_sync(Base.metadata.drop_all)
        await engine.dispose()
