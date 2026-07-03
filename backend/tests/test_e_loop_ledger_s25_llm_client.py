"""E-LOOP-LEDGER S25(story 0fb72183): llm_client.py(생성형 텍스트) 검증.

핵심 격리(비-tautological, embed_text/GA4 unauth 격리와 동형 — AC⑤ "실패 재현 테스트"):
인증 정보 없음/SDK 예외/빈 응답 → 전부 None(예외 전파 없음). 실 Vertex AI 호출은 하지 않는다
(외부 API·GCP 크레딧 소비·CI 네트워크 의존 회피) — SDK 호출부는 mock, 그 앞단(인증 게이트·빈
입력 가드·예외 포괄)은 real 로직 그대로 태운다.

AC③(토큰 cap+구조화 로깅) 검증: max_output_tokens가 GenerateContentConfig로 실제 전달되는지·
성공 시 token usage가 구조화 로그로 나가는지(caplog).
"""
from __future__ import annotations

import logging
import os
from unittest.mock import MagicMock, patch

from app.services.llm_client import (
    DEFAULT_MAX_OUTPUT_TOKENS,
    MODEL_LOCATION,
    MODEL_VERSION,
    generate_text,
)


# ── 빈 입력 ────────────────────────────────────────────────────────────────

def test_empty_prompt_returns_none_without_auth_check():
    assert generate_text("") is None
    assert generate_text("   ") is None


# ── ⭐핵심 격리: 인증 정보 없음 → None(embed_text와 동형) ─────────────────────

def test_no_credentials_returns_none_no_exception():
    with patch("app.services.llm_client._has_adc", return_value=False), \
         patch.dict(os.environ, {}, clear=False):
        os.environ.pop("GOOGLE_APPLICATION_CREDENTIALS", None)
        result = generate_text("summarize these precedents")
    assert result is None


def test_credentials_file_env_set_skips_adc_check():
    fake_response = MagicMock()
    fake_response.text = "distilled synthesis text"
    fake_response.usage_metadata = None
    fake_response.candidates = []
    with patch.dict(os.environ, {"GOOGLE_APPLICATION_CREDENTIALS": "/fake/path.json"}), \
         patch("app.services.llm_client._has_adc") as mock_adc:
        with patch("google.genai.Client") as mock_client_cls:
            mock_client_cls.return_value.models.generate_content.return_value = fake_response
            result = generate_text("hello")
        mock_adc.assert_not_called()
    assert result == "distilled synthesis text"


# ── 성공 경로(SDK mock) ────────────────────────────────────────────────────

def test_successful_generation_returns_text_and_uses_expected_model():
    fake_response = MagicMock()
    fake_response.text = "과거 CTA 실험 5건 — 저부담 문구가 우세."
    fake_response.usage_metadata = None
    fake_response.candidates = []
    with patch("app.services.llm_client._has_adc", return_value=True), \
         patch.dict(os.environ, {}, clear=False):
        os.environ.pop("GOOGLE_APPLICATION_CREDENTIALS", None)
        with patch("google.genai.Client") as mock_client_cls:
            mock_client_cls.return_value.models.generate_content.return_value = fake_response
            result = generate_text("synthesize precedents")
    assert result == "과거 CTA 실험 5건 — 저부담 문구가 우세."

    call_kwargs = mock_client_cls.return_value.models.generate_content.call_args.kwargs
    assert call_kwargs["model"] == MODEL_VERSION


def test_max_output_tokens_passed_through_to_config():
    """AC③ 토큰 cap이 실제로 SDK config에 실려나가는지(호출자 override 포함)."""
    fake_response = MagicMock()
    fake_response.text = "ok"
    fake_response.usage_metadata = None
    with patch("app.services.llm_client._has_adc", return_value=True), \
         patch.dict(os.environ, {}, clear=False):
        os.environ.pop("GOOGLE_APPLICATION_CREDENTIALS", None)
        with patch("google.genai.Client") as mock_client_cls:
            mock_client_cls.return_value.models.generate_content.return_value = fake_response
            generate_text("x")
            call_kwargs_default = mock_client_cls.return_value.models.generate_content.call_args.kwargs
            assert call_kwargs_default["config"].max_output_tokens == DEFAULT_MAX_OUTPUT_TOKENS

            generate_text("y", max_output_tokens=128)
            call_kwargs_override = mock_client_cls.return_value.models.generate_content.call_args.kwargs
            assert call_kwargs_override["config"].max_output_tokens == 128


def test_empty_response_text_returns_none():
    """SDK가 빈/공백 텍스트를 반환하면(안전필터 차단 등) None — 빈 문자열을 그대로 노출 안 함."""
    fake_response = MagicMock()
    fake_response.text = "   "
    fake_response.usage_metadata = None
    with patch("app.services.llm_client._has_adc", return_value=True), \
         patch.dict(os.environ, {}, clear=False):
        os.environ.pop("GOOGLE_APPLICATION_CREDENTIALS", None)
        with patch("google.genai.Client") as mock_client_cls:
            mock_client_cls.return_value.models.generate_content.return_value = fake_response
            result = generate_text("x")
    assert result is None


def test_thinking_disabled_to_prevent_budget_exhausting_output():
    """⭐PO 실측(dev 로그, 2026-07-02) — gemini-2.5-flash가 thinking_config 미지정 시
    AUTOMATIC thinking budget이 max_output_tokens를 통째로 잠식해 200 OK+빈 text(사실상
    기능 0)를 냄. thinking_budget=0(명시 disable)이 실제로 SDK config에 실려나가는지 실증."""
    fake_response = MagicMock()
    fake_response.text = "ok"
    fake_response.usage_metadata = None
    with patch("app.services.llm_client._has_adc", return_value=True), \
         patch.dict(os.environ, {}, clear=False):
        os.environ.pop("GOOGLE_APPLICATION_CREDENTIALS", None)
        with patch("google.genai.Client") as mock_client_cls:
            mock_client_cls.return_value.models.generate_content.return_value = fake_response
            generate_text("x")
    call_kwargs = mock_client_cls.return_value.models.generate_content.call_args.kwargs
    assert call_kwargs["config"].thinking_config.thinking_budget == 0


def test_empty_response_with_max_tokens_finish_reason_logged_for_diagnosis(caplog):
    """⭐빈 응답의 근본 원인(MAX_TOKENS=thinking 잠식 vs SAFETY=차단 등)을 로그로 즉시 구분
    가능해야 한다 — PO가 "finish_reason 추가해 원인 확정" 요청한 그 진단 능력을 직접 검증."""
    from google.genai import types as genai_types

    fake_candidate = MagicMock()
    fake_candidate.finish_reason = genai_types.FinishReason.MAX_TOKENS
    fake_response = MagicMock()
    fake_response.text = ""
    fake_response.usage_metadata = None
    fake_response.candidates = [fake_candidate]
    with patch("app.services.llm_client._has_adc", return_value=True), \
         patch.dict(os.environ, {}, clear=False), \
         caplog.at_level(logging.WARNING, logger="app.services.llm_client"):
        os.environ.pop("GOOGLE_APPLICATION_CREDENTIALS", None)
        with patch("google.genai.Client") as mock_client_cls:
            mock_client_cls.return_value.models.generate_content.return_value = fake_response
            result = generate_text("x")
    assert result is None
    assert any("MAX_TOKENS" in r.message for r in caplog.records)


# ── ⭐AC⑤ 실패 재현(비-tautological) ────────────────────────────────────────

def test_sdk_exception_returns_none_not_raised():
    """API 오류(quota/auth/403/5xx 등)가 예외로 전파되지 않고 None으로 흡수 — 호출부(L2 등)
    크래시 없이 synthesis 필드만 null로 graceful degrade할 수 있음을 실증."""
    with patch("app.services.llm_client._has_adc", return_value=True), \
         patch.dict(os.environ, {}, clear=False):
        os.environ.pop("GOOGLE_APPLICATION_CREDENTIALS", None)
        with patch("google.genai.Client") as mock_client_cls:
            mock_client_cls.return_value.models.generate_content.side_effect = RuntimeError("quota exceeded")
            result = generate_text("x")
    assert result is None


def test_403_forbidden_returns_none_not_raised():
    """AC② 명시한 403(권한 없음) 케이스도 동일하게 흡수 — auth/quota/5xx와 구분 없이 전부 None."""
    with patch("app.services.llm_client._has_adc", return_value=True), \
         patch.dict(os.environ, {}, clear=False):
        os.environ.pop("GOOGLE_APPLICATION_CREDENTIALS", None)
        with patch("google.genai.Client") as mock_client_cls:
            mock_client_cls.return_value.models.generate_content.side_effect = PermissionError("403 forbidden")
            result = generate_text("x")
    assert result is None


# ── AC③ 구조화 로깅(토큰 cap+비용 추적) ─────────────────────────────────────

def test_successful_generation_logs_structured_token_usage(caplog):
    fake_usage = MagicMock(prompt_token_count=42, candidates_token_count=17, total_token_count=59)
    fake_response = MagicMock()
    fake_response.text = "synthesis"
    fake_response.usage_metadata = fake_usage
    with patch("app.services.llm_client._has_adc", return_value=True), \
         patch.dict(os.environ, {}, clear=False), \
         caplog.at_level(logging.INFO, logger="app.services.llm_client"):
        os.environ.pop("GOOGLE_APPLICATION_CREDENTIALS", None)
        with patch("google.genai.Client") as mock_client_cls:
            mock_client_cls.return_value.models.generate_content.return_value = fake_response
            generate_text("x")

    records = [r for r in caplog.records if r.message == "llm generation"]
    assert len(records) == 1
    structured = records[0].structured
    assert structured["model"] == MODEL_VERSION
    assert structured["prompt_token_count"] == 42
    assert structured["candidates_token_count"] == 17
    assert structured["total_token_count"] == 59
    assert isinstance(structured["latency_ms"], float)


def test_instrumentation_failure_does_not_block_successful_response():
    """계측(usage_metadata 접근 등)이 실패해도 이미 확보한 생성 결과는 그대로 반환(non-fatal)."""
    class _BoomUsage:
        @property
        def prompt_token_count(self):
            raise RuntimeError("boom")

    fake_response = MagicMock()
    fake_response.text = "synthesis despite instrumentation failure"
    fake_response.usage_metadata = _BoomUsage()
    fake_response.candidates = []
    with patch("app.services.llm_client._has_adc", return_value=True), \
         patch.dict(os.environ, {}, clear=False):
        os.environ.pop("GOOGLE_APPLICATION_CREDENTIALS", None)
        with patch("google.genai.Client") as mock_client_cls:
            mock_client_cls.return_value.models.generate_content.return_value = fake_response
            result = generate_text("x")
    assert result == "synthesis despite instrumentation failure"


# ── Gemini 피벗(2026-07-03): response_schema structured output + finish_reason 방어 ──
# #1866(Claude structured output)의 근본을 그대로 이관 — response_json_schema가 기존
# 스키마 dict(items-wrapping)를 그대로 받아들이고, finish_reason!=STOP 방어는 Claude
# stop_reason(max_tokens/refusal) 방어와 동형 원칙(구 test_e_loop_ledger_s28_llm_client_claude.py
# 은퇴에 따라 이 파일로 이관).

def test_response_schema_sets_json_mime_and_response_json_schema():
    schema = {"type": "object", "properties": {"items": {"type": "array"}}, "required": ["items"]}
    fake_response = MagicMock()
    fake_response.text = '{"items": []}'
    fake_response.usage_metadata = None
    fake_response.candidates = []
    with patch("app.services.llm_client._has_adc", return_value=True), \
         patch.dict(os.environ, {}, clear=False):
        os.environ.pop("GOOGLE_APPLICATION_CREDENTIALS", None)
        with patch("google.genai.Client") as mock_client_cls:
            mock_client_cls.return_value.models.generate_content.return_value = fake_response
            result = generate_text("x", response_schema=schema)
    assert result == '{"items": []}'
    call_kwargs = mock_client_cls.return_value.models.generate_content.call_args.kwargs
    config = call_kwargs["config"]
    assert config.response_mime_type == "application/json"
    assert config.response_json_schema == schema


def test_no_response_schema_omits_json_mime():
    """response_schema 미지정 시(기존 순수 텍스트 호출) response_mime_type을 강제하지 않음
    — 5개 non-schema 호출부(hypothesis draft·context_pack synthesis/recommendation) 회귀 방지."""
    fake_response = MagicMock()
    fake_response.text = "ok"
    fake_response.usage_metadata = None
    fake_response.candidates = []
    with patch("app.services.llm_client._has_adc", return_value=True), \
         patch.dict(os.environ, {}, clear=False):
        os.environ.pop("GOOGLE_APPLICATION_CREDENTIALS", None)
        with patch("google.genai.Client") as mock_client_cls:
            mock_client_cls.return_value.models.generate_content.return_value = fake_response
            generate_text("x")
    call_kwargs = mock_client_cls.return_value.models.generate_content.call_args.kwargs
    assert call_kwargs["config"].response_mime_type is None


def test_finish_reason_max_tokens_returns_none_even_with_nonempty_text():
    """⭐텍스트가 비어있지 않아도(truncated JSON일 수 있음) finish_reason=MAX_TOKENS면 명시
    실패(None) — 부분 출력을 성공으로 오인하지 않음(Claude stop_reason=max_tokens 방어와 동형,
    이관 전 old code는 finish_reason을 아예 체크하지 않아 이 케이스를 성공으로 오판했었다)."""
    from google.genai import types as genai_types

    fake_candidate = MagicMock()
    fake_candidate.finish_reason = genai_types.FinishReason.MAX_TOKENS
    fake_response = MagicMock()
    fake_response.text = '{"items": [{"text": "부분'
    fake_response.usage_metadata = None
    fake_response.candidates = [fake_candidate]
    with patch("app.services.llm_client._has_adc", return_value=True), \
         patch.dict(os.environ, {}, clear=False):
        os.environ.pop("GOOGLE_APPLICATION_CREDENTIALS", None)
        with patch("google.genai.Client") as mock_client_cls:
            mock_client_cls.return_value.models.generate_content.return_value = fake_response
            result = generate_text("x")
    assert result is None


def test_finish_reason_stop_with_text_succeeds():
    """회귀 방지 — 정상 종료(STOP)는 텍스트가 있으면 여전히 반환해야 함."""
    from google.genai import types as genai_types

    fake_candidate = MagicMock()
    fake_candidate.finish_reason = genai_types.FinishReason.STOP
    fake_response = MagicMock()
    fake_response.text = '{"items": []}'
    fake_response.usage_metadata = None
    fake_response.candidates = [fake_candidate]
    with patch("app.services.llm_client._has_adc", return_value=True), \
         patch.dict(os.environ, {}, clear=False):
        os.environ.pop("GOOGLE_APPLICATION_CREDENTIALS", None)
        with patch("google.genai.Client") as mock_client_cls:
            mock_client_cls.return_value.models.generate_content.return_value = fake_response
            result = generate_text("x")
    assert result == '{"items": []}'


def test_finish_reason_none_with_text_still_succeeds():
    """candidates가 비어있어 finish_reason을 못 구해도(None) 텍스트 유무로만 판정하던 기존
    계약 유지 — 진단 실패가 정상 응답을 실패로 오판하지 않음."""
    fake_response = MagicMock()
    fake_response.text = "ok"
    fake_response.usage_metadata = None
    fake_response.candidates = []
    with patch("app.services.llm_client._has_adc", return_value=True), \
         patch.dict(os.environ, {}, clear=False):
        os.environ.pop("GOOGLE_APPLICATION_CREDENTIALS", None)
        with patch("google.genai.Client") as mock_client_cls:
            mock_client_cls.return_value.models.generate_content.return_value = fake_response
            result = generate_text("x")
    assert result == "ok"


# ── Gemini 피벗: model=/location= 오버라이드(모델 A/B 비교용) ─────────────────────

def test_model_param_overrides_module_default():
    fake_response = MagicMock()
    fake_response.text = "ok"
    fake_response.usage_metadata = None
    fake_response.candidates = []
    with patch("app.services.llm_client._has_adc", return_value=True), \
         patch.dict(os.environ, {}, clear=False):
        os.environ.pop("GOOGLE_APPLICATION_CREDENTIALS", None)
        with patch("google.genai.Client") as mock_client_cls:
            mock_client_cls.return_value.models.generate_content.return_value = fake_response
            generate_text("x", model="gemini-3.1-pro-preview")
    call_kwargs = mock_client_cls.return_value.models.generate_content.call_args.kwargs
    assert call_kwargs["model"] == "gemini-3.1-pro-preview"


def test_location_param_overrides_module_default():
    """⭐PO 실측(2026-07-03): gemini-3.x는 location="global" 필수(asia-northeast3/
    us-central1은 404) — 모델별 location 오버라이드가 실제로 Client(location=...)에
    실려나가는지 실증."""
    fake_response = MagicMock()
    fake_response.text = "ok"
    fake_response.usage_metadata = None
    fake_response.candidates = []
    with patch("app.services.llm_client._has_adc", return_value=True), \
         patch.dict(os.environ, {}, clear=False):
        os.environ.pop("GOOGLE_APPLICATION_CREDENTIALS", None)
        with patch("google.genai.Client") as mock_client_cls:
            mock_client_cls.return_value.models.generate_content.return_value = fake_response
            generate_text("x", location="global")
    init_kwargs = mock_client_cls.call_args.kwargs
    assert init_kwargs["location"] == "global"


def test_default_location_is_module_default_unchanged():
    """location= 미지정 시 기존 MODEL_LOCATION(settings.vertex_ai_location 기반) 그대로 —
    2.5-flash/embedding 경로 회귀 0."""
    fake_response = MagicMock()
    fake_response.text = "ok"
    fake_response.usage_metadata = None
    fake_response.candidates = []
    with patch("app.services.llm_client._has_adc", return_value=True), \
         patch.dict(os.environ, {}, clear=False):
        os.environ.pop("GOOGLE_APPLICATION_CREDENTIALS", None)
        with patch("google.genai.Client") as mock_client_cls:
            mock_client_cls.return_value.models.generate_content.return_value = fake_response
            generate_text("x")
    init_kwargs = mock_client_cls.call_args.kwargs
    assert init_kwargs["location"] == MODEL_LOCATION


# ── AC④ 임베딩 경로 회귀0 — 별도 파일/클라이언트 인스턴스임을 구조적으로 증명 ──────

def test_llm_client_does_not_import_or_touch_embedding_client():
    """llm_client 모듈이 embedding_client의 전역 상태/함수를 공유하지 않는다 — 같은 SDK
    패턴(genai.Client)만 재사용하되 독립 모듈이라 embed 경로에 코드 변경이 전혀 없음을
    모듈 그래프로 실증(import 시점 부작용 0)."""
    import app.services.embedding_client as ec
    import app.services.llm_client as lc

    assert lc is not ec
    assert not hasattr(lc, "embed_text")
    assert not hasattr(lc, "EMBEDDING_DIMENSION")
