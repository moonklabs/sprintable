"""E-LOOP-LEDGER S28(story 116e6fe8): llm_client.py::generate_text_claude(Claude 실험 경로) 검증.

핵심 격리(비-tautological, generate_text/embed_text와 동형): 인증 정보 없음/SDK 예외/빈 응답
→ 전부 None(예외 전파 없음). 실 Vertex 호출은 하지 않는다(SDK 호출부 mock).

⭐reasoning 파라미터 계약(2026-07-02 실측 반영): "disabled"→thinking.type=disabled만·
"low"~"max"→thinking.type=adaptive+output_config.effort(구형 enabled/budget_tokens 아님 —
claude-sonnet-5가 그 구형 스킴을 invalid_request_error로 거부함을 실측 확인했고, 이 계약이
그 실측을 그대로 코드화한 것임을 테스트로 고정).
"""
from __future__ import annotations

import logging
import os
from unittest.mock import MagicMock, patch

from app.services.llm_client import CLAUDE_MODEL_VERSION, generate_text_claude


def _fake_response(text="synthesis", stop_reason="end_turn", input_tokens=100, output_tokens=50, thinking_tokens=0):
    block = MagicMock()
    block.type = "text"
    block.text = text
    response = MagicMock()
    response.content = [block]
    response.stop_reason = stop_reason
    response.usage = MagicMock(
        input_tokens=input_tokens, output_tokens=output_tokens,
        output_tokens_details=MagicMock(thinking_tokens=thinking_tokens),
    )
    return response


# ── 빈 입력/무인증 ────────────────────────────────────────────────────────────

def test_empty_prompt_returns_none_without_auth_check():
    assert generate_text_claude("") is None
    assert generate_text_claude("   ") is None


def test_no_credentials_returns_none_no_exception():
    with patch("app.services.llm_client._has_adc", return_value=False), \
         patch.dict(os.environ, {}, clear=False):
        os.environ.pop("GOOGLE_APPLICATION_CREDENTIALS", None)
        result = generate_text_claude("summarize these precedents")
    assert result is None


# ── ⭐reasoning 파라미터 계약(2026-07-02 실측 고정) ────────────────────────────

def test_disabled_reasoning_sends_thinking_disabled_only():
    fake = _fake_response()
    with patch("app.services.llm_client._has_adc", return_value=True), \
         patch.dict(os.environ, {}, clear=False):
        os.environ.pop("GOOGLE_APPLICATION_CREDENTIALS", None)
        with patch("anthropic.AnthropicVertex") as mock_client_cls:
            mock_client_cls.return_value.messages.create.return_value = fake
            generate_text_claude("x", reasoning="disabled")
    call_kwargs = mock_client_cls.return_value.messages.create.call_args.kwargs
    assert call_kwargs["thinking"] == {"type": "disabled"}
    assert "output_config" not in call_kwargs
    assert call_kwargs["model"] == CLAUDE_MODEL_VERSION


def test_low_reasoning_sends_adaptive_thinking_with_effort_not_legacy_budget():
    """⭐claude-sonnet-5는 thinking.type=enabled+budget_tokens(구형)를 거부한다고 실측
    확인됐음 — adaptive+output_config.effort만 실려나가야 한다(구형 스킴 회귀 방지)."""
    fake = _fake_response()
    with patch("app.services.llm_client._has_adc", return_value=True), \
         patch.dict(os.environ, {}, clear=False):
        os.environ.pop("GOOGLE_APPLICATION_CREDENTIALS", None)
        with patch("anthropic.AnthropicVertex") as mock_client_cls:
            mock_client_cls.return_value.messages.create.return_value = fake
            generate_text_claude("x", reasoning="low")
    call_kwargs = mock_client_cls.return_value.messages.create.call_args.kwargs
    assert call_kwargs["thinking"] == {"type": "adaptive"}
    assert call_kwargs["output_config"] == {"effort": "low"}
    assert "budget_tokens" not in str(call_kwargs["thinking"])


def test_invalid_reasoning_value_falls_back_to_disabled():
    fake = _fake_response()
    with patch("app.services.llm_client._has_adc", return_value=True), \
         patch.dict(os.environ, {}, clear=False):
        os.environ.pop("GOOGLE_APPLICATION_CREDENTIALS", None)
        with patch("anthropic.AnthropicVertex") as mock_client_cls:
            mock_client_cls.return_value.messages.create.return_value = fake
            generate_text_claude("x", reasoning="nonsense")
    call_kwargs = mock_client_cls.return_value.messages.create.call_args.kwargs
    assert call_kwargs["thinking"] == {"type": "disabled"}


# ── 성공 경로 ────────────────────────────────────────────────────────────────

def test_successful_generation_returns_text_and_uses_global_region():
    fake = _fake_response(text="과거 2건 기준 저부담 문구 권장.")
    with patch("app.services.llm_client._has_adc", return_value=True), \
         patch.dict(os.environ, {}, clear=False):
        os.environ.pop("GOOGLE_APPLICATION_CREDENTIALS", None)
        with patch("anthropic.AnthropicVertex") as mock_client_cls:
            mock_client_cls.return_value.messages.create.return_value = fake
            result = generate_text_claude("x")
    assert result == "과거 2건 기준 저부담 문구 권장."
    init_kwargs = mock_client_cls.call_args.kwargs
    assert init_kwargs["region"] == "global"


def test_multiple_text_blocks_concatenated():
    b1, b2 = MagicMock(type="text", text="첫 문장. "), MagicMock(type="text", text="둘째 문장.")
    fake = _fake_response()
    fake.content = [b1, b2]
    with patch("app.services.llm_client._has_adc", return_value=True), \
         patch.dict(os.environ, {}, clear=False):
        os.environ.pop("GOOGLE_APPLICATION_CREDENTIALS", None)
        with patch("anthropic.AnthropicVertex") as mock_client_cls:
            mock_client_cls.return_value.messages.create.return_value = fake
            result = generate_text_claude("x")
    assert result == "첫 문장. 둘째 문장."


# ── ⭐실패 재현(비-tautological) ───────────────────────────────────────────────

def test_empty_response_text_returns_none():
    fake = _fake_response(text="   ")
    with patch("app.services.llm_client._has_adc", return_value=True), \
         patch.dict(os.environ, {}, clear=False):
        os.environ.pop("GOOGLE_APPLICATION_CREDENTIALS", None)
        with patch("anthropic.AnthropicVertex") as mock_client_cls:
            mock_client_cls.return_value.messages.create.return_value = fake
            result = generate_text_claude("x")
    assert result is None


def test_sdk_exception_returns_none_not_raised():
    """실측한 invalid_request_error 포함 — SDK가 예외를 던져도 예외 전파 없이 None."""
    with patch("app.services.llm_client._has_adc", return_value=True), \
         patch.dict(os.environ, {}, clear=False):
        os.environ.pop("GOOGLE_APPLICATION_CREDENTIALS", None)
        with patch("anthropic.AnthropicVertex") as mock_client_cls:
            mock_client_cls.return_value.messages.create.side_effect = RuntimeError(
                '"thinking.type.enabled" is not supported for this model'
            )
            result = generate_text_claude("x", reasoning="low")
    assert result is None


# ── 구조화 로깅(latency+token 실험 데이터) ───────────────────────────────────────

def test_generation_logs_structured_latency_and_thinking_tokens(caplog):
    fake = _fake_response(input_tokens=332, output_tokens=180, thinking_tokens=42)
    with patch("app.services.llm_client._has_adc", return_value=True), \
         patch.dict(os.environ, {}, clear=False), \
         caplog.at_level(logging.INFO, logger="app.services.llm_client"):
        os.environ.pop("GOOGLE_APPLICATION_CREDENTIALS", None)
        with patch("anthropic.AnthropicVertex") as mock_client_cls:
            mock_client_cls.return_value.messages.create.return_value = fake
            generate_text_claude("x", reasoning="low")

    records = [r for r in caplog.records if r.message == "llm generation (claude)"]
    assert len(records) == 1
    structured = records[0].structured
    assert structured["model"] == CLAUDE_MODEL_VERSION
    assert structured["reasoning"] == "low"
    assert structured["input_tokens"] == 332
    assert structured["output_tokens"] == 180
    assert structured["thinking_tokens"] == 42
    assert isinstance(structured["latency_ms"], float)


# ── AC④ 임베딩/Gemini 경로 회귀0 — 독립 함수임을 구조적으로 증명 ───────────────────

def test_claude_path_does_not_touch_gemini_generate_text():
    """generate_text(Gemini)는 무변경 — Claude 함수 추가가 별도 함수/코드경로임을 증명."""
    import app.services.llm_client as lc

    assert lc.generate_text is not lc.generate_text_claude
    assert lc.MODEL_VERSION == "gemini-2.5-flash"
    assert lc.CLAUDE_MODEL_VERSION == "claude-sonnet-5"
