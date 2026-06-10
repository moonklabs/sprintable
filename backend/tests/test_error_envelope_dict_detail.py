"""글로벌 HTTPException 핸들러 — dict detail 패스스루 + string detail 회귀 0.

기존: `str(exc.detail)` → dict 가 Python repr 로 직렬화돼 FE JSON.parse 불가 + 의도 code 유실.
수정: dict 면 code/message/추가필드(suggestion·retry_after)를 error 객체로 패스스루.
str 이면 기존 shape 유지(회귀 0).
"""
from __future__ import annotations

import json
from unittest.mock import MagicMock

import pytest
from fastapi import HTTPException

from app.main import http_exception_handler


@pytest.fixture
def anyio_backend():
    return "asyncio"


async def _run(exc: HTTPException):
    resp = await http_exception_handler(MagicMock(), exc)
    return resp.status_code, json.loads(resp.body)


# ── dict detail 패스스루 ──────────────────────────────────────────────────────

@pytest.mark.anyio
async def test_dict_detail_passthrough_with_suggestion():
    """SLUG_TAKEN: code + suggestion 이 error 객체로 그대로(FE 가 깔끔히 읽음)."""
    s, body = await _run(HTTPException(409, detail={
        "code": "SLUG_TAKEN", "message": "이미 사용 중인 슬러그", "suggestion": "q3-roadmap-2",
    }))
    assert s == 409
    assert body["error"] == {"code": "SLUG_TAKEN", "message": "이미 사용 중인 슬러그", "suggestion": "q3-roadmap-2"}
    assert body["data"] is None and body["meta"] is None


@pytest.mark.anyio
async def test_dict_detail_slug_invalid():
    s, body = await _run(HTTPException(422, detail={"code": "SLUG_INVALID", "message": "유효하지 않은 슬러그"}))
    assert s == 422
    assert body["error"]["code"] == "SLUG_INVALID" and body["error"]["message"] == "유효하지 않은 슬러그"


@pytest.mark.anyio
async def test_dict_detail_retry_after_passthrough():
    """rate_limit/agent_gateway 류 — retry_after 추가필드도 전달(기존엔 str화돼 유실)."""
    s, body = await _run(HTTPException(429, detail={
        "code": "AGENT_STREAM_LIMITED", "message": "limit", "retry_after": 5,
    }))
    assert body["error"]["code"] == "AGENT_STREAM_LIMITED" and body["error"]["retry_after"] == 5


@pytest.mark.anyio
async def test_dict_detail_without_code_falls_back_to_mapped():
    s, body = await _run(HTTPException(409, detail={"message": "m"}))
    assert body["error"]["code"] == "CONFLICT" and body["error"]["message"] == "m"


@pytest.mark.anyio
async def test_dict_detail_code_only_empty_message():
    s, body = await _run(HTTPException(403, detail={"code": "USER_NOT_IN_ORG"}))
    assert body["error"] == {"code": "USER_NOT_IN_ORG", "message": ""}


# ── string detail 회귀 0 (대다수 raiser) ──────────────────────────────────────

@pytest.mark.anyio
async def test_string_detail_unchanged():
    s, body = await _run(HTTPException(404, detail="Doc not found"))
    assert s == 404
    assert body["error"] == {"code": "NOT_FOUND", "message": "Doc not found"}


@pytest.mark.anyio
async def test_unmapped_status_string_detail():
    s, body = await _run(HTTPException(418, detail="teapot"))
    assert body["error"] == {"code": "HTTP_418", "message": "teapot"}
