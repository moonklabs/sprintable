"""E-LOOP-LEDGER P1-S5: embedding backfill 실 Postgres 검증(블루프린트 §P1).

핵심: archived hypothesis/soft-deleted loop/그 소속 artifact가 실제 SQL WHERE로 걸러지는지·
loop_artifact의 project_id가 loop_runs JOIN으로 정확히 해소되는지·재실행이 멱등(content_hash
불변 시 no-op, 중복 row 0)한지를 실 DB round-trip으로 직접 검증.
"""
from __future__ import annotations

import os
import uuid
from datetime import datetime, timezone

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


@pytest.mark.skipif(not _REAL_DB_URL, reason="real Postgres 필요(PARITY/ALEMBIC_DATABASE_URL)")
@pytest.mark.anyio
async def test_backfill_excludes_archived_and_deleted_resolves_project_id_real_db():
    from sqlalchemy import text as _text, select
    from app.core.database import Base
    from app.models.embedding import Embedding
    from app.models.hypothesis import Hypothesis
    from app.models.loop import LoopArtifact, LoopRun
    from app.services.embedding_backfill import backfill_embeddings

    engine, Session = await _session()
    org, project = uuid.uuid4(), uuid.uuid4()
    hyp_active, hyp_archived = uuid.uuid4(), uuid.uuid4()
    loop_alive, loop_deleted = uuid.uuid4(), uuid.uuid4()
    asset_alive, asset_deleted_parent = uuid.uuid4(), uuid.uuid4()
    artifact_alive, artifact_orphaned = uuid.uuid4(), uuid.uuid4()

    try:
        async with Session() as s:
            await s.execute(_text("SET session_replication_role = replica"))
            s.add_all([
                Hypothesis(
                    id=hyp_active, org_id=org, project_id=project, owner_member_id=uuid.uuid4(),
                    statement="살아있는 가설",
                    metric_definition={"metric": "x", "source": "manual", "target": 1, "direction": "up"},
                    measure_after=datetime.now(timezone.utc), status="active",
                ),
                Hypothesis(
                    id=hyp_archived, org_id=org, project_id=project, owner_member_id=uuid.uuid4(),
                    statement="보관된 가설",
                    metric_definition={"metric": "x", "source": "manual", "target": 1, "direction": "up"},
                    measure_after=datetime.now(timezone.utc), status="archived",
                ),
                LoopRun(id=loop_alive, org_id=org, project_id=project, title="살아있는 loop",
                        created_by_member_id=uuid.uuid4()),
                LoopRun(id=loop_deleted, org_id=org, project_id=project, title="삭제된 loop",
                        created_by_member_id=uuid.uuid4(), deleted_at=datetime.now(timezone.utc)),
                LoopArtifact(id=artifact_alive, org_id=org, loop_id=loop_alive, asset_id=asset_alive,
                             variant_group="g1", variant_label="A", created_by_member_id=uuid.uuid4()),
                LoopArtifact(id=artifact_orphaned, org_id=org, loop_id=loop_deleted, asset_id=asset_deleted_parent,
                             variant_group="g1", variant_label="B", created_by_member_id=uuid.uuid4()),
            ])
            await s.commit()

        async with Session() as s:
            counts = await backfill_embeddings(s)
            await s.commit()
        assert counts == {"hypothesis": 1, "loop": 1, "loop_artifact": 1}

        async with Session() as s:
            embedded_entity_ids = set((await s.execute(select(Embedding.entity_id))).scalars().all())

        assert hyp_active in embedded_entity_ids
        assert hyp_archived not in embedded_entity_ids
        assert loop_alive in embedded_entity_ids
        assert loop_deleted not in embedded_entity_ids
        assert artifact_alive in embedded_entity_ids
        assert artifact_orphaned not in embedded_entity_ids  # soft-deleted loop 소속 → 스킵.

        async with Session() as s:
            artifact_emb = (await s.execute(
                select(Embedding).where(Embedding.entity_id == artifact_alive)
            )).scalar_one()
            assert artifact_emb.project_id == project  # loop_runs JOIN으로 해소.
            assert artifact_emb.status == "pending"

        # 멱등 재실행: 동일 entity에 대해 row 중복 생성 안 됨(uq_embeddings_entity 위반 없이 no-op).
        async with Session() as s:
            counts2 = await backfill_embeddings(s)
            await s.commit()
        assert counts2 == {"hypothesis": 1, "loop": 1, "loop_artifact": 1}  # 스캔 대상 수는 동일.
        async with Session() as s:
            total = (await s.execute(select(Embedding))).scalars().all()
            assert len(total) == 3  # 재실행해도 row 수는 그대로(UPSERT, 중복 INSERT 0).
    finally:
        async with engine.begin() as conn:
            await conn.run_sync(Base.metadata.drop_all)
        await engine.dispose()
