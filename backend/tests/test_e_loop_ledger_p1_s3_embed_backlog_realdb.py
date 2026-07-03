"""E-LOOP-LEDGER P1-S3: embed-backlog cron 실 Postgres 검증(블루프린트 §P1).

핵심: pgvector round-trip(embedding 컬럼 실 저장/조회)·SKIP LOCKED 동시성(중첩 cron invocation이
같은 row를 중복 처리 안 함)·failed row 재선정→pending 리셋. embed_client는 라이브 Vertex AI 호출
없이 patch(P1-S2 자체 검증은 test_e_loop_ledger_p1_s2_embedding_client.py 스코프).
"""
from __future__ import annotations

import os
import uuid
from unittest.mock import patch

import pytest

_REAL_DB_URL = os.getenv("PARITY_TEST_DATABASE_URL") or os.getenv("ALEMBIC_DATABASE_URL")

# story 8236bbc3: create_all/drop_all로 자체 스키마 직접 관리 — 공유 alembic-migrated DB
# 오염 방지 위해 격리 DB 전용(conftest.py 가드가 마커 누락을 자동 검출).
pytestmark = pytest.mark.destructive_schema


@pytest.fixture
def anyio_backend():
    return "asyncio"


async def _session():
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
        embedding_text="loop: 신규 온보딩 개선", content_hash="deadbeef",
        status="pending",
    )
    base.update(ov)
    return Embedding(**base)


@pytest.mark.skipif(not _REAL_DB_URL, reason="real Postgres 필요(PARITY/ALEMBIC_DATABASE_URL)")
@pytest.mark.anyio
async def test_embed_success_persists_vector_real_db():
    from sqlalchemy import text as _text, select
    from app.core.database import Base
    from app.models.embedding import Embedding
    from app.services.embedding_backlog import process_embedding_backlog

    engine, Session = await _session()
    row = _embedding()
    vector = [0.5] * 768
    try:
        async with Session() as s:
            await s.execute(_text("SET session_replication_role = replica"))
            s.add(row)
            await s.commit()

        async with Session() as s:
            with patch("app.services.embedding_client.embed_text", return_value=vector):
                summary = await process_embedding_backlog(s)
            await s.commit()
        assert summary["embedded"] == [str(row.id)]

        async with Session() as s:
            persisted = (await s.execute(
                select(Embedding).where(Embedding.id == row.id)
            )).scalar_one()
            assert persisted.status == "ready"
            assert persisted.model_version == "gemini-embedding-001"
            assert persisted.dimension == 768
            assert list(persisted.embedding) == pytest.approx(vector)
    finally:
        async with engine.begin() as conn:
            await conn.run_sync(Base.metadata.drop_all)
        await engine.dispose()


@pytest.mark.skipif(not _REAL_DB_URL, reason="real Postgres 필요(PARITY/ALEMBIC_DATABASE_URL)")
@pytest.mark.anyio
async def test_embed_none_and_failed_reselect_stay_or_reset_pending_real_db():
    from sqlalchemy import text as _text, select
    from app.core.database import Base
    from app.models.embedding import Embedding
    from app.services.embedding_backlog import process_embedding_backlog

    engine, Session = await _session()
    still_pending = _embedding(status="pending")
    was_failed = _embedding(status="failed", error_message="이전 실패")
    try:
        async with Session() as s:
            await s.execute(_text("SET session_replication_role = replica"))
            s.add_all([still_pending, was_failed])
            await s.commit()

        async with Session() as s:
            with patch("app.services.embedding_client.embed_text", return_value=None):
                summary = await process_embedding_backlog(s)
            await s.commit()
        assert set(summary["pending_retry"]) == {str(still_pending.id), str(was_failed.id)}

        async with Session() as s:
            rows = dict((await s.execute(
                select(Embedding.id, Embedding.status)
            )).all())
            assert rows[still_pending.id] == "pending"
            assert rows[was_failed.id] == "pending"  # failed → cron이 재선정→pending 리셋
    finally:
        async with engine.begin() as conn:
            await conn.run_sync(Base.metadata.drop_all)
        await engine.dispose()


@pytest.mark.skipif(not _REAL_DB_URL, reason="real Postgres 필요")
@pytest.mark.anyio
async def test_concurrent_invocations_skip_locked_disjoint_real_db():
    """⭐중첩 cron invocation이 같은 pending row를 동시에 집으면 유료 Vertex AI API가 중복 호출된다.
    FOR UPDATE SKIP LOCKED로 잠긴 row는 건너뛰어 정확히 한쪽만 처리."""
    from sqlalchemy import select
    from app.core.database import Base
    from app.models.embedding import Embedding
    from app.services.embedding_backlog import process_embedding_backlog
    from sqlalchemy import text as _text

    engine, Session = await _session()
    row = _embedding()
    try:
        async with Session() as s:
            await s.execute(_text("SET session_replication_role = replica"))
            s.add(row)
            await s.commit()

        async with Session() as s_lock, Session() as s_work:
            held = (await s_lock.execute(
                select(Embedding).where(Embedding.id == row.id).with_for_update(skip_locked=True)
            )).scalar_one_or_none()
            assert held is not None  # s_lock이 row 잠금 보유

            with patch("app.services.embedding_client.embed_text", return_value=[0.1] * 768) as embed_mock:
                summary = await process_embedding_backlog(s_work)
            assert summary["scanned"] == 0  # ⭐잠긴 row는 건너뜀
            embed_mock.assert_not_called()
            await s_lock.rollback()

        async with Session() as s2:
            with patch("app.services.embedding_client.embed_text", return_value=[0.2] * 768) as embed_mock2:
                summary2 = await process_embedding_backlog(s2)
            await s2.commit()
        assert summary2["embedded"] == [str(row.id)]
        assert embed_mock2.call_count == 1
    finally:
        async with engine.begin() as conn:
            await conn.run_sync(Base.metadata.drop_all)
        await engine.dispose()
