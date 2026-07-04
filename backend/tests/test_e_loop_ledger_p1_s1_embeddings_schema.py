"""E-LOOP-LEDGER P1-S1(story 2b9c8b06): 폴리모픽 embeddings 테이블 스키마 검증.

순수 스키마 스토리 — client/cron 없음(P1-S2/S3 스코프). 여기서는 제약(CHECK/UNIQUE)이
실제로 발동하는지, HNSW 인덱스가 실재하는지, 기본값이 맞는지를 실 DB로 검증한다.

DB env(ALEMBIC_DATABASE_URL) 없으면 skip.
"""
from __future__ import annotations

import hashlib
import os
import uuid

import pytest
from sqlalchemy import select, text
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine

_RAW = os.environ.get("ALEMBIC_DATABASE_URL") or os.environ.get("PARITY_TEST_DATABASE_URL") or ""
_ASYNC = _RAW.replace("postgresql+psycopg2://", "postgresql+asyncpg://").replace(
    "postgresql://", "postgresql+asyncpg://"
)

pytestmark = pytest.mark.skipif(not _RAW, reason="real-DB URL 미설정 — skip")

ORG = uuid.UUID("24000000-0000-0000-0000-000000000001")
PROJ = uuid.UUID("24000000-0000-0000-0000-000000000002")


@pytest.fixture
def anyio_backend():
    return "asyncio"


async def _engine():
    eng = create_async_engine(_ASYNC)
    return eng, async_sessionmaker(eng, expire_on_commit=False)


async def _seed_org_project(s):
    for sql in [
        f"DELETE FROM embeddings WHERE org_id='{ORG}'",
        f"DELETE FROM projects WHERE org_id='{ORG}'",
        f"DELETE FROM organizations WHERE id='{ORG}'",
        f"INSERT INTO organizations (id,name,slug,plan) VALUES ('{ORG}','C24','c24org','free')",
        f"INSERT INTO projects (id,org_id,name) VALUES ('{PROJ}','{ORG}','P')",
    ]:
        await s.execute(text(sql))
    await s.commit()


def _hash(t: str) -> str:
    return hashlib.sha256(t.encode()).hexdigest()


async def test_default_status_pending_embedding_null():
    from app.models.embedding import Embedding

    eng, Session = await _engine()
    try:
        async with Session() as s:
            await _seed_org_project(s)
            entity_id = uuid.uuid4()
            row = Embedding(
                id=uuid.uuid4(), org_id=ORG, project_id=PROJ, entity_type="hypothesis",
                entity_id=entity_id, embedding_text="x", content_hash=_hash("x"),
            )
            s.add(row)
            await s.commit()
            await s.refresh(row)
            assert row.status == "pending"
            assert row.embedding is None
            assert row.model_version is None
            assert row.dimension is None
    finally:
        await eng.dispose()


async def test_entity_type_check_constraint_rejects_invalid_value():
    from app.models.embedding import Embedding

    eng, Session = await _engine()
    try:
        async with Session() as s:
            await _seed_org_project(s)
            s.add(Embedding(
                id=uuid.uuid4(), org_id=ORG, project_id=PROJ, entity_type="story",
                entity_id=uuid.uuid4(), embedding_text="x", content_hash=_hash("x"),
            ))
            with pytest.raises(IntegrityError):
                await s.flush()
            await s.rollback()
    finally:
        await eng.dispose()


async def test_status_check_constraint_rejects_invalid_value():
    from app.models.embedding import Embedding

    eng, Session = await _engine()
    try:
        async with Session() as s:
            await _seed_org_project(s)
            s.add(Embedding(
                id=uuid.uuid4(), org_id=ORG, project_id=PROJ, entity_type="hypothesis",
                entity_id=uuid.uuid4(), embedding_text="x", content_hash=_hash("x"),
                status="done",
            ))
            with pytest.raises(IntegrityError):
                await s.flush()
            await s.rollback()
    finally:
        await eng.dispose()


async def test_unique_entity_type_and_entity_id_rejects_duplicate_row():
    """비-tautological — 같은 (entity_type, entity_id)로 2번째 row 삽입 시도가 실제로
    IntegrityError를 내는지(엔티티당 embedding row 1개 보장)."""
    from app.models.embedding import Embedding

    eng, Session = await _engine()
    try:
        entity_id = uuid.uuid4()
        async with Session() as s:
            await _seed_org_project(s)
            s.add(Embedding(
                id=uuid.uuid4(), org_id=ORG, project_id=PROJ, entity_type="loop",
                entity_id=entity_id, embedding_text="first", content_hash=_hash("first"),
            ))
            await s.commit()

        async with Session() as s:
            s.add(Embedding(
                id=uuid.uuid4(), org_id=ORG, project_id=PROJ, entity_type="loop",
                entity_id=entity_id, embedding_text="second", content_hash=_hash("second"),
            ))
            with pytest.raises(IntegrityError):
                await s.flush()
            await s.rollback()
    finally:
        await eng.dispose()


async def test_same_entity_id_different_entity_type_allowed():
    """entity_id가 우연히 같아도 entity_type이 다르면 별개 row(복합 UNIQUE 확인)."""
    from app.models.embedding import Embedding

    eng, Session = await _engine()
    try:
        shared_id = uuid.uuid4()
        async with Session() as s:
            await _seed_org_project(s)
            s.add(Embedding(
                id=uuid.uuid4(), org_id=ORG, project_id=PROJ, entity_type="hypothesis",
                entity_id=shared_id, embedding_text="h", content_hash=_hash("h"),
            ))
            s.add(Embedding(
                id=uuid.uuid4(), org_id=ORG, project_id=PROJ, entity_type="loop",
                entity_id=shared_id, embedding_text="l", content_hash=_hash("l"),
            ))
            await s.commit()  # 예외 없이 통과해야 함.
    finally:
        await eng.dispose()


async def test_project_delete_cascades_embeddings():
    from app.models.embedding import Embedding

    eng, Session = await _engine()
    try:
        async with Session() as s:
            await _seed_org_project(s)
            row_id = uuid.uuid4()
            s.add(Embedding(
                id=row_id, org_id=ORG, project_id=PROJ, entity_type="loop_artifact",
                entity_id=uuid.uuid4(), embedding_text="x", content_hash=_hash("x"),
            ))
            await s.commit()

        async with Session() as s:
            await s.execute(text(f"DELETE FROM projects WHERE id='{PROJ}'"))
            await s.commit()

        async with Session() as s:
            fetched = (await s.execute(select(Embedding).where(Embedding.id == row_id))).scalar_one_or_none()
            assert fetched is None, "project 삭제 시 embeddings row도 CASCADE로 사라져야 함"
    finally:
        await eng.dispose()


async def test_hnsw_index_exists_with_cosine_ops():
    eng, Session = await _engine()
    try:
        async with Session() as s:
            row = (await s.execute(text(
                "SELECT indexdef FROM pg_indexes WHERE indexname = 'ix_embeddings_embedding_hnsw'"
            ))).scalar_one_or_none()
            assert row is not None, "HNSW 인덱스가 실재해야 함"
            assert "hnsw" in row.lower()
            assert "vector_cosine_ops" in row
    finally:
        await eng.dispose()


async def test_status_pending_partial_index_exists():
    eng, Session = await _engine()
    try:
        async with Session() as s:
            row = (await s.execute(text(
                "SELECT indexdef FROM pg_indexes WHERE indexname = 'ix_embeddings_status_pending'"
            ))).scalar_one_or_none()
            assert row is not None
            assert "pending" in row
    finally:
        await eng.dispose()
