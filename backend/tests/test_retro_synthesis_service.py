"""E-SPRINT-LOOP dc861e44: retro_synthesis 서비스 단위 테스트.

핵심 불변식: 근거 전무(가설·투표 아이템 0건)면 LLM 호출 자체를 안 함(S15 동형·지어내기
금지)·LLM 실패/파싱 실패는 항상 명시 실패(None, data-loss 방지·#1863 원칙)·synthesis
없으면 recommend_next이 빈 배열(라우터의 409 게이팅과 별개로 서비스 레벨도 안전).

structured output(2026-07-03, 선생님/PO 지적) 전환 후: LLM 응답은 response_schema가
강제하는 object-wrapped 형(`{"items": [...]}`) — 프리앰블/트레일링 프로즈·코드펜스 문제
자체가 스키마 레벨에서 소멸했으므로 그 방어 테스트(구 bracket-matching 파서용)는 제거,
대신 "items가 방어적으로 malformed일 때도 여전히 명시 실패"만 남긴다."""
import uuid
from datetime import datetime, timezone
from types import SimpleNamespace
from unittest.mock import AsyncMock, MagicMock, patch

import pytest

from app.services import retro_synthesis as svc

ORG_ID = uuid.uuid4()
PROJECT_ID = uuid.uuid4()
SPRINT_ID = uuid.uuid4()
SESSION_ID = uuid.uuid4()


@pytest.fixture
def anyio_backend():
    return "asyncio"


def _retro(sprint_id=None):
    return SimpleNamespace(
        id=SESSION_ID, org_id=ORG_ID, project_id=PROJECT_ID, sprint_id=sprint_id,
    )


def _empty_execute_session():
    """RetroItem 상위 투표 쿼리가 빈 리스트를 반환하는 mock 세션."""
    session = MagicMock()
    result = MagicMock()
    result.scalars.return_value.all.return_value = []
    session.execute = AsyncMock(return_value=result)
    return session


# ── build_hypotheses_items ───────────────────────────────────────────────────

async def test_build_hypotheses_items_no_sprint_returns_empty():
    result = await svc.build_hypotheses_items(MagicMock(), ORG_ID, PROJECT_ID, None)
    assert result == []


async def test_build_hypotheses_items_flattens_metric_and_actual():
    hyp = SimpleNamespace(
        id=uuid.uuid4(), statement="stmt", status="falsified",
        metric_definition={"metric": "signup_rate", "target": 10, "direction": "up"},
        outcome_result={"actual": 7.5},
    )
    with patch("app.services.hypothesis.list_hypotheses", new=AsyncMock(return_value=[hyp])):
        result = await svc.build_hypotheses_items(MagicMock(), ORG_ID, PROJECT_ID, SPRINT_ID)
    assert result == [{
        "id": hyp.id, "statement": "stmt", "status": "falsified",
        "metric": "signup_rate", "target": 10, "direction": "up", "actual": 7.5,
        "href": f"/hypotheses/{hyp.id}",
    }]


async def test_build_hypotheses_items_measuring_actual_none():
    hyp = SimpleNamespace(
        id=uuid.uuid4(), statement="stmt", status="measuring",
        metric_definition={"metric": "x", "target": 1, "direction": "up"},
        outcome_result=None,
    )
    with patch("app.services.hypothesis.list_hypotheses", new=AsyncMock(return_value=[hyp])):
        result = await svc.build_hypotheses_items(MagicMock(), ORG_ID, PROJECT_ID, SPRINT_ID)
    assert result[0]["actual"] is None


# ── synthesize ────────────────────────────────────────────────────────────────

async def test_synthesize_no_context_skips_llm_call():
    """가설도 투표 아이템도 0건 — LLM 호출 자체를 안 함(S15 동형: 지어낼 근거가 없으면 안 시킴)."""
    session = _empty_execute_session()
    retro = _retro(sprint_id=None)
    with patch("app.services.llm_client.generate_text_claude") as mock_gen:
        result = await svc.synthesize(session, retro)
    mock_gen.assert_not_called()
    assert result["learned"] == []
    assert result["source"] == "ai_draft"


async def test_synthesize_parses_valid_json():
    session = _empty_execute_session()
    retro = _retro(sprint_id=SPRINT_ID)
    hyp = SimpleNamespace(
        id=uuid.uuid4(), statement="stmt", status="verified",
        metric_definition={"metric": "x", "target": 1, "direction": "up"},
        outcome_result={"actual": 2},
    )
    raw = '{"items": [{"text": "가설이 검증됐다", "source": "가설 1"}]}'
    with patch("app.services.hypothesis.list_hypotheses", new=AsyncMock(return_value=[hyp])), \
         patch("app.services.llm_client.generate_text_claude", return_value=raw):
        result = await svc.synthesize(session, retro)
    assert result["learned"] == [{"text": "가설이 검증됐다", "source": "가설 1"}]
    # response_schema가 실려 나갔는지도 확인 — 구조화 강제가 실제로 걸리는지.
    call_kwargs = None
    with patch("app.services.hypothesis.list_hypotheses", new=AsyncMock(return_value=[hyp])), \
         patch("app.services.llm_client.generate_text_claude", return_value=raw) as mock_gen:
        await svc.synthesize(session, retro)
        call_kwargs = mock_gen.call_args.kwargs
    assert call_kwargs["response_schema"] == svc._SYNTHESIS_SCHEMA


async def test_synthesize_prose_only_response_returns_none():
    """response_schema가 유효 JSON을 구조적으로 보장하지만(2026-07-03 전환), SDK/스키마
    엣지케이스에 대비한 방어 파싱은 유지 — object가 아니면 여전히 명시 실패(None)."""
    session = _empty_execute_session()
    retro = _retro(sprint_id=SPRINT_ID)
    hyp = SimpleNamespace(
        id=uuid.uuid4(), statement="stmt", status="verified",
        metric_definition={}, outcome_result=None,
    )
    raw = "죄송하지만 데이터가 부족해 종합을 생성할 수 없습니다."
    with patch("app.services.hypothesis.list_hypotheses", new=AsyncMock(return_value=[hyp])), \
         patch("app.services.llm_client.generate_text_claude", return_value=raw):
        result = await svc.synthesize(session, retro)
    assert result is None


async def test_synthesize_valid_object_wrong_item_shape_returns_none():
    """까심 codex RC①(2026-07-03) — 파싱 실패한 raw를 단일 bullet로 "구제"하던 이전 fallback은
    캐시-overwrite 맥락에서 garbage-persist였다(S15 템플릿-fallback 철학이 여기선 오적용).
    구조화 전환 후에도 이 원칙은 불변 — items object는 유효해도 아이템이 스키마 불일치
    (text 부재/blank)면 전부 None(실패), 호출부가 기존 캐시를 지키게 한다."""
    session = _empty_execute_session()
    retro = _retro(sprint_id=SPRINT_ID)
    hyp = SimpleNamespace(
        id=uuid.uuid4(), statement="stmt", status="verified",
        metric_definition={}, outcome_result=None,
    )
    raw = '{"items": [{"no_text": 1}, {"text": "   "}]}'
    with patch("app.services.hypothesis.list_hypotheses", new=AsyncMock(return_value=[hyp])), \
         patch("app.services.llm_client.generate_text_claude", return_value=raw):
        result = await svc.synthesize(session, retro)
    assert result is None


async def test_synthesize_llm_none_returns_none_not_empty_success():
    """data-loss 방지(오르테가 지적 2026-07-03) — LLM이 근거는 받고도 실패하면 '정당한 빈
    결과'가 아니라 명시 실패(None)여야 한다. 호출부가 이 None을 기존 캐시 덮어쓰기 신호로
    오인하면 안 되므로 dict가 아니라 None을 반환한다."""
    session = _empty_execute_session()
    retro = _retro(sprint_id=SPRINT_ID)
    hyp = SimpleNamespace(
        id=uuid.uuid4(), statement="stmt", status="verified",
        metric_definition={}, outcome_result=None,
    )
    with patch("app.services.hypothesis.list_hypotheses", new=AsyncMock(return_value=[hyp])), \
         patch("app.services.llm_client.generate_text_claude", return_value=None):
        result = await svc.synthesize(session, retro)
    assert result is None


async def test_synthesize_llm_exception_returns_none():
    session = _empty_execute_session()
    retro = _retro(sprint_id=SPRINT_ID)
    hyp = SimpleNamespace(
        id=uuid.uuid4(), statement="stmt", status="verified",
        metric_definition={}, outcome_result=None,
    )
    with patch("app.services.hypothesis.list_hypotheses", new=AsyncMock(return_value=[hyp])), \
         patch("app.services.llm_client.generate_text_claude", side_effect=RuntimeError("boom")):
        result = await svc.synthesize(session, retro)  # 예외 전파는 없음(None으로 수렴)
    assert result is None


# ── recommend_next ────────────────────────────────────────────────────────────

async def test_recommend_next_empty_synthesis_skips_llm():
    with patch("app.services.llm_client.generate_text_claude") as mock_gen:
        result = await svc.recommend_next({"learned": [], "generated_at": "x", "source": "ai_draft"})
    mock_gen.assert_not_called()
    assert result == []


async def test_recommend_next_parses_candidates():
    synthesis = {"learned": [{"text": "배운 것", "source": "s"}], "generated_at": "x", "source": "ai_draft"}
    raw = '{"items": [{"statement": "다음엔 온보딩을 개선하면 이탈이 줄 것이다.", "rationale": "가설 2 반증에서", "confidence": 0.6}]}'
    with patch("app.services.llm_client.generate_text_claude", return_value=raw) as mock_gen:
        result = await svc.recommend_next(synthesis)
    assert len(result) == 1
    c = result[0]
    assert c["statement"] == "다음엔 온보딩을 개선하면 이탈이 줄 것이다."
    assert c["rationale"] == "가설 2 반증에서"
    assert c["confidence"] == 0.6
    assert c["requires_confirmation"] is True
    assert c["metric_definition"] == {"metric": "outcome", "source": "manual", "target": 1, "direction": "up"}
    uuid.UUID(c["id"])  # 안정 참조 키 — 파싱 가능한 uuid여야 함
    datetime.fromisoformat(c["measure_after"])  # ISO datetime
    assert mock_gen.call_args.kwargs["response_schema"] == svc._NEXT_HYPOTHESES_SCHEMA


async def test_recommend_next_mixed_learned_drops_garbage_items_from_prompt():
    """까심 QA MINOR(2026-07-03) — `_has_valid_synthesis`는 "≥1개 유효 아이템"만 요구해
    혼합 learned가 게이트를 통과할 수 있다. garbage 아이템(text 없음)이 프롬프트에 빈
    bullet("- ")로 새면 안 됨 — LLM 호출 프롬프트에 실제로 뭐가 전달됐는지 직접 검증."""
    synthesis = {
        "learned": [
            {"text": "진짜 배운 것", "source": "s"},
            {"foo": "bar"},  # text 키 자체가 없음
            {"text": "   "},  # text가 공백뿐
        ],
        "generated_at": "x", "source": "ai_draft",
    }
    raw = '{"items": [{"statement": "다음 검증", "rationale": "r", "confidence": 0.5}]}'
    with patch("app.services.llm_client.generate_text_claude", return_value=raw) as mock_gen:
        await svc.recommend_next(synthesis)
    prompt_sent = mock_gen.call_args.args[0]
    assert "진짜 배운 것" in prompt_sent
    assert "- \n" not in prompt_sent and not prompt_sent.rstrip().endswith("- ")


async def test_recommend_next_caps_at_max_and_drops_malformed():
    synthesis = {"learned": [{"text": "x", "source": "s"}], "generated_at": "x", "source": "ai_draft"}
    raw = (
        '{"items": [{"statement": "a"}, {"statement": "b"}, {"statement": "c"}, '
        '{"statement": "d"}, {"no_statement": true}]}'
    )
    with patch("app.services.llm_client.generate_text_claude", return_value=raw):
        result = await svc.recommend_next(synthesis)
    assert len(result) == 3  # _MAX_NEXT_HYPOTHESES=3 캡


async def test_recommend_next_invalid_json_returns_none():
    """data-loss 방지 — 파싱 완전 실패는 빈 배열(성공으로 오인 가능)이 아니라 None(실패)."""
    synthesis = {"learned": [{"text": "x", "source": "s"}], "generated_at": "x", "source": "ai_draft"}
    with patch("app.services.llm_client.generate_text_claude", return_value="not json"):
        result = await svc.recommend_next(synthesis)
    assert result is None


async def test_recommend_next_llm_none_returns_none():
    synthesis = {"learned": [{"text": "x", "source": "s"}], "generated_at": "x", "source": "ai_draft"}
    with patch("app.services.llm_client.generate_text_claude", return_value=None):
        result = await svc.recommend_next(synthesis)
    assert result is None


async def test_recommend_next_all_items_malformed_returns_none():
    """items object는 유효해도 항목 전부 스키마 불일치(statement 부재) — 빈 배열을 '정답'으로
    저장하면 안 되므로 None(실패)."""
    synthesis = {"learned": [{"text": "x", "source": "s"}], "generated_at": "x", "source": "ai_draft"}
    raw = '{"items": [{"no_statement": true}, {"also_wrong": 1}]}'
    with patch("app.services.llm_client.generate_text_claude", return_value=raw):
        result = await svc.recommend_next(synthesis)
    assert result is None
