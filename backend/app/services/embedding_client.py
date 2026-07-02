"""E-LOOP-LEDGER P1-S2: Vertex AI(gemini-embedding-001) 임베딩 클라이언트.

ga4_client.py/app/services/storage/gcs.py와 동형 ADC 인증 패턴 — 신규 크리덴셜 관리 0.
GOOGLE_APPLICATION_CREDENTIALS 환경변수 또는 ADC(gcloud auth application-default login).
인증 불가/API 오류는 예외 전파 없이 None 반환(pending 유지 — GA4 unauth와 동일 격리 철학,
S8의 "false-hit 0" 설계를 그대로 계승: 임베딩 실패가 잘못된 검색 결과를 만들지 않는다).

모델/차원: gemini-embedding-001 @ output_dimensionality=768(파운데이션 crux 확정,
2026-07-01) — app.core.config.EMBEDDING_DIMENSION 단일소스(app.models.embedding.Embedding.
embedding 컬럼과 정합, PO 지시로 2026-07-02 중복 상수 정리). config.py는 pydantic Settings
객체 없이도 import 가능해 S1 머지 여부와 무관하게 이 스토리가 독립 개발/머지된다.
"""
from __future__ import annotations

import logging
import os

from app.core.config import EMBEDDING_DIMENSION, settings

logger = logging.getLogger(__name__)

MODEL_VERSION = "gemini-embedding-001"


def _has_adc() -> bool:
    """Application Default Credentials 사용 가능 여부 간단 체크(ga4_client.py와 동형)."""
    try:
        import google.auth
        google.auth.default()
        return True
    except Exception:
        return False


def embed_text(text: str) -> list[float] | None:
    """단일 텍스트를 임베딩. 인증 불가/API 오류/빈 입력 시 None(예외 전파 없음).

    Returns:
        768차원 float 리스트 또는 None(회수 실패 — 호출자는 이를 '아직 못 채움'으로 처리하고
        pending 유지해야 한다. 절대 임의 벡터로 대체하거나 실패를 성공으로 위장하지 않는다).
    """
    if not text or not text.strip():
        return None

    creds_file = os.environ.get("GOOGLE_APPLICATION_CREDENTIALS")
    if not creds_file and not _has_adc():
        logger.warning("embedding_client: 인증 정보 없음 → None 처리(pending 유지)")
        return None

    try:
        from google import genai
        from google.genai import types

        client = genai.Client(
            vertexai=True,
            project=settings.gcp_project_id,
            location=settings.vertex_ai_location,
            http_options=types.HttpOptions(api_version="v1"),
        )
        response = client.models.embed_content(
            model=MODEL_VERSION,
            contents=text,
            config=types.EmbedContentConfig(output_dimensionality=EMBEDDING_DIMENSION),
        )
        values = response.embeddings[0].values
        if not values or len(values) != EMBEDDING_DIMENSION:
            logger.warning(
                "embedding_client: 예상치 못한 응답 차원(got=%s expected=%s) → None 처리",
                len(values) if values else 0, EMBEDDING_DIMENSION,
            )
            return None
        return list(values)
    except Exception as exc:  # errors.ClientError(4xx: auth/quota)·ServerError(5xx)·기타 SDK 오류 포괄
        logger.warning("embedding_client: 임베딩 실패: %s", exc)
        return None


def embed_texts(texts: list[str]) -> list[list[float] | None]:
    """다건 임베딩(cron 배치 처리용, P1-S3). ⚠️gemini-embedding-001은 요청당 단일 입력
    텍스트 제한이라 진짜 batch API가 아니라 embed_text를 순차 호출한다 — 항목별 성공/실패가
    독립적이라(한 텍스트 실패가 나머지를 막지 않음) 호출자(cron)가 항목별로 status를
    ready/failed로 나눠 갱신할 수 있다. 입력과 동일 길이·동일 순서로 반환."""
    return [embed_text(t) for t in texts]
