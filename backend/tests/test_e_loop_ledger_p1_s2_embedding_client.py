"""E-LOOP-LEDGER P1-S2(story 25663736): embedding_client.py 검증.

핵심 격리(비-tautological, GA4 unauth 격리와 동형): 인증 정보 없음 → None(예외 전파 없음).
실 Vertex AI 호출은 하지 않는다(외부 API·GCP 크레딧 소비·CI 네트워크 의존 회피) — SDK 호출부는
mock, 그 앞단(인증 게이트·빈 입력·차원 검증·예외 포괄)은 real 로직 그대로 태운다.
"""
from __future__ import annotations

import os
from unittest.mock import MagicMock, patch

import pytest

from app.services.embedding_client import (
    EMBEDDING_DIMENSION,
    MODEL_VERSION,
    embed_text,
    embed_texts,
)


# ── 빈 입력 ────────────────────────────────────────────────────────────────

def test_empty_text_returns_none_without_auth_check():
    assert embed_text("") is None
    assert embed_text("   ") is None


# ── ⭐핵심 격리: 인증 정보 없음 → None(GA4 unauth와 동형) ─────────────────────

def test_no_credentials_returns_none_no_exception():
    with patch("app.services.embedding_client._has_adc", return_value=False), \
         patch.dict(os.environ, {}, clear=False):
        os.environ.pop("GOOGLE_APPLICATION_CREDENTIALS", None)
        result = embed_text("some real hypothesis statement")
    assert result is None


def test_credentials_file_env_set_skips_adc_check():
    """GOOGLE_APPLICATION_CREDENTIALS가 설정돼 있으면 _has_adc()를 호출조차 안 함(둘 중
    하나만 있으면 통과) — genai.Client 생성부터는 mock해 실제 API 호출은 안 나간다."""
    fake_response = MagicMock()
    fake_response.embeddings = [MagicMock(values=[0.1] * EMBEDDING_DIMENSION)]
    with patch.dict(os.environ, {"GOOGLE_APPLICATION_CREDENTIALS": "/fake/path.json"}), \
         patch("app.services.embedding_client._has_adc") as mock_adc:
        with patch("google.genai.Client") as mock_client_cls:
            mock_client_cls.return_value.models.embed_content.return_value = fake_response
            result = embed_text("hello")
        mock_adc.assert_not_called()
    assert result == [0.1] * EMBEDDING_DIMENSION


# ── 성공 경로(SDK mock) ────────────────────────────────────────────────────

def test_successful_embed_returns_vector_of_expected_dimension():
    fake_response = MagicMock()
    fake_response.embeddings = [MagicMock(values=[0.5] * EMBEDDING_DIMENSION)]
    with patch("app.services.embedding_client._has_adc", return_value=True), \
         patch.dict(os.environ, {}, clear=False):
        os.environ.pop("GOOGLE_APPLICATION_CREDENTIALS", None)
        with patch("google.genai.Client") as mock_client_cls:
            mock_client_cls.return_value.models.embed_content.return_value = fake_response
            result = embed_text("some real hypothesis statement")
    assert result == [0.5] * EMBEDDING_DIMENSION
    assert len(result) == EMBEDDING_DIMENSION

    call_kwargs = mock_client_cls.return_value.models.embed_content.call_args.kwargs
    assert call_kwargs["model"] == MODEL_VERSION


def test_wrong_dimension_response_returns_none():
    """SDK가 예상과 다른 차원을 반환하면(모델/설정 drift) 위험한 벡터를 그대로 쓰지 않고
    None으로 거부 — 잘못된 차원이 HNSW 인덱스에 섞여 들어가는 것을 원천 차단."""
    fake_response = MagicMock()
    fake_response.embeddings = [MagicMock(values=[0.1] * 512)]  # 768이 아님
    with patch("app.services.embedding_client._has_adc", return_value=True), \
         patch.dict(os.environ, {}, clear=False):
        os.environ.pop("GOOGLE_APPLICATION_CREDENTIALS", None)
        with patch("google.genai.Client") as mock_client_cls:
            mock_client_cls.return_value.models.embed_content.return_value = fake_response
            result = embed_text("x")
    assert result is None


def test_sdk_exception_returns_none_not_raised():
    """API 오류(quota/auth/5xx 등)가 예외로 전파되지 않고 None으로 흡수됨 — 호출자(cron)가
    개별 항목 실패로 전체 배치를 죽이지 않게."""
    with patch("app.services.embedding_client._has_adc", return_value=True), \
         patch.dict(os.environ, {}, clear=False):
        os.environ.pop("GOOGLE_APPLICATION_CREDENTIALS", None)
        with patch("google.genai.Client") as mock_client_cls:
            mock_client_cls.return_value.models.embed_content.side_effect = RuntimeError("quota exceeded")
            result = embed_text("x")
    assert result is None


# ── 배치 ────────────────────────────────────────────────────────────────────

def test_embed_texts_preserves_order_and_independent_failures():
    """3건 중 가운데 하나만 실패해도(SDK 예외) 나머지 2건은 정상 반환 — 항목별 독립성."""
    ok_response = MagicMock()
    ok_response.embeddings = [MagicMock(values=[0.2] * EMBEDDING_DIMENSION)]

    call_count = {"n": 0}

    def _side_effect(*args, **kwargs):
        call_count["n"] += 1
        if call_count["n"] == 2:
            raise RuntimeError("boom")
        return ok_response

    with patch("app.services.embedding_client._has_adc", return_value=True), \
         patch.dict(os.environ, {}, clear=False):
        os.environ.pop("GOOGLE_APPLICATION_CREDENTIALS", None)
        with patch("google.genai.Client") as mock_client_cls:
            mock_client_cls.return_value.models.embed_content.side_effect = _side_effect
            results = embed_texts(["a", "b", "c"])

    assert len(results) == 3
    assert results[0] == [0.2] * EMBEDDING_DIMENSION
    assert results[1] is None
    assert results[2] == [0.2] * EMBEDDING_DIMENSION
