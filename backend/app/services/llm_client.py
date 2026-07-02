"""E-LOOP-LEDGER S25(story 0fb72183): Vertex AI(gemini-2.5-flash) 생성형 텍스트 클라이언트.

embedding_client.py와 동일한 genai.Client(vertexai=True) 재사용 — 신규 크리덴셜/배선 0(같은
ADC/aiplatform SA, embed와 동일 project/location). L2 종합(S26)·S15 자동초안·미팅 AI요약(현재
501 stub) 전부 이 위에서 unlock되는 복리 지능 파운데이션(선생님 GO 2026-07-02).

인증 불가/빈 입력/API 오류는 예외 전파 없이 None 반환(embed_text와 동일 격리 철학 — 생성 실패가
호출부를 크래시시키거나 잘못된 결과로 오인되게 하지 않는다. 절대 실패를 성공으로 위장하지 않음).
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
            config=types.GenerateContentConfig(max_output_tokens=max_output_tokens),
        )
        latency_ms = round((time.monotonic() - start) * 1000, 2)
        _log_generation_instrumentation(latency_ms, response)

        text = response.text
        if not text or not text.strip():
            logger.warning("llm_client: 빈 응답 → None 처리")
            return None
        return text
    except Exception as exc:  # errors.ClientError(4xx: auth/quota/403)·ServerError(5xx)·기타 SDK 오류 포괄
        logger.warning("llm_client: 생성 실패: %s", exc)
        return None


def _log_generation_instrumentation(latency_ms: float, response) -> None:
    """S25 AC③ 토큰 cap+구조화 로깅 — 크레딧 내 비용 추적(P1-S8 A2 계측 관용구 재사용).

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
                "total_token_count": getattr(usage, "total_token_count", None) if usage else None,
            }},
        )
    except Exception as exc:
        logger.warning("llm_client instrumentation 실패(응답엔 무영향): %s", exc)
