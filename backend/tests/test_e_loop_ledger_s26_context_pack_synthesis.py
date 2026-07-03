"""E-LOOP-LEDGER S26(story df8dca69·P2·L2): Context Pack 학습 종합(회수 items→증류) 검증.

S28(선생님 dogfood 지적) 이후 갱신: Gemini→Claude(disabled) 전환·프롬프트 v2(순환 재진술
금지+outcome 우선+구조화)·confidence 마커 파싱 추가. 이 파일은 그 갱신 반영판.

핵심(비-tautological):
ⓐ ⭐환각 방지 — 프롬프트가 items 필드만 나열(items 밖 지식 주입 0)함을 프롬프트 텍스트로 직접
   확인·items=0건이면 generate_text 자체를 호출 안 함(spy로 call_count==0 직접 증명).
ⓑ graceful degrade — gen-LLM None/예외 시 (None, None)이지만 items(L1)는 그대로.
ⓒ realdb round-trip — build_loop_context_pack이 synthesis/confidence/evidence_count를
   실제로 채워 반환.

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
from app.services.context_pack_items import (
    _build_synthesis_prompt,
    _extract_confidence,
    _synthesize_learnings,
)

_REAL_DB_URL = os.getenv("PARITY_TEST_DATABASE_URL") or os.getenv("ALEMBIC_DATABASE_URL")

# story 8236bbc3: create_all/drop_all로 자체 스키마 직접 관리 — 공유 alembic-migrated DB
# 오염 방지 위해 격리 DB 전용(conftest.py 가드가 마커 누락을 자동 검출).
pytestmark = pytest.mark.destructive_schema


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
    assert "추정하거나" in prompt and "만들어내지" in prompt


def test_synthesis_prompt_handles_missing_reason_gracefully():
    item = _sample_item(decision=ContextPackDecision(
        chosen=ContextPackDecisionSide(label="A안", reason=None), rejected=[],
    ))
    prompt = _build_synthesis_prompt([item])
    assert "(이유 미기록)" in prompt


# ── ⭐S28 v2: 순환 재진술 금지+outcome 우선+구조화+confidence 마커 지시 ──────────────

def test_synthesis_prompt_v2_forbids_simple_restatement():
    prompt = _build_synthesis_prompt([_sample_item()])
    assert "재진술" in prompt and "금지" in prompt


def test_synthesis_prompt_v2_prioritizes_outcome_as_fact():
    prompt = _build_synthesis_prompt([_sample_item()])
    assert "성과" in prompt and "최우선 근거" in prompt


def test_synthesis_prompt_v2_requires_structured_sections():
    prompt = _build_synthesis_prompt([_sample_item()])
    for section in ("패턴:", "다음 행동:", "회피:", "리스크:"):
        assert section in prompt


def test_synthesis_prompt_v2_requests_confidence_marker():
    prompt = _build_synthesis_prompt([_sample_item()])
    assert "confidence: high|medium|low" in prompt


# ── confidence 마커 파싱 ─────────────────────────────────────────────────────

def test_extract_confidence_parses_marker_and_strips_it():
    raw = "패턴: 저부담 문구가 이긴다.\n다음 행동: 참신한 문구 시도.\n\nconfidence: high"
    text, confidence = _extract_confidence(raw)
    assert confidence == "high"
    assert "confidence" not in text.lower()
    assert "패턴: 저부담 문구가 이긴다." in text


def test_extract_confidence_case_insensitive_and_whitespace_tolerant():
    raw = "본문 내용.\n  Confidence:   MEDIUM  "
    text, confidence = _extract_confidence(raw)
    assert confidence == "medium"
    assert "confidence" not in text.lower()


def test_extract_confidence_missing_marker_returns_none_but_preserves_text():
    raw = "마커 없는 그냥 본문입니다."
    text, confidence = _extract_confidence(raw)
    assert confidence is None
    assert text == "마커 없는 그냥 본문입니다."


def test_extract_confidence_invalid_value_not_matched_preserves_original():
    raw = "본문.\nconfidence: extreme"
    text, confidence = _extract_confidence(raw)
    assert confidence is None
    assert "confidence: extreme" in text  # 매칭 실패 시 원문 그대로(본문 보존 우선).


# ── ⓐ items=0건 → generate_text 자체 미호출(spy) ────────────────────────

def test_empty_items_returns_none_without_calling_llm():
    with patch("app.services.llm_client.generate_text") as mock_gen:
        result, confidence = _synthesize_learnings([])
    mock_gen.assert_not_called()
    assert result is None and confidence is None


# ── ⓑ graceful degrade ──────────────────────────────────────────────────────

def test_llm_unavailable_returns_none():
    item = _sample_item()
    with patch("app.services.llm_client.generate_text", return_value=None) as mock_gen:
        result, confidence = _synthesize_learnings([item])
    mock_gen.assert_called_once()
    assert result is None and confidence is None


def test_llm_exception_returns_none_not_raised():
    item = _sample_item()
    with patch("app.services.llm_client.generate_text", side_effect=RuntimeError("boom")):
        result, confidence = _synthesize_learnings([item])
    assert result is None and confidence is None


def test_llm_success_returns_synthesis_text():
    item = _sample_item()
    with patch(
        "app.services.llm_client.generate_text",
        return_value="과거 CTA 실험 1건 — 저부담 문구 채택.\nconfidence: low",
    ) as mock_gen:
        result, confidence = _synthesize_learnings([item])
    assert result == "과거 CTA 실험 1건 — 저부담 문구 채택."
    assert confidence == "low"
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
async def test_build_loop_context_pack_populates_synthesis_confidence_evidence_count_real_db():
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
                 patch(
                     "app.services.llm_client.generate_text",
                     return_value="과거 실험 1건이 목표 지표를 달성.\nconfidence: high",
                 ) as mock_gen:
                out = await build_loop_context_pack(s, ORG, loop_obj)

        assert out.synthesis == "과거 실험 1건이 목표 지표를 달성."
        assert out.synthesis_confidence == "high"
        assert out.evidence_count == 1
        assert mock_gen.call_count >= 1
        first_call = mock_gen.call_args_list[0]
        assert "과거 실험" in first_call.args[0]
        assert len(out.items) == 1
    finally:
        async with engine.begin() as conn:
            await conn.run_sync(Base.metadata.drop_all)
        await engine.dispose()


@pytest.mark.skipif(not _REAL_DB_URL, reason="real Postgres 필요(PARITY/ALEMBIC_DATABASE_URL)")
@pytest.mark.anyio
async def test_build_loop_context_pack_no_learnable_items_synthesis_none_no_llm_call_real_db():
    """학습된 선례가 0건(S12 필터로 전부 걸러짐)이면 synthesis=None·evidence_count=0이고
    gen-LLM 호출 자체가 없어야 한다(spy) — 빈 프롬프트로라도 LLM을 부르는 낭비/오동작을
    실 파이프라인으로 실증."""
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
        assert out.evidence_count == 0
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
        assert out.synthesis_confidence is None
        assert out.evidence_count == 1  # ⭐evidence_count는 LLM 성패와 무관 — items 기반 결정론.
        assert len(out.items) == 1
        assert out.items[0].goal == "과거 실험"
    finally:
        async with engine.begin() as conn:
            await conn.run_sync(Base.metadata.drop_all)
        await engine.dispose()


@pytest.mark.skipif(not _REAL_DB_URL, reason="real Postgres 필요(PARITY/ALEMBIC_DATABASE_URL)")
@pytest.mark.anyio
async def test_build_loop_context_pack_cache_hit_skips_llm_call_real_db():
    """⭐S28 AC④ 캐싱 — 같은 items/loop 맥락으로 두 번째 GET은 gen-LLM을 다시 호출하지 않고
    캐시된 synthesis/recommendation을 그대로 반환한다("같은 입력=1회만 호출")."""
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

        # 1차 GET — 캐시 미스, LLM 호출.
        async with Session() as s:
            loop_obj = await LoopRunRepository(s, ORG).get(target_loop.id)
            with patch("app.services.embedding_client.embed_text", return_value=query_vec), \
                 patch(
                     "app.services.llm_client.generate_text",
                     return_value="첫 응답.\nconfidence: medium",
                 ) as mock_gen_1:
                out1 = await build_loop_context_pack(s, ORG, loop_obj)
            await s.commit()  # LoopRunRepository.update()의 flush를 실제로 커밋(다음 세션에서 캐시 보이게).
        assert out1.synthesis == "첫 응답."
        assert mock_gen_1.call_count >= 1

        # 2차 GET(동일 items/loop) — 캐시 히트, LLM 미호출. 반환값도 mock2가 아니라 캐시값이어야.
        async with Session() as s:
            loop_obj2 = await LoopRunRepository(s, ORG).get(target_loop.id)
            with patch("app.services.embedding_client.embed_text", return_value=query_vec), \
                 patch(
                     "app.services.llm_client.generate_text",
                     return_value="두번째 응답이면 버그.",
                 ) as mock_gen_2:
                out2 = await build_loop_context_pack(s, ORG, loop_obj2)

        mock_gen_2.assert_not_called()
        assert out2.synthesis == "첫 응답."  # 캐시된 값 그대로(두번째 mock 응답 아님).
        assert out2.synthesis_confidence == "medium"
        assert out2.evidence_count == 1
    finally:
        async with engine.begin() as conn:
            await conn.run_sync(Base.metadata.drop_all)
        await engine.dispose()


@pytest.mark.skipif(not _REAL_DB_URL, reason="real Postgres 필요(PARITY/ALEMBIC_DATABASE_URL)")
@pytest.mark.anyio
async def test_build_loop_context_pack_recommendation_transient_failure_not_permanently_cached_real_db():
    """⭐까심 QA RC(2026-07-02): synthesis는 성공·recommendation만 일시장애(quota/timeout)로
    실패(None)해도 캐시에 기록되면 안 된다 — 기록되면 다음 요청이 캐시히트로 LLM을 다시
    안 불러 recommendation=None이 영구 고착된다. 캐시 미기록 → 다음 GET이 둘 다 재시도해야."""
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

        # 1차 GET — synthesis 성공 + recommendation 일시장애(None). 호출 순서: synthesis→recommendation.
        async with Session() as s:
            loop_obj = await LoopRunRepository(s, ORG).get(target_loop.id)
            with patch("app.services.embedding_client.embed_text", return_value=query_vec), \
                 patch(
                     "app.services.llm_client.generate_text",
                     side_effect=["synthesis 1.\nconfidence: high", None],
                 ) as mock_gen_1:
                out1 = await build_loop_context_pack(s, ORG, loop_obj)
            await s.commit()
        assert out1.synthesis == "synthesis 1."
        assert out1.recommendation is None
        assert mock_gen_1.call_count == 2

        # 2차 GET(동일 items/loop) — 캐시가 기록되지 않았어야 하므로 synthesis+recommendation
        # 둘 다 재시도(캐시히트였다면 mock_gen_2가 전혀 호출 안 됐을 것).
        async with Session() as s:
            loop_obj2 = await LoopRunRepository(s, ORG).get(target_loop.id)
            with patch("app.services.embedding_client.embed_text", return_value=query_vec), \
                 patch(
                     "app.services.llm_client.generate_text",
                     side_effect=["synthesis 2.\nconfidence: high", "recommendation 2.\nconfidence: medium"],
                 ) as mock_gen_2:
                out2 = await build_loop_context_pack(s, ORG, loop_obj2)

        assert mock_gen_2.call_count == 2  # 캐시 미기록 → 둘 다 재호출(복구 확인).
        assert out2.synthesis == "synthesis 2."
        assert out2.recommendation == "recommendation 2."
    finally:
        async with engine.begin() as conn:
            await conn.run_sync(Base.metadata.drop_all)
        await engine.dispose()


@pytest.mark.skipif(not _REAL_DB_URL, reason="real Postgres 필요(PARITY/ALEMBIC_DATABASE_URL)")
@pytest.mark.anyio
async def test_build_loop_context_pack_cache_invalidates_when_decision_changes_real_db():
    """⭐캐시 무효화 — 선례 decision이 바뀌면(예: 새 chosen 확정) content-hash가 달라져 캐시가
    자동 무효화되고 LLM이 다시 호출된다(stale 캐시 방지)."""
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
            hyp = Hypothesis(
                id=past_hyp_id, org_id=ORG, project_id=PROJECT, owner_member_id=uuid.uuid4(),
                statement="과거 실험", metric_definition={"metric": "x", "source": "manual", "target": 1, "direction": "up"},
                measure_after=datetime.now(timezone.utc), status="verified",
                outcome_result={"metric": "cvr", "actual": 18.4, "target": 18, "direction": "up"},
            )
            s.add(hyp)
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
                 patch("app.services.llm_client.generate_text", return_value="첫 응답."):
                await build_loop_context_pack(s, ORG, loop_obj)
            await s.commit()  # 캐시 write를 실제로 커밋.

        # outcome 변경(재측정 시나리오) — 캐시 키가 바뀌어야.
        async with Session() as s:
            hyp_row = await s.get(Hypothesis, past_hyp_id)
            hyp_row.outcome_result = {"metric": "cvr", "actual": 25.0, "target": 18, "direction": "up"}
            await s.commit()

        async with Session() as s:
            loop_obj2 = await LoopRunRepository(s, ORG).get(target_loop.id)
            with patch("app.services.embedding_client.embed_text", return_value=query_vec), \
                 patch(
                     "app.services.llm_client.generate_text", return_value="갱신된 응답.",
                 ) as mock_gen_2:
                out2 = await build_loop_context_pack(s, ORG, loop_obj2)

        # 캐시 무효화 → synthesis+recommendation 둘 다 재호출(synthesis 성공 시 recommendation도 시도).
        assert mock_gen_2.call_count == 2
        assert out2.synthesis == "갱신된 응답."
    finally:
        async with engine.begin() as conn:
            await conn.run_sync(Base.metadata.drop_all)
        await engine.dispose()
