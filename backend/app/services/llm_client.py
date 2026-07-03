"""E-LOOP-LEDGER S25/S28: Vertex AI 생성형 텍스트 클라이언트 — Gemini(기본)+Claude(실험) 경로.

embedding_client.py와 동일한 genai.Client(vertexai=True) 재사용 — 신규 크리덴셜/배선 0(같은
ADC/aiplatform SA, embed와 동일 project/location). L2 종합(S26)·S15 자동초안·미팅 AI요약(현재
501 stub) 전부 이 위에서 unlock되는 복리 지능 파운데이션(선생님 GO 2026-07-02).

인증 불가/빈 입력/API 오류는 예외 전파 없이 None 반환(embed_text와 동일 격리 철학 — 생성 실패가
호출부를 크래시시키거나 잘못된 결과로 오인되게 하지 않는다. 절대 실패를 성공으로 위장하지 않음).

S28(story 116e6fe8, 선생님 dogfood 지적): L2/L3 출력 품질이 순환적·비-actionable — 모델
업그레이드 실험의 첫 축으로 Claude(claude-sonnet-5, Vertex Model Garden)를 별도 경로로
추가(`generate_text_claude`). google-genai(Gemini)와 완전 독립 — `generate_text()`는 무변경.
"""
from __future__ import annotations

import logging
import os
import time

from app.core.config import settings

logger = logging.getLogger(__name__)

MODEL_VERSION = "gemini-2.5-flash"
# S25 AC③ — 토큰 cap(과금 안전핀). L2 종합류 짧은 산출물 용도로 512면 충분(호출부가 필요시 override).
DEFAULT_MAX_OUTPUT_TOKENS = 512


def _has_adc() -> bool:
    """Application Default Credentials 사용 가능 여부 간단 체크(embedding_client.py와 동형)."""
    try:
        import google.auth
        google.auth.default()
        return True
    except Exception:
        return False


def generate_text(prompt: str, *, max_output_tokens: int = DEFAULT_MAX_OUTPUT_TOKENS) -> str | None:
    """프롬프트로 텍스트 생성. 인증 불가/빈 입력/API 오류/빈 응답 시 None(예외 전파 없음).

    Returns:
        생성된 텍스트 또는 None(생성 실패 — 호출자는 이를 "아직 못 만듦"으로 처리하고 graceful
        degrade해야 한다 — embed_text와 동일 계약. 절대 실패를 임의 텍스트로 위장하지 않는다).
    """
    if not prompt or not prompt.strip():
        return None

    creds_file = os.environ.get("GOOGLE_APPLICATION_CREDENTIALS")
    if not creds_file and not _has_adc():
        logger.warning("llm_client: 인증 정보 없음 → None 처리")
        return None

    start = time.monotonic()
    try:
        from google import genai
        from google.genai import types

        client = genai.Client(
            vertexai=True,
            project=settings.gcp_project_id,
            location=settings.vertex_ai_location,
            http_options=types.HttpOptions(api_version="v1"),
        )
        response = client.models.generate_content(
            model=MODEL_VERSION,
            contents=prompt,
            config=types.GenerateContentConfig(
                max_output_tokens=max_output_tokens,
                # PO 실측(dev 로그, 2026-07-02): gemini-2.5-flash는 thinking 모델이라
                # thinking_config 미지정 시 AUTOMATIC thinking budget이 max_output_tokens를
                # 통째로 잠식해 200 OK+빈 text(finish_reason=MAX_TOKENS)로 끝나는 사례 실측.
                # 이 용도(1~3문장 요약/처방)엔 deep reasoning 불요 — thinking_budget=0으로
                # 명시 disable(SDK 문서: "0 is DISABLED"). 모델이 0을 거부하면(일부 모델은
                # 완전 disable 불가) 아래 except가 흡수해 기존 graceful None으로 동일 안전.
                thinking_config=types.ThinkingConfig(thinking_budget=0),
            ),
        )
        latency_ms = round((time.monotonic() - start) * 1000, 2)
        _log_generation_instrumentation(latency_ms, response)

        text = response.text
        if not text or not text.strip():
            logger.warning(
                "llm_client: 빈 응답 → None 처리 (finish_reason=%s)", _finish_reason(response)
            )
            return None
        return text
    except Exception as exc:  # errors.ClientError(4xx: auth/quota/403)·ServerError(5xx)·기타 SDK 오류 포괄
        logger.warning("llm_client: 생성 실패: %s", exc)
        return None


def _finish_reason(response) -> str | None:
    """candidates[0].finish_reason — MAX_TOKENS(thinking 잠식 등)/SAFETY/RECITATION 등 빈
    응답의 근본 원인 진단용(PO 실측 요청, 2026-07-02). 실패해도 None(진단 보조일 뿐)."""
    try:
        candidates = getattr(response, "candidates", None)
        if not candidates:
            return None
        reason = getattr(candidates[0], "finish_reason", None)
        return reason.value if reason is not None and hasattr(reason, "value") else (
            str(reason) if reason is not None else None
        )
    except Exception:
        return None


def _log_generation_instrumentation(latency_ms: float, response) -> None:
    """S25 AC③ 토큰 cap+구조화 로깅 — 크레딧 내 비용 추적(P1-S8 A2 계측 관용구 재사용).
    2026-07-02 PO 실측 후 finish_reason/thoughts_token_count 추가(빈 응답 근본원인 진단 —
    MAX_TOKENS면 thinking 잠식, SAFETY면 콘텐츠 차단 구분).

    non-fatal: 계측 실패가 이미 확보된 생성 응답을 막으면 안 된다(응답엔 무영향)."""
    try:
        usage = getattr(response, "usage_metadata", None)
        logger.info(
            "llm generation",
            extra={"structured": {
                "model": MODEL_VERSION,
                "latency_ms": latency_ms,
                "prompt_token_count": getattr(usage, "prompt_token_count", None) if usage else None,
                "candidates_token_count": getattr(usage, "candidates_token_count", None) if usage else None,
                "thoughts_token_count": getattr(usage, "thoughts_token_count", None) if usage else None,
                "total_token_count": getattr(usage, "total_token_count", None) if usage else None,
                "finish_reason": _finish_reason(response),
            }},
        )
    except Exception as exc:
        logger.warning("llm_client instrumentation 실패(응답엔 무영향): %s", exc)


# ── S28: Claude(claude-sonnet-5, Vertex Model Garden) — 실험 경로 ─────────────────

CLAUDE_MODEL_VERSION = "claude-sonnet-5"
# PO 실측(2026-07-02): 리전 엔드포인트(asia-northeast3 등)는 429 quota — global 로케이션이
# 유일하게 동작(rawPredict 200 확인). google-genai(Gemini)의 vertex_ai_location과는 무관.
_CLAUDE_REGION = "global"
_CLAUDE_REASONING_LEVELS = frozenset({"disabled", "low", "medium", "high", "xhigh", "max"})


def generate_text_claude(
    prompt: str, *, max_output_tokens: int = DEFAULT_MAX_OUTPUT_TOKENS, reasoning: str = "disabled",
    response_schema: dict | None = None,
) -> str | None:
    """Claude(claude-sonnet-5) 생성 — S28 모델/reasoning 레벨 실험용 별도 경로.

    reasoning: "disabled"(thinking 끔) | "low"/"medium"/"high"/"xhigh"/"max"(adaptive thinking
    +output_config.effort). ⚠️실측(2026-07-02): claude-sonnet-5는 구형
    thinking.type="enabled"+budget_tokens를 지원 안 함(invalid_request_error 확인) —
    thinking.type="adaptive"+output_config.effort로만 강도 제어 가능.

    response_schema(E-SPRINT-LOOP dc861e44 2026-07-03, 선생님/PO 지적): JSON Schema를 주면
    `output_config.format`으로 structured output을 강제한다(AnthropicVertex·claude-sonnet-5·
    rawPredict가 GA로 지원 — 모델 교체 불요, 실측 SDK 0.115.1
    `messages.create(output_config=...)` 확인). 프리앰블/트레일링 프로즈 문제(retro
    synthesize 502 dev repro)의 근본 해법 — 프롬프트로 "JSON만 내라" 애원하는 밴드에이드
    대신 스키마로 유효 JSON을 구조적으로 보장한다. top-level은 object 권장(배열 직접
    top-level은 지양 — 호출부가 스키마의 wrapping key로 꺼낸다). effort(reasoning)와
    format은 `output_config` 안에서 병합(SDK `.stream()` 구현의 병합 패턴과 동일 원칙).

    stop_reason 명시 체크(max_tokens/refusal) — 스키마가 유효성을 보장해도 truncate/거부는
    막지 못하므로, 텍스트가 비어있지 않아도 이 두 stop_reason이면 즉시 실패(None) 처리한다
    (부분 JSON을 "성공"으로 오인하지 않기 위함).

    graceful 계약은 generate_text()와 동일: 인증 불가/빈 입력/API 오류/빈 응답/truncate/거부
    시 None(예외 전파 없음 — 호출부는 이를 "아직 못 만듦"으로 처리하고 graceful degrade해야
    한다)."""
    if not prompt or not prompt.strip():
        return None
    if reasoning not in _CLAUDE_REASONING_LEVELS:
        reasoning = "disabled"

    creds_file = os.environ.get("GOOGLE_APPLICATION_CREDENTIALS")
    if not creds_file and not _has_adc():
        logger.warning("llm_client(claude): 인증 정보 없음 → None 처리")
        return None

    start = time.monotonic()
    try:
        from anthropic import AnthropicVertex

        client = AnthropicVertex(region=_CLAUDE_REGION, project_id=settings.gcp_project_id)
        kwargs: dict = {
            "model": CLAUDE_MODEL_VERSION,
            "max_tokens": max_output_tokens,
            "messages": [{"role": "user", "content": prompt}],
        }
        if reasoning == "disabled":
            kwargs["thinking"] = {"type": "disabled"}
        else:
            kwargs["thinking"] = {"type": "adaptive"}

        output_config: dict = {}
        if reasoning != "disabled":
            output_config["effort"] = reasoning
        if response_schema is not None:
            output_config["format"] = {"type": "json_schema", "schema": response_schema}
        if output_config:
            kwargs["output_config"] = output_config

        response = client.messages.create(**kwargs)
        latency_ms = round((time.monotonic() - start) * 1000, 2)
        _log_claude_generation_instrumentation(latency_ms, response, reasoning)

        stop_reason = getattr(response, "stop_reason", None)
        if stop_reason in ("max_tokens", "refusal"):
            logger.warning(
                "llm_client(claude): stop_reason=%s(truncate/거부) → None 처리", stop_reason
            )
            return None

        text = "".join(
            block.text for block in response.content if getattr(block, "type", None) == "text"
        ).strip()
        if not text:
            logger.warning(
                "llm_client(claude): 빈 응답 → None 처리 (stop_reason=%s)", stop_reason
            )
            return None
        return text
    except Exception as exc:  # invalid_request_error(4xx)·auth/quota·기타 SDK 오류 포괄
        logger.warning("llm_client(claude): 생성 실패: %s", exc)
        return None


def _log_claude_generation_instrumentation(latency_ms: float, response, reasoning: str) -> None:
    """S28: Claude 경로 latency+token 구조화 로깅 — 모델/reasoning 레벨 비교 실험 데이터
    (선생님 요청 latency 표의 소스). non-fatal: 계측 실패가 응답을 막지 않는다."""
    try:
        usage = getattr(response, "usage", None)
        details = getattr(usage, "output_tokens_details", None) if usage else None
        logger.info(
            "llm generation (claude)",
            extra={"structured": {
                "model": CLAUDE_MODEL_VERSION,
                "reasoning": reasoning,
                "latency_ms": latency_ms,
                "input_tokens": getattr(usage, "input_tokens", None) if usage else None,
                "output_tokens": getattr(usage, "output_tokens", None) if usage else None,
                "thinking_tokens": getattr(details, "thinking_tokens", None) if details else None,
                "stop_reason": getattr(response, "stop_reason", None),
            }},
        )
    except Exception as exc:
        logger.warning("llm_client(claude) instrumentation 실패(응답엔 무영향): %s", exc)
