"""story #1743(재스코핑): GCP Error Reporting 자동 감지/그룹핑 호환.

배경: JsonFormatter가 exc_info 있을 때 traceback을 jsonPayload.exception(커스텀 필드)에만
넣었다 — 이 데이터는 Cloud Logging에 도달하지만(Log Explorer에서 확인 가능), GCP Error
Reporting은 이 비표준 필드명을 자동으로 감지/그룹핑하지 못한다. Error Reporting 문서
("Log a stack trace" — jsonPayload.message/stack_trace/exception 중 하나에 지원 언어
스택 트레이스 포맷이 있어야 자동 인식)에 맞춰 message 필드에도 traceback 텍스트를 포함시킨다.
기존 jsonPayload.exception 필드는 하위호환을 위해 그대로 유지(additive, 회귀 없음).
"""
import json
import logging

from app.core.logging_config import JsonFormatter


def _make_record_with_exc_info(msg: str = "boom") -> logging.LogRecord:
    try:
        raise ValueError("test exception for 1743")
    except ValueError:
        import sys
        exc_info = sys.exc_info()
    return logging.LogRecord(
        name="test", level=logging.ERROR, pathname="x", lineno=1,
        msg=msg, args=(), exc_info=exc_info,
    )


def test_message_field_includes_traceback_when_exc_info_present():
    """핵심 불변식: exc_info 있으면 message 필드 자체에 traceback 패턴이 포함된다
    (Error Reporting 자동 감지 대상은 message/stack_trace/exception 필드)."""
    formatter = JsonFormatter()
    record = _make_record_with_exc_info("boom")
    payload = json.loads(formatter.format(record))
    assert "Traceback (most recent call last)" in payload["message"]
    assert "ValueError: test exception for 1743" in payload["message"]
    # 원래 로그 메시지도 유실되지 않고 message 안에 남아있어야 한다.
    assert "boom" in payload["message"]


def test_existing_exception_field_preserved_for_backward_compat():
    """기존 jsonPayload.exception 필드는 다른 소비자가 있을 수 있으므로 additive만 —
    제거/변경 금지. message와 동일한 traceback 텍스트를 그대로 유지한다."""
    formatter = JsonFormatter()
    record = _make_record_with_exc_info("boom")
    payload = json.loads(formatter.format(record))
    assert "exception" in payload
    assert "Traceback (most recent call last)" in payload["exception"]
    assert "ValueError: test exception for 1743" in payload["exception"]


def test_service_context_added_when_exc_info_present():
    """Cloud Run 알려진 함정: serviceContext.service/version 부재 시 리소스 타입이
    global로 잡혀 Error Reporting 그룹핑 실패. K_SERVICE/K_REVISION(Cloud Run 자동 주입
    표준 env var) 기반으로 채운다."""
    formatter = JsonFormatter()
    record = _make_record_with_exc_info("boom")
    payload = json.loads(formatter.format(record))
    assert "serviceContext" in payload
    assert "service" in payload["serviceContext"]
    assert payload["serviceContext"]["service"]  # non-empty


def test_no_exc_info_leaves_message_and_schema_unchanged():
    """exc_info 없는 평시 로그는 스키마 불변 — message에 traceback 안 붙고
    exception/serviceContext 키 자체가 없어야 한다(회귀 방지)."""
    formatter = JsonFormatter()
    record = logging.LogRecord(
        name="test", level=logging.INFO, pathname="x", lineno=1,
        msg="plain log", args=(), exc_info=None,
    )
    payload = json.loads(formatter.format(record))
    assert payload["message"] == "plain log"
    assert "exception" not in payload
    assert "serviceContext" not in payload
