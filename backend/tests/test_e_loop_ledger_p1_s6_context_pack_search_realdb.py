"""E-LOOP-LEDGER P1-S6: context-pack 유사도 검색 실 Postgres 검증(블루프린트 §P1).

핵심: pgvector cosine 거리 실 ORDER BY(가까운 벡터가 먼저)·status='ready'만 대상·orphan
정리(archived hypothesis/soft-deleted loop을 가리키는 stale embedding 드롭)를 실 DB round-trip으로
직접 검증. HNSW 인덱스가 생긴 이후 embedding 컬럼에 대한 이 코드베이스 첫 실 쿼리.
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


def _unit(i: int, dim: int = 768) -> list[float]:
    """i번째 축만 1.0인 단위벡터 — cosine 거리로 서로 직교(거리 1.0), 자기자신과는 거리 0."""
    v = [0.0] * dim
    v[i] = 1.0
    return v


def _near(i: int, dim: int = 768) -> list[float]:
    """i번째 축에 살짝 못 미치는 벡터 — _unit(i)와 방향이 거의 같아(코사인 거리 작음) '가까움' 표현."""
    v = [0.01] * dim
    v[i] = 0.99
    return v


def _opposite(i: int, dim: int = 768) -> list[float]:
    """i번째 축의 반대 방향 단위벡터 — query(axis i)와 코사인 거리 2(유사도 -1), 가장 멀다."""
    v = [0.0] * dim
    v[i] = -1.0
    return v


@pytest.mark.skipif(not _REAL_DB_URL, reason="real Postgres 필요(PARITY/ALEMBIC_DATABASE_URL)")
@pytest.mark.anyio
async def test_cosine_order_and_orphan_filtering_real_db():
    from sqlalchemy import text as _text, select
    from app.core.database import Base
    from app.models.embedding import Embedding
    from app.models.hypothesis import Hypothesis
    from app.models.loop import LoopRun
    from app.services.context_pack_search import search_similar_embeddings

    engine, Session = await _session()
    org, project = uuid.uuid4(), uuid.uuid4()
    query_vec = _unit(0)  # query가 axis 0을 향함 → axis 0에 가까운 embedding이 먼저 나와야 함.

    hyp_alive, hyp_archived = uuid.uuid4(), uuid.uuid4()
    loop_alive, loop_deleted = uuid.uuid4(), uuid.uuid4()
    artifact_id = uuid.uuid4()
    other_org_embedding = uuid.uuid4()

    try:
        async with Session() as s:
            await s.execute(_text("SET session_replication_role = replica"))
            s.add_all([
                Hypothesis(
                    id=hyp_alive, org_id=org, project_id=project, owner_member_id=uuid.uuid4(),
                    statement="살아있는 가설",
                    metric_definition={"metric": "x", "source": "manual", "target": 1, "direction": "up"},
                    measure_after=datetime.now(timezone.utc),
                    status="active",
                ),
                Hypothesis(
                    id=hyp_archived, org_id=org, project_id=project, owner_member_id=uuid.uuid4(),
                    statement="보관된 가설",
                    metric_definition={"metric": "x", "source": "manual", "target": 1, "direction": "up"},
                    measure_after=datetime.now(timezone.utc),
                    status="archived",
                ),
                LoopRun(id=loop_alive, org_id=org, project_id=project, title="살아있는 loop",
                        created_by_member_id=uuid.uuid4()),
                LoopRun(id=loop_deleted, org_id=org, project_id=project, title="삭제된 loop",
                        created_by_member_id=uuid.uuid4(), deleted_at=datetime.now(timezone.utc)),
            ])
            await s.flush()
            # 가장 query와 가까운(axis 0) — 살아있는 hypothesis, 최상위 노출 기대.
            s.add_all([
                Embedding(id=uuid.uuid4(), org_id=org, project_id=project,
                          entity_type="hypothesis", entity_id=hyp_alive,
                          embedding_text="alive hyp", content_hash="h1",
                          embedding=_near(0), model_version="m", dimension=768, status="ready"),
                Embedding(id=uuid.uuid4(), org_id=org, project_id=project,
                          entity_type="hypothesis", entity_id=hyp_archived,
                          embedding_text="archived hyp", content_hash="h2",
                          embedding=_near(0), model_version="m", dimension=768, status="ready"),
                Embedding(id=uuid.uuid4(), org_id=org, project_id=project,
                          entity_type="loop", entity_id=loop_alive,
                          embedding_text="alive loop", content_hash="h3",
                          embedding=_unit(1), model_version="m", dimension=768, status="ready"),
                Embedding(id=uuid.uuid4(), org_id=org, project_id=project,
                          entity_type="loop", entity_id=loop_deleted,
                          embedding_text="deleted loop", content_hash="h4",
                          embedding=_unit(1), model_version="m", dimension=768, status="ready"),
                Embedding(id=uuid.uuid4(), org_id=org, project_id=project,
                          entity_type="loop_artifact", entity_id=artifact_id,
                          embedding_text="artifact", content_hash="h5",
                          embedding=_opposite(0), model_version="m", dimension=768, status="ready"),
                # status='pending'(아직 미임베딩) → 검색 결과에서 제외돼야.
                Embedding(id=uuid.uuid4(), org_id=org, project_id=project,
                          entity_type="loop_artifact", entity_id=uuid.uuid4(),
                          embedding_text="not yet embedded", content_hash="h6",
                          status="pending"),
                # 다른 project → 결과에서 제외돼야.
                Embedding(id=other_org_embedding, org_id=org, project_id=uuid.uuid4(),
                          entity_type="loop_artifact", entity_id=uuid.uuid4(),
                          embedding_text="other project", content_hash="h7",
                          embedding=_near(0), model_version="m", dimension=768, status="ready"),
            ])
            await s.commit()

        async with Session() as s:
            results = await search_similar_embeddings(s, org, project, query_vec, limit=10)

        ids = [r.entity_id for r in results]
        # orphan 정리: archived hypothesis·soft-deleted loop 제외.
        assert hyp_archived not in ids
        assert loop_deleted not in ids
        # 다른 project·pending 상태는 애초 SQL WHERE로 제외.
        assert other_org_embedding not in [r.entity_id for r in results]
        # 살아있는 3건(hyp_alive, loop_alive, artifact_id)만 남음.
        assert set(ids) == {hyp_alive, loop_alive, artifact_id}
        # 코사인 순서: query(axis 0)에 가장 가까운 hyp_alive(_near(0))가 최상위.
        assert ids[0] == hyp_alive
        assert results[0].similarity > results[1].similarity > results[2].similarity
    finally:
        async with engine.begin() as conn:
            await conn.run_sync(Base.metadata.drop_all)
        await engine.dispose()
