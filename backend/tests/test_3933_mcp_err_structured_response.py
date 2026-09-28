"""story #3933 — MCP 에러 응답 구조 재설계(`{code,message,hint?,detail?}`) 회귀 테스트.

배경: BE `HTTPException(detail=...)`이 `sprintable_mcp/api_client.py::_extract_error_message`
→ `SprintableApiError` → `sprintable_mcp/tools/*.py`의 `except Exception as exc: return
err(exc)` 123곳 공통 경로를 거쳐 fleet 에이전트에게 나간다. 이 파일은 그 전체 파이프라인을
실 BE 응답 body 모양 fixture 3개로 고정한다(합성이 아니라 `_extract_error_message`
docstring·실제 코드 관례에서 그라운딩된 모양) — 라이브 캡처 1건(circuit_breaker_open, AC3
우선 처리)을 포함.

양성대조 — err()가 구조를 잃으면(예전 `err(str(exc))`로 되돌리면) 이 테스트들이 code/hint
필드 부재로 즉시 RED가 된다(별도 mutation 스텝 없이 assertion 자체가 그 역할).
"""
from __future__ import annotations

import json

from sprintable_mcp.api_client import SprintableApiError, _extract_error_code, _extract_error_message
from sprintable_mcp.response import err


def _err_payload(exc: BaseException) -> dict:
    """err()의 1행(하위호환)을 건너뛰고 JSON 블록만 파싱해 구조를 검사한다."""
    result = err(exc)
    text = result[0].text
    assert text.startswith("Error: ")
    first_line, json_block = text.split("\n", 1)
    return json.loads(json_block)


def test_fixture1_standard_code_message_envelope():
    """{"error": {"code","message"}} 표준 엔벨로프(main.py http_exception_handler 산출) —
    _extract_error_message case 1."""
    body = {"error": {"code": "NOT_FOUND", "message": "스토리를 찾을 수 없습니다"}}
    message = _extract_error_message(404, body)
    exc = SprintableApiError(404, message, body)
    payload = _err_payload(exc)
    assert payload["code"] == "NOT_FOUND"
    assert payload["message"] == "스토리를 찾을 수 없습니다"
    assert payload["detail"] == body


def test_fixture2_dict_detail_raw_http_exception():
    """{"detail": {"code","message"}} — 엔벨로프 미적용 raw HTTPException(main.py 미들웨어
    적용 前 경로 방어). _extract_error_message case 2."""
    body = {"detail": {"code": "FORBIDDEN", "message": "생성자만 삭제할 수 있습니다"}}
    message = _extract_error_message(403, body)
    exc = SprintableApiError(403, message, body)
    payload = _err_payload(exc)
    assert payload["code"] == "FORBIDDEN"
    assert payload["message"] == "생성자만 삭제할 수 있습니다"


def test_fixture3_circuit_breaker_open_ac3_priority_case():
    """AC3 우선 처리 — conversations.py:2551(폭주 감지 차단)이 차단된 «에이전트 자신»에게
    가는 자리. code+hint 둘 다 살아야 한다(예전엔 error 키+message 한 문장 뭉텅이였음)."""
    body = {
        "detail": {
            "code": "CIRCUIT_BREAKER_OPEN",
            "message": "폭주 감지로 이 대화의 agent 발신이 일시 차단되었습니다",
            "hint": "org owner/admin의 해제 또는 자동 해소를 기다려주세요",
            "conversation_id": "11111111-1111-1111-1111-111111111111",
            "circuit_breaker_id": "22222222-2222-2222-2222-222222222222",
        }
    }
    message = _extract_error_message(423, body)
    exc = SprintableApiError(423, message, body)
    payload = _err_payload(exc)
    assert payload["code"] == "CIRCUIT_BREAKER_OPEN"
    assert payload["message"] == "폭주 감지로 이 대화의 agent 발신이 일시 차단되었습니다"
    # hint는 response.py::_ERROR_HINTS(code 사전)에서 온다 — BE body 자신의 hint 필드가
    # 아니라(현재 err()는 detail dict 안 hint를 직접 승격하지 않는다, 구조 단순 유지),
    # 그래도 최종 payload에 실려야 한다.
    assert payload["hint"] == "org owner/admin의 해제 또는 자동 해소를 기다려주세요"
    # 원본 conversation_id/circuit_breaker_id는 detail에 raw body 그대로 보존(정보 손실
    # 0 — .detail은 언랩 안 한 원본 응답 body 전체, HTTPException의 "detail" 래퍼 포함).
    assert payload["detail"]["detail"]["conversation_id"] == "11111111-1111-1111-1111-111111111111"


def test_fixture4_validation_array_422():
    """FastAPI 422 pydantic 검증 배열 — code 없음(필드명이 code가 아님), UNKNOWN 폴백."""
    body = {
        "detail": [
            {"loc": ["body", "metric_definition", "source"], "msg": "field required", "type": "missing"},
        ]
    }
    message = _extract_error_message(422, body)
    exc = SprintableApiError(422, message, body)
    payload = _err_payload(exc)
    assert payload["code"] == "UNKNOWN"
    assert "metric_definition.source" in payload["message"]


def test_plain_exception_no_detail_field():
    """SprintableApiError가 아닌 일반 예외 — detail 필드 자체가 생략된다(정보 없음을
    있는 그대로 반영, 빈 값 조작 없음)."""
    payload = _err_payload(RuntimeError("무관한 파이썬 예외"))
    assert payload["code"] == "UNKNOWN"
    assert payload["message"] == "무관한 파이썬 예외"
    assert "detail" not in payload


def test_code_passed_explicitly_at_raise_site_not_only_via_string_roundtrip():
    """페드루 PO CHANGES①(PR#4357) — `_extract_error_code`가 code를 직접 뽑아 `raise
    SprintableApiError(..., code=...)`로 명시 전달된다(문자열 왕복 되파싱에만 의존하지
    않음). 명시 code와 정규식 폴백 둘 다 같은 결과를 내되, 명시 경로가 정본임을 확認."""
    body = {"error": {"code": "NOT_FOUND", "message": "Artifact not found"}}
    code = _extract_error_code(body)
    message = _extract_error_message(404, body)
    assert code == "NOT_FOUND"

    exc_explicit = SprintableApiError(404, message, body, code=code)
    exc_fallback = SprintableApiError(404, message, body)  # code 생략 — 폴백 경로
    assert exc_explicit.code == exc_fallback.code == "NOT_FOUND"
    assert exc_explicit.message == exc_fallback.message == "Artifact not found"


def test_code_extraction_returns_none_when_body_has_no_code():
    """422 검증 배열·평문 detail·비-dict body는 code 개념이 없다 — None(UNKNOWN 폴백은
    err()가 담당, 여기선 추출 단계의 정직한 부재만 확認)."""
    assert _extract_error_code({"detail": [{"loc": ["body", "x"], "msg": "required"}]}) is None
    assert _extract_error_code({"detail": "plain text"}) is None
    assert _extract_error_code("not even a dict") is None


def test_unrelated_tool_success_path_unaffected_noop():
    """무관 도구(ok() 경로) — err() 재설계가 성공 응답 모양에 전혀 안 닿는다(no-op 확認)."""
    from sprintable_mcp.response import ok

    result = ok({"id": "abc", "title": "제목"})
    assert result[0].text == json.dumps({"id": "abc", "title": "제목"}, indent=2, ensure_ascii=False)
