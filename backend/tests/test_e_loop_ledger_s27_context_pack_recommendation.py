"""E-LOOP-LEDGER S27(story 840939c7·P2·L3): Context Pack 능동 추천(synthesis+새 loop→처방) 검증.

핵심(비-tautological):
ⓐ ⭐과신 방지 — synthesis가 None이면(L2 자체가 근거 부족) 추천 생성(generate_text) 자체를
   시도하지 않음(spy로 call_count==0 직접 증명 — S24/S26에서 확립한 spy 관용구 재사용, fake
   path 우연일치 tautological 위험 회피).
ⓑ 프롬프트가 synthesis+새 loop goal/hypothesis만 사용(items 밖 사실 주입 0)함을 텍스트로 직접 확인.
ⓒ graceful degrade — recommendation 생성 실패해도 items(L1)/synthesis(L2)는 무손상.
ⓓ realdb round-trip — full pipeline(synthesis→recommendation) 정합 및 각 단계 독립 실패 격리.

DB env(PARITY_TEST_DATABASE_URL/ALEMBIC_DATABASE_URL) 없으면 realdb 파트 skip.
"""
from __future__ import annotations

import os
import uuid
from datetime import datetime, timezone
from unittest.mock import patch

import pytest

from app.services.context_pack_items import _build_recommendation_prompt, _recommend_next_step

_REAL_DB_URL = os.getenv("PARITY_TEST_DATABASE_URL") or os.getenv("ALEMBIC_DATABASE_URL")


@pytest.fixture
def anyio_backend():
    return "asyncio"


# ── ⓑ 프롬프트 — synthesis+새 loop 필드만 사용 ─────────────────────────────────

def test_recommendation_prompt_contains_goal_synthesis_and_item_count():
    prompt = _build_recommendation_prompt("가격 페이지 CTA 실험", None, "과거 CTA 실험 3건이 저부담 문구를 채택.", 3)
    assert "가격 페이지 CTA 실험" in prompt
    assert "과거 CTA 실험 3건이 저부담 문구를 채택." in prompt
    assert "근거 3건" in prompt
    assert "가설:" not in prompt  # hypothesis 없으면 그 줄 자체가 없어야(밖 사실 주입 0).


def test_recommendation_prompt_includes_hypothesis_when_present():
    prompt = _build_recommendation_prompt("가격 실험", "저부담 문구가 전환율을 높인다", "종합", 1)
    assert "가설: 저부담 문구가 전환율을 높인다" in prompt


def test_recommendation_prompt_instructs_hedge_and_no_fabrication():
    prompt = _build_recommendation_prompt("g", None, "s", 1)
    assert "추정하거나" in prompt and "만들어내지" in prompt
    assert "hedge" in prompt


# ── ⓐ synthesis=None → 추천 자제(generate_text 미호출, spy) ────────────────────

@pytest.mark.anyio
async def test_synthesis_none_skips_recommendation_without_calling_llm():
    from app.models.loop import LoopRun

    loop = LoopRun(id=uuid.uuid4(), org_id=uuid.uuid4(), project_id=uuid.uuid4(), title="L", status="briefing")
    with patch("app.services.llm_client.generate_text") as mock_gen:
        result = await _recommend_next_step(session=None, org_id=loop.org_id, loop=loop, synthesis=None, item_count=0)
    mock_gen.assert_not_called()
    assert result is None


# ── ⓒ graceful degrade — generate_text 실패/미가용 ──────────────────────────────

@pytest.mark.anyio
async def test_llm_unavailable_returns_none_when_no_hypothesis():
    from app.models.loop import LoopRun

    loop = LoopRun(id=uuid.uuid4(), org_id=uuid.uuid4(), project_id=uuid.uuid4(), title="L", status="briefing")
    with patch("app.services.llm_client.generate_text", return_value=None) as mock_gen:
        result = await _recommend_next_step(
            session=None, org_id=loop.org_id, loop=loop, synthesis="과거 종합", item_count=2,
        )
    mock_gen.assert_called_once()
    assert result is None


@pytest.mark.anyio
async def test_llm_exception_returns_none_not_raised():
    from app.models.loop import LoopRun

    loop = LoopRun(id=uuid.uuid4(), org_id=uuid.uuid4(), project_id=uuid.uuid4(), title="L", status="briefing")
    with patch("app.services.llm_client.generate_text", side_effect=RuntimeError("boom")):
        result = await _recommend_next_step(
            session=None, org_id=loop.org_id, loop=loop, synthesis="과거 종합", item_count=2,
        )
    assert result is None


@pytest.mark.anyio
async def test_llm_success_returns_recommendation_and_passes_grounded_prompt():
    from app.models.loop import LoopRun

    loop = LoopRun(id=uuid.uuid4(), org_id=uuid.uuid4(), project_id=uuid.uuid4(), title="가격 실험", status="briefing")
    with patch(
        "app.services.llm_client.generate_text",
        return_value="과거 3건 기준 저부담 문구 우선 권장.",
    ) as mock_gen:
        result = await _recommend_next_step(
            session=None, org_id=loop.org_id, loop=loop, synthesis="과거 종합 텍스트", item_count=3,
        )
    assert result == "과거 3건 기준 저부담 문구 우선 권장."
    passed_prompt = mock_gen.call_args.args[0]
    assert "가격 실험" in passed_prompt and "과거 종합 텍스트" in passed_prompt


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
async def test_full_pipeline_populates_recommendation_with_target_loop_hypothesis_real_db():
    from sqlalchemy import text as _text
    from app.core.database import Base
    from app.models.embedding import Embedding
    from app.models.hypothesis import Hypothesis
    from app.repositories.loop import LoopRunRepository
    from app.services.context_pack_items import build_loop_context_pack

    engine, Session = await _session()
    query_vec = _unit(0)
    past_hyp_id = uuid.uuid4()
    target_hyp_id = uuid.uuid4()

    try:
        async with Session() as s:
            await s.execute(_text("SET session_replication_role = replica"))
            s.add(Hypothesis(
                id=target_hyp_id, org_id=ORG, project_id=PROJECT, owner_member_id=uuid.uuid4(),
                statement="저부담 문구가 전환율을 높인다",
                metric_definition={"metric": "x", "source": "manual", "target": 1, "direction": "up"},
                measure_after=datetime.now(timezone.utc), status="proposed",
            ))
            await s.flush()
            repo = LoopRunRepository(s, ORG)
            target_loop = await repo.create(
                project_id=PROJECT, title="가격 페이지 CTA 실험", goal_tags=[],
                status="draft", hypothesis_id=target_hyp_id, created_by_member_id=uuid.uuid4(),
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
                 patch(
                     "app.services.llm_client.generate_text",
                     side_effect=["과거 실험 1건이 목표 지표를 달성.", "과거 1건 기준 저부담 문구 권장."],
                 ) as mock_gen:
                out = await build_loop_context_pack(s, ORG, loop_obj)

        assert out.synthesis == "과거 실험 1건이 목표 지표를 달성."
        assert out.recommendation == "과거 1건 기준 저부담 문구 권장."
        assert mock_gen.call_count == 2
        recommendation_prompt = mock_gen.call_args_list[1].args[0]
        assert "가격 페이지 CTA 실험" in recommendation_prompt
        assert "저부담 문구가 전환율을 높인다" in recommendation_prompt
    finally:
        async with engine.begin() as conn:
            await conn.run_sync(Base.metadata.drop_all)
        await engine.dispose()


@pytest.mark.skipif(not _REAL_DB_URL, reason="real Postgres 필요(PARITY/ALEMBIC_DATABASE_URL)")
@pytest.mark.anyio
async def test_no_learnable_items_recommendation_none_no_llm_call_real_db():
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
        assert out.recommendation is None
        mock_gen.assert_not_called()
    finally:
        async with engine.begin() as conn:
            await conn.run_sync(Base.metadata.drop_all)
        await engine.dispose()


@pytest.mark.skipif(not _REAL_DB_URL, reason="real Postgres 필요(PARITY/ALEMBIC_DATABASE_URL)")
@pytest.mark.anyio
async def test_synthesis_fails_recommendation_also_none_only_one_llm_attempt_real_db():
    """⭐AC①③ 파이프라인 레벨 실증 — synthesis 자체가 실패(L2 gen-LLM 미가용)하면 recommendation은
    시도조차 안 한다(과잉 처방 방지) — generate_text가 정확히 1회(synthesis 시도)만 불림."""
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
                 patch("app.services.llm_client.generate_text", return_value=None) as mock_gen:
                out = await build_loop_context_pack(s, ORG, loop_obj)

        assert out.synthesis is None
        assert out.recommendation is None
        assert len(out.items) == 1  # items(L1)는 무손상.
        assert mock_gen.call_count == 1  # synthesis 시도만(recommendation은 시도조차 안 함).
    finally:
        async with engine.begin() as conn:
            await conn.run_sync(Base.metadata.drop_all)
        await engine.dispose()
