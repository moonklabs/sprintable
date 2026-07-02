"""E-LOOP-LEDGER P1-S8: A2 계측(구조화 로깅) 단위 테스트(블루프린트 §P1).

핵심 불변식: (1) JsonFormatter가 extra={"structured": {...}}로 전달된 임의 필드를 JSON payload에
병합한다(Cloud Logging jsonPayload 필터/집계 가능) (2) 검색 인스트루멘테이션(COUNT 쿼리) 실패가
검색 응답 자체를 절대 막지 않는다(로깅은 non-fatal — 이 서비스 전체가 계승하는 additive 원칙).
"""
import json
import logging
import uuid
from types import SimpleNamespace
from unittest.mock import AsyncMock, MagicMock, patch

import pytest

from app.core.logging_config import JsonFormatter
from app.routers import context_pack as cp


def test_json_formatter_merges_structured_extra_fields():
    formatter = JsonFormatter()
    record = logging.LogRecord(
        name="test", level=logging.INFO, pathname="x", lineno=1,
        msg="context-pack search", args=(), exc_info=None,
    )
    record.structured = {"query_latency_ms": 12.5, "result_count": 3, "embeddings_total_rows": 100}
    payload = json.loads(formatter.format(record))
    assert payload["query_latency_ms"] == 12.5
    assert payload["result_count"] == 3
    assert payload["embeddings_total_rows"] == 100
    assert payload["message"] == "context-pack search"


def test_json_formatter_omits_structured_key_when_absent():
    formatter = JsonFormatter()
    record = logging.LogRecord(
        name="test", level=logging.INFO, pathname="x", lineno=1,
        msg="plain log", args=(), exc_info=None,
    )
    payload = json.loads(formatter.format(record))
    assert "query_latency_ms" not in payload
    assert payload["message"] == "plain log"


async def test_log_search_instrumentation_calls_logger_with_expected_fields():
    session = AsyncMock()
    session.execute = AsyncMock(return_value=SimpleNamespace(scalar=lambda: 42))
    with patch.object(cp, "logger") as mock_logger:
        await cp._log_search_instrumentation(session, 15.3, 5)
    mock_logger.info.assert_called_once()
    _, kwargs = mock_logger.info.call_args
    structured = kwargs["extra"]["structured"]
    assert structured == {"query_latency_ms": 15.3, "result_count": 5, "embeddings_total_rows": 42}


async def test_instrumentation_count_query_failure_does_not_raise():
    """COUNT(*) 쿼리가 실패해도 예외가 전파되지 않는다 — 검색 응답을 절대 막지 않기 위함."""
    session = AsyncMock()
    session.execute = AsyncMock(side_effect=RuntimeError("db hiccup"))
    with patch.object(cp, "logger") as mock_logger:
        await cp._log_search_instrumentation(session, 10.0, 2)  # raise 없이 정상 반환.
    mock_logger.warning.assert_called_once()
    mock_logger.info.assert_not_called()
