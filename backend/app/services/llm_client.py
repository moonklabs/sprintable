"""E-LOOP-LEDGER S25/S28/E-SPRINT-LOOP: Vertex AI 생성형 텍스트 클라이언트(Gemini).

embedding_client.py와 동일한 genai.Client(vertexai=True) 재사용 — 신규 크리덴셜/배선 0(같은
ADC/aiplatform SA, embed와 동일 project/location). L2 종합(S26)·S15 자동초안·L3 다음가설
추천(dc861e44) 전부 이 위에서 unlock되는 복리 지능 파운데이션(선생님 GO 2026-07-02).

인증 불가/빈 입력/API 오류는 예외 전파 없이 None 반환(embed_text와 동일 격리 철학 — 생성 실패가
호출부를 크래시시키거나 잘못된 결과로 오인되게 하지 않는다. 절대 실패를 성공으로 위장하지 않음).

Gemini 피벗(2026-07-03, 선생님/PO 지시): moonklabs org GCP credit이 Vertex Claude를 포함하지
않아(Gemini만 가능) S28에서 추가했던 Claude 경로(`generate_text_claude`, claude-sonnet-5)를
완전 은퇴하고 전 호출부를 이 함수로 되돌렸다. structured output(dc861e44/#1866의 근본 —
프롬프트로 "JSON만 내라" 애원하는 밴드에이드 대신 스키마로 유효 JSON을 구조적으로 보장)은
`response_schema` 파라미터로 이관 — `GenerateContentConfig.response_json_schema`(표준 JSON
Schema, google-genai 2.10.0 SDK 소스 실측 확인)가 기존에 만든 스키마 dict(items-wrapping)를
그대로 받아들여 스키마 재설계 0. Claude의 stop_reason(max_tokens/refusal) 방어와 동형으로
finish_reason(!=STOP)도 명시 실패 처리 — 부분 출력을 성공으로 오인하지 않는다.

모델 A/B(선생님 지시: Gemini 3.5 Flash·Gemini 3.1 Pro Preview 비교): PO(오르테가군)가 live
Vertex generateContent 실콜로 정확한 model ID를 실측 확정(2026-07-03) — `gemini-3.5-flash`·
`gemini-3.1-pro-preview`. **둘 다 `location=global`서만 동작**(asia-northeast3/us-central1은
404 "Publisher model not found" — 처음 겪은 404는 model ID 문제가 아니라 region 문제였다,
claude-sonnet-5가 Vertex global 전용이었던 것과 동일 패턴). 기존 `gemini-2.5-flash`/embedding은
`asia-northeast3`에서 정상 동작하므로 이를 건드리지 않기 위해 location도 모델과 별도로
`LLM_GEMINI_LOCATION` env var로 오버라이드 가능하게 분리한다(기본값은 기존 `settings.
vertex_ai_location` 그대로 — 3.x 모델로 전환할 때만 `LLM_GEMINI_LOCATION=global` 세팅).
`generate_text`의 `model=`/`location=` 파라미터로 단일 호출 강제 오버라이드도 가능(같은
프롬프트를 두 모델로 나란히 비교하는 평가 스크립트 용도).
"""
from __future__ import annotations

import logging
import os
import time

from app.core.config import settings

logger = logging.getLogger(__name__)

# PO 실측 확정(2026-07-03, live Vertex generateContent 200) — 안전 기본값은 기존 실측
# 검증된 gemini-2.5-flash. 3.x(gemini-3.5-flash/gemini-3.1-pro-preview)로 전환 시
# env var만 세팅(코드 변경 0).
MODEL_VERSION = os.environ.get("LLM_GEMINI_MODEL", "gemini-2.5-flash")
# PO 실측(2026-07-03): gemini-3.x는 location=global 전용(asia-northeast3/us-central1
# 둘 다 404 "Publisher model not found" — claude-sonnet-5와 동일 패턴). 기존
# gemini-2.5-flash/embedding은 asia-northeast3에서 정상 동작 중이라 이를 건드리지 않기
# 위해 location을 모델과 별도 env var로 분리(기본값=기존 settings.vertex_ai_location 그대로).
MODEL_LOCATION = os.environ.get("LLM_GEMINI_LOCATION") or settings.vertex_ai_location
# S25 AC③ — 토큰 cap(과금 안전핀). L2 종합류 짧은 산출물 용도로 512면 충분(호출부가 필요시 override).
DEFAULT_MAX_OUTPUT_TOKENS = 512

# Gemini finish_reason 성공 판정 — STOP만 정상 종료. MAX_TOKENS(thinking 잠식/truncate)·
# SAFETY·RECITATION·OTHER 등은 부분/거부 출력일 수 있어 텍스트가 비어있지 않아도 실패로
# 수렴한다(Claude stop_reason=max_tokens/refusal 방어와 동형 원칙, #1866).
_SUCCESS_FINISH_REASONS = frozenset({"STOP", None})


def _has_adc() -> bool:
    """Application Default Credentials 사용 가능 여부 간단 체크(embedding_client.py와 동형)."""
    try:
        import google.auth
        google.auth.default()
        return True
    except Exception:
        return False


def generate_text(
    prompt: str, *, max_output_tokens: int = DEFAULT_MAX_OUTPUT_TOKENS,
    model: str | None = None, location: str | None = None,
    response_schema: dict | None = None,
) -> str | None:
    """프롬프트로 텍스트 생성. 인증 불가/빈 입력/API 오류/빈 응답/비정상 종료 시 None(예외
    전파 없음).

    model: 단일 호출 강제 오버라이드(모델 A/B 비교용) — 생략 시 MODEL_VERSION(env 또는 기본값).
    location: 단일 호출 강제 오버라이드 — 생략 시 MODEL_LOCATION(env 또는 기본값). 3.x 모델은
    location="global" 필수(PO 실측, 2026-07-03 — asia-northeast3/us-central1은 404).
    response_schema: 표준 JSON Schema dict를 주면 structured output 강제(top-level object
    권장 — 배열 직접 top-level은 지양, 호출부가 wrapping key로 꺼낸다). None이면 기존과
    동일한 순수 텍스트 생성.

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
            location=location or MODEL_LOCATION,
            http_options=types.HttpOptions(api_version="v1"),
        )
        config_kwargs: dict = {
            "max_output_tokens": max_output_tokens,
            # PO 실측(dev 로그, 2026-07-02): gemini-2.5-flash는 thinking 모델이라
            # thinking_config 미지정 시 AUTOMATIC thinking budget이 max_output_tokens를
            # 통째로 잠식해 200 OK+빈 text(finish_reason=MAX_TOKENS)로 끝나는 사례 실측.
            # 이 용도(1~3문장 요약/처방)엔 deep reasoning 불요 — thinking_budget=0으로
            # 명시 disable(SDK 문서: "0 is DISABLED"). 모델이 0을 거부하면(일부 모델은
            # 완전 disable 불가) 아래 except가 흡수해 기존 graceful None으로 동일 안전.
            "thinking_config": types.ThinkingConfig(thinking_budget=0),
        }
        if response_schema is not None:
            config_kwargs["response_mime_type"] = "application/json"
            config_kwargs["response_json_schema"] = response_schema

        response = client.models.generate_content(
            model=model or MODEL_VERSION,
            contents=prompt,
            config=types.GenerateContentConfig(**config_kwargs),
        )
        latency_ms = round((time.monotonic() - start) * 1000, 2)
        _log_generation_instrumentation(latency_ms, response, model or MODEL_VERSION)

        finish_reason = _finish_reason(response)
        if finish_reason not in _SUCCESS_FINISH_REASONS:
            logger.warning(
                "llm_client: finish_reason=%s(비정상 종료) → None 처리", finish_reason
            )
            return None

        text = response.text
        if not text or not text.strip():
            logger.warning("llm_client: 빈 응답 → None 처리 (finish_reason=%s)", finish_reason)
            return None
        return text
    except Exception as exc:  # errors.ClientError(4xx: auth/quota/403)·ServerError(5xx)·기타 SDK 오류 포괄
        logger.warning("llm_client: 생성 실패: %s", exc)
        return None


def _finish_reason(response) -> str | None:
    """candidates[0].finish_reason — MAX_TOKENS(thinking 잠식 등)/SAFETY/RECITATION 등 빈
    응답의 근본 원인 진단 겸 성공/실패 판정(PO 실측 요청, 2026-07-02). 조회 자체가 실패해도
    None(그 경우 _SUCCESS_FINISH_REASONS에 포함돼 있어 텍스트 유무로만 판정하는 기존 계약
    유지 — 진단 실패가 정상 응답을 실패로 오판하지 않게)."""
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


def _log_generation_instrumentation(latency_ms: float, response, model: str) -> None:
    """S25 AC③ 토큰 cap+구조화 로깅 — 크레딧 내 비용 추적(P1-S8 A2 계측 관용구 재사용).
    2026-07-02 PO 실측 후 finish_reason/thoughts_token_count 추가(빈 응답 근본원인 진단 —
    MAX_TOKENS면 thinking 잠식, SAFETY면 콘텐츠 차단 구분). model 파라미터는 실제 호출에 쓰인
    model(A/B 비교 시 model= 오버라이드값)을 로그에 남겨 결과를 모델별로 구분 가능하게 한다.

    non-fatal: 계측 실패가 이미 확보된 생성 응답을 막으면 안 된다(응답엔 무영향)."""
    try:
        usage = getattr(response, "usage_metadata", None)
        logger.info(
            "llm generation",
            extra={"structured": {
                "model": model,
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
