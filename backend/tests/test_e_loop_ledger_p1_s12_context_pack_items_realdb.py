"""E-LOOP-LEDGER P1-S12: context-pack structured JSON 실 Postgres 검증(doc fbe5923e §3).

핵심: 실 pgvector 유사도 검색+outcome 재로드+decision(chosen/top-rejected) 조립이 실 DB
round-trip으로 정확히 동작하는지 검증. entity_type 매핑(loop_artifact→'decision')·href·
similarity-desc 정렬도 함께 확인.
"""
from __future__ import annotations

import os
import uuid
from datetime import datetime, timezone
from unittest.mock import patch

import pytest

_REAL_DB_URL = os.getenv("PARITY_TEST_DATABASE_URL") or os.getenv("ALEMBIC_DATABASE_URL")

ORG = uuid.uuid4()
PROJECT = uuid.uuid4()


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
    v = [0.0] * dim
    v[i] = 1.0
    return v


def _near(i: int, dim: int = 768) -> list[float]:
    v = [0.01] * dim
    v[i] = 0.99
    return v


@pytest.mark.skipif(not _REAL_DB_URL, reason="real Postgres 필요(PARITY/ALEMBIC_DATABASE_URL)")
@pytest.mark.anyio
async def test_full_round_trip_maps_hypothesis_and_loop_with_decision_real_db():
    from sqlalchemy import text as _text
    from app.core.database import Base
    from app.models.embedding import Embedding
    from app.models.hypothesis import Hypothesis
    from app.models.loop import LoopArtifact, LoopRun
    from app.repositories.loop import LoopRunRepository
    from app.services.context_pack_items import build_loop_context_pack

    engine, Session = await _session()
    query_vec = _unit(0)

    past_hyp_id = uuid.uuid4()
    past_loop_id = uuid.uuid4()
    chosen_id, rejected_id = uuid.uuid4(), uuid.uuid4()
    asset_id = uuid.uuid4()

    try:
        async with Session() as s:
            await s.execute(_text("SET session_replication_role = replica"))
            repo = LoopRunRepository(s, ORG)
            target_loop = await repo.create(
                project_id=PROJECT, title="타깃 loop", goal_tags=[],
                status="draft", created_by_member_id=uuid.uuid4(),
            )
            s.add_all([
                Hypothesis(
                    id=past_hyp_id, org_id=ORG, project_id=PROJECT, owner_member_id=uuid.uuid4(),
                    statement="과거 실험", metric_definition={"metric": "x", "source": "manual", "target": 1, "direction": "up"},
                    measure_after=datetime.now(timezone.utc), status="verified",
                    outcome_result={"metric": "cvr", "actual": 18.4, "target": 18, "direction": "up"},
                ),
                LoopRun(id=past_loop_id, org_id=ORG, project_id=PROJECT, title="과거 loop",
                        created_by_member_id=uuid.uuid4(), status="closed"),
            ])
            await s.flush()
            s.add_all([
                LoopArtifact(id=chosen_id, org_id=ORG, loop_id=past_loop_id, asset_id=asset_id,
                             variant_group="g1", variant_label="A안", decision="chosen",
                             choose_reason="가설정렬", created_by_member_id=uuid.uuid4()),
                LoopArtifact(id=rejected_id, org_id=ORG, loop_id=past_loop_id, asset_id=asset_id,
                             variant_group="g1", variant_label="B안", decision="rejected",
                             rejection_reason="이전 miss", created_by_member_id=uuid.uuid4()),
                Embedding(id=uuid.uuid4(), org_id=ORG, project_id=PROJECT,
                          entity_type="hypothesis", entity_id=past_hyp_id,
                          embedding_text="과거 실험", content_hash="h1",
                          embedding=_near(0), model_version="m", dimension=768, status="ready"),
                Embedding(id=uuid.uuid4(), org_id=ORG, project_id=PROJECT,
                          entity_type="loop", entity_id=past_loop_id,
                          embedding_text="과거 loop", content_hash="h2",
                          embedding=_unit(1), model_version="m", dimension=768, status="ready"),
            ])
            await s.commit()

        async with Session() as s:
            loop_obj = await LoopRunRepository(s, ORG).get(target_loop.id)
            with patch("app.services.embedding_client.embed_text", return_value=query_vec):
                out = await build_loop_context_pack(s, ORG, loop_obj)

        assert out.embed_available is True
        assert len(out.items) == 2
        # similarity-desc: 가까운(hyp, _near(0)) 먼저.
        assert out.items[0].entity_type == "hypothesis"
        assert out.items[0].goal == "과거 실험"
        assert out.items[0].outcome.hypothesis_status == "verified"
        assert out.items[0].outcome.actual == 18.4
        assert out.items[0].decision is None
        # 미르코 FE 라우트 실측: 독립 hypothesis 상세 페이지 없음 → href는 null(broken link 방지).
        assert out.items[0].href is None

        loop_item = out.items[1]
        assert loop_item.entity_type == "loop"
        assert loop_item.goal == "과거 loop"
        assert loop_item.decision.chosen.label == "A안"
        assert loop_item.decision.rejected[0].label == "B안"
        assert loop_item.href == f"/loops/{past_loop_id}"
        assert loop_item.outcome is None  # 이 loop엔 hypothesis_id 연결 없음(null).
    finally:
        async with engine.begin() as conn:
            await conn.run_sync(Base.metadata.drop_all)
        await engine.dispose()


@pytest.mark.skipif(not _REAL_DB_URL, reason="real Postgres 필요(PARITY/ALEMBIC_DATABASE_URL)")
@pytest.mark.anyio
async def test_embed_unavailable_real_db():
    from sqlalchemy import text as _text
    from app.core.database import Base
    from app.repositories.loop import LoopRunRepository
    from app.services.context_pack_items import build_loop_context_pack

    engine, Session = await _session()
    try:
        async with Session() as s:
            await s.execute(_text("SET session_replication_role = replica"))
            repo = LoopRunRepository(s, ORG)
            loop = await repo.create(
                project_id=PROJECT, title="타깃 loop", goal_tags=[],
                status="draft", created_by_member_id=uuid.uuid4(),
            )
            await s.commit()

        async with Session() as s:
            loop_obj = await LoopRunRepository(s, ORG).get(loop.id)
            with patch("app.services.embedding_client.embed_text", return_value=None):
                out = await build_loop_context_pack(s, ORG, loop_obj)
        assert out.embed_available is False
        assert out.items == []
    finally:
        async with engine.begin() as conn:
            await conn.run_sync(Base.metadata.drop_all)
        await engine.dispose()
