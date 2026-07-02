"""E-LOOP-LEDGER S15(story 2d1e02c0·P2): hypothesis 자동초안 — gen-LLM(S25) 근본 구현.

핵심(비-tautological, S26/S27과 동형 원칙 재사용):
ⓐ 맥락(title/description/summary) 전무면 LLM 호출 자체를 안 함(spy) — 근거 없이 지어내지 않음.
ⓑ 프롬프트가 맥락 필드만 사용(밖 사실 주입 0)·no-fabrication 지시 포함.
ⓒ graceful fallback — LLM 미가용/예외/빈 응답 시 기존 deterministic 템플릿으로 무손상 대체
   (fallback이 "우연"이 아니라 실제 경로임을 각 실패모드별로 직접 검증).
ⓓ "돕되 대체 안 함" — draft_hypothesis는 항상 status='proposed'만 생성(active 자동생성 없음,
   create_hypothesis의 기존 human-only active 정책을 그대로 통과·우회 없음).
ⓔ draft_metadata.generation_method가 실제 사용된 경로(llm/template)를 정확히 기록.

DB 불요(mock 세션) — test_hypothesis_service.py와 동형 하네스, 이 파일은 S15 신규 로직만
독립 검증한다(cross-project 등 create_hypothesis 공통 가드는 기존 파일이 커버).
"""
from __future__ import annotations

import uuid
from datetime import datetime, timezone
from types import SimpleNamespace
from unittest.mock import AsyncMock, MagicMock, patch

import pytest

from app.schemas.hypothesis import HypothesisDraftRequest
from app.services import hypothesis as svc
from app.services.hypothesis import _build_draft_prompt, _draft_statement, _template_statement
from app.services.member_resolver import ResolvedMember

ORG_ID = uuid.uuid4()
PROJECT_ID = uuid.uuid4()
CALLER_ID = uuid.uuid4()
HYP_ID = uuid.uuid4()


@pytest.fixture
def anyio_backend():
    return "asyncio"


@pytest.fixture(autouse=True)
def _mock_embedding_enqueue():
    with patch("app.services.embedding_enqueue.enqueue_embedding", new=AsyncMock(return_value=None)):
        yield


# ── ⓑ 프롬프트 — 맥락 필드만 사용 ────────────────────────────────────────────

def test_build_draft_prompt_none_context_returns_none():
    assert _build_draft_prompt(None) is None


def test_build_draft_prompt_empty_context_returns_none():
    assert _build_draft_prompt({}) is None
    assert _build_draft_prompt({"title": "", "description": None}) is None


def test_build_draft_prompt_title_only_omits_other_sections():
    prompt = _build_draft_prompt({"title": "온보딩 개선 에픽"})
    assert "온보딩 개선 에픽" in prompt
    assert "설명:" not in prompt and "요약:" not in prompt


def test_build_draft_prompt_all_fields_included():
    prompt = _build_draft_prompt({"title": "T", "description": "D", "summary": "S"})
    assert "제목: T" in prompt and "설명: D" in prompt and "요약: S" in prompt


def test_build_draft_prompt_instructs_no_fabrication_and_single_sentence():
    prompt = _build_draft_prompt({"title": "T"})
    assert "추정하거나" in prompt and "만들어내지" in prompt
    assert "1문장" in prompt


# ── ⓐⓒ _draft_statement — LLM 시도/graceful fallback ───────────────────────────

def test_no_context_falls_back_to_template_without_calling_llm():
    with patch("app.services.llm_client.generate_text_claude") as mock_gen:
        statement, llm_generated = _draft_statement(None)
    mock_gen.assert_not_called()
    assert llm_generated is False
    assert statement == _template_statement(None)


def test_llm_success_returns_generated_statement():
    with patch("app.services.llm_client.generate_text_claude", return_value="실행하면 활성화율이 오를 것이다.") as mock_gen:
        statement, llm_generated = _draft_statement({"title": "온보딩 개선"})
    mock_gen.assert_called_once()
    assert statement == "실행하면 활성화율이 오를 것이다."
    assert llm_generated is True
    passed_prompt = mock_gen.call_args.args[0]
    assert "온보딩 개선" in passed_prompt


def test_llm_unavailable_falls_back_to_template():
    with patch("app.services.llm_client.generate_text_claude", return_value=None):
        statement, llm_generated = _draft_statement({"title": "온보딩 개선"})
    assert llm_generated is False
    assert statement == _template_statement({"title": "온보딩 개선"})


def test_llm_exception_falls_back_to_template_not_raised():
    with patch("app.services.llm_client.generate_text_claude", side_effect=RuntimeError("boom")):
        statement, llm_generated = _draft_statement({"title": "온보딩 개선"})
    assert llm_generated is False
    assert statement == _template_statement({"title": "온보딩 개선"})


def test_llm_blank_response_falls_back_to_template():
    """빈/공백 응답을 그대로 statement로 쓰지 않고 템플릿으로 대체(안전 필터 차단 등 대비)."""
    with patch("app.services.llm_client.generate_text_claude", return_value="   "):
        statement, llm_generated = _draft_statement({"title": "온보딩 개선"})
    assert llm_generated is False
    assert statement == _template_statement({"title": "온보딩 개선"})


# ── ⓓⓔ draft_hypothesis 전체 경로(mock 세션) — generation_method 기록 + proposed 고정 ──

def _hyp_stub(**overrides) -> SimpleNamespace:
    base = dict(
        id=HYP_ID, org_id=ORG_ID, project_id=PROJECT_ID, owner_member_id=CALLER_ID,
        created_by_member_id=CALLER_ID, confirmed_by_member_id=None,
        statement="s", metric_definition={"metric": "outcome", "source": "manual", "target": 1, "direction": "up"},
        measure_after=datetime(2026, 7, 1, tzinfo=timezone.utc), status="proposed",
        outcome_result=None, confidence=None, source_type=None, source_id=None,
        drafted_by_member_id=None, draft_metadata=None,
        human_accounting={}, gate_contract={},
        created_at=datetime(2026, 6, 1, tzinfo=timezone.utc),
        updated_at=datetime(2026, 6, 1, tzinfo=timezone.utc),
    )
    base.update(overrides)
    return SimpleNamespace(**base)


def _repo_mock(hyp: SimpleNamespace) -> AsyncMock:
    repo = AsyncMock()
    repo.create = AsyncMock(return_value=hyp)
    repo.get_epic_ids = AsyncMock(return_value=[])
    repo.get_story_ids = AsyncMock(return_value=[])
    repo.add_epic_links = AsyncMock()
    repo.add_story_links = AsyncMock()
    return repo


def _caller() -> ResolvedMember:
    return ResolvedMember(id=CALLER_ID, user_id=uuid.uuid4(), name="u", type="human", role="member", org_id=ORG_ID)


def _members_lookup() -> dict:
    """human caller가 owner 기본값(self)이 되므로 _verify_human_owner가 이 id를 human으로
    조회할 수 있어야 한다(HUMAN_OWNER_REQUIRED로 새지 않게)."""
    return {CALLER_ID: _caller()}


def _empty_session() -> MagicMock:
    session = MagicMock()
    res = MagicMock()
    res.all = MagicMock(return_value=[])
    session.execute = AsyncMock(return_value=res)
    return session


@pytest.mark.anyio
async def test_draft_persist_llm_success_records_llm_generation_method():
    repo = _repo_mock(_hyp_stub())
    payload = HypothesisDraftRequest(
        project_id=PROJECT_ID, source_type="conversation", source_id=uuid.uuid4(),
        persist=True, context={"title": "온보딩 개선"},
    )
    with patch.object(svc, "HypothesisRepository", return_value=repo), \
         patch.object(svc, "lookup_members_by_ids", AsyncMock(return_value=_members_lookup())), \
         patch("app.services.llm_client.generate_text_claude", return_value="실행하면 활성화율이 오를 것이다."):
        out = await svc.draft_hypothesis(_empty_session(), ORG_ID, _caller(), payload)

    assert out.statement == "실행하면 활성화율이 오를 것이다."
    create_kwargs = repo.create.call_args.kwargs
    assert create_kwargs["status"] == "proposed"  # ⭐돕되 대체 안 함 — 자동 active 절대 없음.
    assert create_kwargs["draft_metadata"]["generation_method"] == "llm"


@pytest.mark.anyio
async def test_draft_persist_llm_unavailable_records_template_generation_method():
    repo = _repo_mock(_hyp_stub())
    payload = HypothesisDraftRequest(
        project_id=PROJECT_ID, source_type="conversation", source_id=uuid.uuid4(),
        persist=True, context={"title": "온보딩 개선"},
    )
    with patch.object(svc, "HypothesisRepository", return_value=repo), \
         patch.object(svc, "lookup_members_by_ids", AsyncMock(return_value=_members_lookup())), \
         patch("app.services.llm_client.generate_text_claude", return_value=None):
        out = await svc.draft_hypothesis(_empty_session(), ORG_ID, _caller(), payload)

    assert out.statement == _template_statement({"title": "온보딩 개선"})
    create_kwargs = repo.create.call_args.kwargs
    assert create_kwargs["status"] == "proposed"
    assert create_kwargs["draft_metadata"]["generation_method"] == "template"


@pytest.mark.anyio
async def test_draft_no_persist_still_drafts_statement_without_creating_row():
    payload = HypothesisDraftRequest(
        project_id=PROJECT_ID, source_type="epic", source_id=uuid.uuid4(),
        persist=False, context={"title": "온보딩 개선"},
    )
    with patch("app.services.llm_client.generate_text_claude", return_value="실행하면 활성화율이 오를 것이다.") as mock_gen:
        out = await svc.draft_hypothesis(_empty_session(), ORG_ID, _caller(), payload)
    mock_gen.assert_called_once()
    assert out.statement == "실행하면 활성화율이 오를 것이다."
    assert out.hypothesis is None
    assert out.requires_confirmation is True
