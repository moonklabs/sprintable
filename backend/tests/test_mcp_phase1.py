"""E-MCP-PYTHON Phase 1 통합 검증 — S1-1~S1-4."""
from __future__ import annotations

import json
import uuid
from datetime import datetime, timezone
from unittest.mock import AsyncMock, MagicMock, patch

import pytest

from sprintable_mcp.api_client import SprintableApiError, SprintableClient
from sprintable_mcp.response import err, ok


# ─── AC1/AC2: env fail-fast ────────────────────────────────────────────────

def test_configure_raises_without_api_url():
    c = SprintableClient()
    with pytest.raises(ValueError, match="api_url"):
        c.configure("", "sk_live_test")


def test_configure_raises_without_api_key():
    c = SprintableClient()
    with pytest.raises(ValueError, match="api_key"):
        c.configure("https://api.sprintable.ai", "")


# ─── AC3: 401 → SprintableApiError(status=401) ────────────────────────────

@pytest.mark.anyio
async def test_resolve_auth_context_401():
    c = SprintableClient()
    c.configure("https://api.sprintable.ai", "sk_invalid")

    mock_resp = MagicMock()
    mock_resp.is_success = False
    mock_resp.status_code = 401
    mock_resp.json.return_value = {"error": "Unauthorized"}

    with patch("httpx.AsyncClient.request", new_callable=AsyncMock, return_value=mock_resp):
        with pytest.raises(SprintableApiError) as exc_info:
            await c.resolve_auth_context()
    assert exc_info.value.status == 401


# ─── S1-3: resolve_auth_context 정상 캐시 ──────────────────────────────────

@pytest.mark.anyio
async def test_resolve_auth_context_caches_ids():
    c = SprintableClient()
    c.configure("https://api.sprintable.ai", "sk_live_test")

    member_id = str(uuid.uuid4())
    org_id = str(uuid.uuid4())
    project_id = str(uuid.uuid4())

    mock_resp = MagicMock()
    mock_resp.is_success = True
    mock_resp.json.return_value = {
        "member_id": member_id,
        "org_id": org_id,
        "project_id": project_id,
    }

    with patch("httpx.AsyncClient.request", new_callable=AsyncMock, return_value=mock_resp):
        result = await c.resolve_auth_context()

    assert c.member_id == member_id
    assert c.org_id == org_id
    assert c.project_id == project_id
    assert result == {"member_id": member_id, "org_id": org_id, "project_id": project_id}


# ─── S1-3: context 자동 주입 ───────────────────────────────────────────────

@pytest.mark.anyio
async def test_post_injects_context_fields():
    c = SprintableClient()
    c.configure("https://api.sprintable.ai", "sk_live_test")
    c._org_id = "org-123"
    c._project_id = "proj-456"
    c._member_id = "member-789"

    captured: dict = {}

    mock_resp = MagicMock()
    mock_resp.is_success = True
    mock_resp.json.return_value = {"data": {"id": "story-1"}}

    async def fake_request(method, url, **kwargs):
        captured.update(kwargs.get("json", {}))
        return mock_resp

    with patch("httpx.AsyncClient.request", new_callable=AsyncMock, side_effect=fake_request):
        await c.post("/api/v2/stories", json={"title": "Test"})

    assert captured["org_id"] == "org-123"
    assert captured["project_id"] == "proj-456"
    assert captured["created_by"] == "member-789"


# ─── S1-4: ok() 포맷 ───────────────────────────────────────────────────────

def test_ok_returns_text_content():
    result = ok({"key": "value"})
    assert len(result) == 1
    assert result[0].type == "text"
    parsed = json.loads(result[0].text)
    assert parsed == {"key": "value"}


def test_ok_serializes_datetime():
    dt = datetime(2026, 5, 18, 8, 0, 0, tzinfo=timezone.utc)
    result = ok({"ts": dt})
    parsed = json.loads(result[0].text)
    assert parsed["ts"] == "2026-05-18T08:00:00+00:00"


def test_ok_serializes_uuid():
    uid = uuid.UUID("12345678-1234-5678-1234-567812345678")
    result = ok({"id": uid})
    parsed = json.loads(result[0].text)
    assert parsed["id"] == "12345678-1234-5678-1234-567812345678"


# ─── S1-4: err() 포맷 ──────────────────────────────────────────────────────

def test_err_returns_call_tool_result_with_is_error():
    # err() returns list[TextContent] (mcp SDK pattern — isError not on list)
    result = err("something went wrong")
    assert isinstance(result, list)
    assert len(result) == 1
    assert result[0].type == "text"
    assert result[0].text == "Error: something went wrong"


# ─── fix/mcp-error-surfacing: 4xx 본문 표면화 ───────────────────────────────
#
# 이전 구현은 {error:{message}} 엔벨로프만 보고 FastAPI 422 검증 배열·dict detail·
# 평문 본문을 버려 'Sprintable API 422'로 삼켰다. 아래 테스트는 공유 헬퍼(request)가
# 백엔드 사유를 SprintableApiError.message(= 도구 err() 문자열)에 노출함을 보장한다.


async def _make_error_client(status: int, json_body=None, *, raise_on_json=False, text_body=""):
    """status/본문을 가진 4xx 응답을 mock해 request 호출 → SprintableApiError 반환."""
    c = SprintableClient()
    c.configure("https://api.sprintable.ai", "sk_live_test")

    mock_resp = MagicMock()
    mock_resp.is_success = False
    mock_resp.status_code = status
    if raise_on_json:
        mock_resp.json.side_effect = ValueError("not json")
        mock_resp.text = text_body
    else:
        mock_resp.json.return_value = json_body

    with patch("httpx.AsyncClient.request", new_callable=AsyncMock, return_value=mock_resp):
        with pytest.raises(SprintableApiError) as exc_info:
            await c.post("/api/v2/hypotheses", json={"statement": "x"})
    return exc_info.value


@pytest.mark.anyio
async def test_error_surfaces_422_validation_array():
    """FastAPI 422 pydantic 배열 → 'field: msg' 요약이 메시지에 포함."""
    err_obj = await _make_error_client(
        422,
        {
            "detail": [
                {
                    "loc": ["body", "metric_definition", "source"],
                    "msg": "value is not a valid enumeration member",
                    "type": "value_error",
                },
                {
                    "loc": ["body", "metric_definition", "target"],
                    "msg": "value is not a valid float",
                    "type": "type_error.float",
                },
            ]
        },
    )
    assert err_obj.status == 422
    msg = str(err_obj)
    assert "metric_definition.source" in msg
    assert "value is not a valid enumeration member" in msg
    assert "metric_definition.target" in msg
    # 회귀 가드: 더 이상 본문을 삼킨 bare 문자열이 아니다.
    assert msg != "Sprintable API 422"


@pytest.mark.anyio
async def test_error_surfaces_human_owner_required_envelope():
    """{error:{code,message}} 엔벨로프(400 HUMAN_OWNER_REQUIRED) → 'CODE: message'."""
    err_obj = await _make_error_client(
        400,
        {
            "data": None,
            "error": {
                "code": "HUMAN_OWNER_REQUIRED",
                "message": "agent caller는 휴먼 owner_member_id를 명시해야 합니다.",
            },
            "meta": None,
        },
    )
    assert err_obj.status == 400
    msg = str(err_obj)
    assert msg.startswith("HUMAN_OWNER_REQUIRED:")
    assert "owner_member_id" in msg


@pytest.mark.anyio
async def test_error_surfaces_dict_detail_code():
    """엔벨로프 미적용 raw dict detail({code,message})도 표면화."""
    err_obj = await _make_error_client(
        400,
        {"detail": {"code": "NO_VALID_FIELDS", "message": "no updatable fields"}},
    )
    msg = str(err_obj)
    assert "NO_VALID_FIELDS" in msg
    assert "no updatable fields" in msg


@pytest.mark.anyio
async def test_error_surfaces_non_json_body():
    """JSON 파싱 실패(HTML/평문 502 등) → 원문 텍스트 노출(삼키지 않음)."""
    err_obj = await _make_error_client(
        502, raise_on_json=True, text_body="<html>Bad Gateway</html>"
    )
    msg = str(err_obj)
    assert err_obj.status == 502
    assert "Bad Gateway" in msg


@pytest.mark.anyio
async def test_error_truncates_large_body():
    """비정상적으로 큰 본문은 잘려 에이전트 컨텍스트를 잠식하지 않는다."""
    err_obj = await _make_error_client(
        500, raise_on_json=True, text_body="x" * 5000
    )
    msg = str(err_obj)
    assert "truncated" in msg
    assert len(msg) < 2000
