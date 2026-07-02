"""E-LOOP-LEDGER S26(story df8dca69·P2·L2): Context Pack 학습 종합(회수 items→증류) 검증.

핵심(비-tautological):
ⓐ ⭐환각 방지 — 프롬프트가 items 필드만 나열(items 밖 지식 주입 0)함을 프롬프트 텍스트로 직접
   확인·items=0건이면 generate_text 자체를 호출 안 함(spy로 call_count==0 직접 증명 — 까심
   S24 RC에서 지적한 "fake path 우연일치" tautological 위험을 피해 처음부터 spy로 작성).
ⓑ graceful degrade — gen-LLM(S25) None/예외 시 synthesis=None이지만 items(L1)는 그대로.
ⓒ realdb round-trip — build_loop_context_pack이 synthesis를 실제로 채워 반환.

DB env(PARITY_TEST_DATABASE_URL/ALEMBIC_DATABASE_URL) 없으면 realdb 파트 skip.
"""
from __future__ import annotations

import os
import uuid
from datetime import datetime, timezone
from unittest.mock import patch

import pytest

from app.schemas.context_pack import (
    ContextPackDecision,
    ContextPackDecisionSide,
    ContextPackItem,
    ContextPackOutcome,
)
from app.services.context_pack_items import _build_synthesis_prompt, _synthesize_learnings

_REAL_DB_URL = os.getenv("PARITY_TEST_DATABASE_URL") or os.getenv("ALEMBIC_DATABASE_URL")


@pytest.fixture
def anyio_backend():
    return "asyncio"


def _sample_item(**overrides) -> ContextPackItem:
    defaults = dict(
        entity_type="loop", entity_id=uuid.uuid4(), similarity=0.9, goal="CTA 문구 실험",
        decision=ContextPackDecision(
            chosen=ContextPackDecisionSide(label="A안", reason="저부담 문구가 클릭률을 높인다"),
            rejected=[ContextPackDecisionSide(label="B안", reason="가격 언급이 부담을 줌")],
        ),
        outcome=ContextPackOutcome(hypothesis_status="verified", metric="cvr", actual=12.4, target=10, direction="up"),
        href="/loops/x",
    )
    defaults.update(overrides)
    return ContextPackItem(**defaults)


# ── ⓐ 환각 방지 — 프롬프트가 items 필드만 나열 ─────────────────────────────────

def test_synthesis_prompt_contains_only_item_fields_no_external_facts():
    item = _sample_item()
    prompt = _build_synthesis_prompt([item])
    assert "CTA 문구 실험" in prompt
    assert "A안" in prompt and "저부담 문구가 클릭률을 높인다" in prompt
    assert "B안" in prompt and "가격 언급이 부담을 줌" in prompt
    assert "verified" in prompt
    # 명시적 환각 금지 지시가 프롬프트에 실제로 포함돼있는지.
    assert "추정하거나" in prompt and "만들어내지" in prompt


def test_synthesis_prompt_handles_missing_reason_gracefully():
    item = _sample_item(decision=ContextPackDecision(
        chosen=ContextPackDecisionSide(label="A안", reason=None), rejected=[],
    ))
    prompt = _build_synthesis_prompt([item])
    assert "(이유 미기록)" in prompt


# ── ⓐ items=0건 → generate_text 자체 미호출(spy) ────────────────────────────

def test_empty_items_returns_none_without_calling_llm():
    with patch("app.services.llm_client.generate_text") as mock_gen:
        result = _synthesize_learnings([])
    mock_gen.assert_not_called()
    assert result is None


# ── ⓑ graceful degrade ──────────────────────────────────────────────────────

def test_llm_unavailable_returns_none():
    item = _sample_item()
    with patch("app.services.llm_client.generate_text", return_value=None) as mock_gen:
        result = _synthesize_learnings([item])
    mock_gen.assert_called_once()
    assert result is None


def test_llm_exception_returns_none_not_raised():
    item = _sample_item()
    with patch("app.services.llm_client.generate_text", side_effect=RuntimeError("boom")):
        result = _synthesize_learnings([item])
    assert result is None


def test_llm_success_returns_synthesis_text():
    item = _sample_item()
    with patch("app.services.llm_client.generate_text", return_value="과거 CTA 실험 1건 — 저부담 문구 채택.") as mock_gen:
        result = _synthesize_learnings([item])
    assert result == "과거 CTA 실험 1건 — 저부담 문구 채택."
    passed_prompt = mock_gen.call_args.args[0]
    assert "CTA 문구 실험" in passed_prompt


# ── realdb ───────────────────────────────────────────────────────────────────

ORG = uuid.uuid4()
PROJECT = uuid.uuid4()


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


@pytest.mark.skipif(not _REAL_DB_URL, reason="real Postgres 필요(PARITY/ALEMBIC_DATABASE_URL)")
@pytest.mark.anyio
async def test_build_loop_context_pack_populates_synthesis_real_db():
    from sqlalchemy import text as _text
    from app.core.database import Base
    from app.models.embedding import Embedding
    from app.models.hypothesis import Hypothesis
    from app.repositories.loop import LoopRunRepository
    from app.services.context_pack_items import build_loop_context_pack

    engine, Session = await _session()
    query_vec = _unit(0)
    past_hyp_id = uuid.uuid4()

    try:
        async with Session() as s:
            await s.execute(_text("SET session_replication_role = replica"))
            repo = LoopRunRepository(s, ORG)
            target_loop = await repo.create(
                project_id=PROJECT, title="타깃 loop", goal_tags=[],
                status="draft", created_by_member_id=uuid.uuid4(),
            )
            s.add(Hypothesis(
                id=past_hyp_id, org_id=ORG, project_id=PROJECT, owner_member_id=uuid.uuid4(),
                statement="과거 실험", metric_definition={"metric": "x", "source": "manual", "target": 1, "direction": "up"},
                measure_after=datetime.now(timezone.utc), status="verified",
                outcome_result={"metric": "cvr", "actual": 18.4, "target": 18, "direction": "up"},
            ))
            await s.flush()
            s.add(Embedding(
                id=uuid.uuid4(), org_id=ORG, project_id=PROJECT,
                entity_type="hypothesis", entity_id=past_hyp_id,
                embedding_text="과거 실험", content_hash="h1",
                embedding=query_vec, model_version="m", dimension=768, status="ready",
            ))
            await s.commit()

        async with Session() as s:
            loop_obj = await LoopRunRepository(s, ORG).get(target_loop.id)
            with patch("app.services.embedding_client.embed_text", return_value=query_vec), \
                 patch("app.services.llm_client.generate_text", return_value="과거 실험 1건이 목표 지표를 달성.") as mock_gen:
                out = await build_loop_context_pack(s, ORG, loop_obj)

        assert out.synthesis == "과거 실험 1건이 목표 지표를 달성."
        mock_gen.assert_called_once()
        assert len(out.items) == 1
    finally:
        async with engine.begin() as conn:
            await conn.run_sync(Base.metadata.drop_all)
        await engine.dispose()


@pytest.mark.skipif(not _REAL_DB_URL, reason="real Postgres 필요(PARITY/ALEMBIC_DATABASE_URL)")
@pytest.mark.anyio
async def test_build_loop_context_pack_no_learnable_items_synthesis_none_no_llm_call_real_db():
    """학습된 선례가 0건(S12 필터로 전부 걸러짐)이면 synthesis=None이고 gen-LLM 호출 자체가
    없어야 한다(spy) — 빈 프롬프트로라도 LLM을 부르는 낭비/오동작을 실 파이프라인으로 실증."""
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
            with patch("app.services.embedding_client.embed_text", return_value=_unit(0)), \
                 patch("app.services.llm_client.generate_text") as mock_gen:
                out = await build_loop_context_pack(s, ORG, loop_obj)

        assert out.items == []
        assert out.synthesis is None
        mock_gen.assert_not_called()
    finally:
        async with engine.begin() as conn:
            await conn.run_sync(Base.metadata.drop_all)
        await engine.dispose()


@pytest.mark.skipif(not _REAL_DB_URL, reason="real Postgres 필요(PARITY/ALEMBIC_DATABASE_URL)")
@pytest.mark.anyio
async def test_build_loop_context_pack_llm_unavailable_items_still_returned_real_db():
    """⭐AC③ graceful — gen-LLM 미가용이어도 items(L1)는 퇴화 없이 그대로 반환."""
    from sqlalchemy import text as _text
    from app.core.database import Base
    from app.models.embedding import Embedding
    from app.models.hypothesis import Hypothesis
    from app.repositories.loop import LoopRunRepository
    from app.services.context_pack_items import build_loop_context_pack

    engine, Session = await _session()
    query_vec = _unit(0)
    past_hyp_id = uuid.uuid4()

    try:
        async with Session() as s:
            await s.execute(_text("SET session_replication_role = replica"))
            repo = LoopRunRepository(s, ORG)
            target_loop = await repo.create(
                project_id=PROJECT, title="타깃 loop", goal_tags=[],
                status="draft", created_by_member_id=uuid.uuid4(),
            )
            s.add(Hypothesis(
                id=past_hyp_id, org_id=ORG, project_id=PROJECT, owner_member_id=uuid.uuid4(),
                statement="과거 실험", metric_definition={"metric": "x", "source": "manual", "target": 1, "direction": "up"},
                measure_after=datetime.now(timezone.utc), status="verified",
                outcome_result={"metric": "cvr", "actual": 18.4, "target": 18, "direction": "up"},
            ))
            await s.flush()
            s.add(Embedding(
                id=uuid.uuid4(), org_id=ORG, project_id=PROJECT,
                entity_type="hypothesis", entity_id=past_hyp_id,
                embedding_text="과거 실험", content_hash="h1",
                embedding=query_vec, model_version="m", dimension=768, status="ready",
            ))
            await s.commit()

        async with Session() as s:
            loop_obj = await LoopRunRepository(s, ORG).get(target_loop.id)
            with patch("app.services.embedding_client.embed_text", return_value=query_vec), \
                 patch("app.services.llm_client.generate_text", return_value=None):
                out = await build_loop_context_pack(s, ORG, loop_obj)

        assert out.synthesis is None
        assert len(out.items) == 1
        assert out.items[0].goal == "과거 실험"
    finally:
        async with engine.begin() as conn:
            await conn.run_sync(Base.metadata.drop_all)
        await engine.dispose()
