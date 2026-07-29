"""SprintableApiClient.request()의 `unwrap` 옵션 — story #2294 ③ 후속(2026-07-29, 오르테가
라이브 실측 버그 수정). `{data: T, ...sibling}` 자동 언래핑이 sibling 키(references·
command_gate 등)를 통째로 버리던 것을 `unwrap=False`로 끌 수 있게 했다 — 기본값(True)은
기존 호출부 전부에 byte-identical(회귀 0)."""
from __future__ import annotations

from unittest.mock import AsyncMock, MagicMock, patch

import pytest

pytestmark = pytest.mark.anyio


@pytest.fixture
def anyio_backend():
    return "asyncio"


def _fake_httpx_response(json_body):
    resp = MagicMock()
    resp.is_success = True
    resp.json.return_value = json_body
    return resp


@pytest.mark.anyio
async def test_request_default_unwraps_data_wrapper():
    from sprintable_mcp.api_client import SprintableClient

    client = SprintableClient()
    client.configure("http://test", "k")
    resp = _fake_httpx_response({"data": {"id": "x"}, "references": {"stored": 1, "dropped": []}})
    with patch("httpx.AsyncClient") as mock_cls:
        mock_cls.return_value.__aenter__.return_value.request = AsyncMock(return_value=resp)
        result = await client.request("GET", "/x")
    assert result == {"id": "x"}  # sibling(references)은 기본 동작에서 여전히 버려진다(회귀 0)


@pytest.mark.anyio
async def test_request_unwrap_false_returns_full_body():
    from sprintable_mcp.api_client import SprintableClient

    client = SprintableClient()
    client.configure("http://test", "k")
    body = {"data": {"id": "x"}, "references": {"stored": 1, "dropped": []}}
    resp = _fake_httpx_response(body)
    with patch("httpx.AsyncClient") as mock_cls:
        mock_cls.return_value.__aenter__.return_value.request = AsyncMock(return_value=resp)
        result = await client.request("POST", "/x", unwrap=False)
    assert result == body  # data와 sibling 전부 그대로 남는다


@pytest.mark.anyio
async def test_post_full_uses_unwrap_false():
    from sprintable_mcp.api_client import SprintableClient

    client = SprintableClient()
    client.configure("http://test", "k")
    body = {"data": {"id": "x"}, "command_gate": {"blocked": ["y"]}}
    resp = _fake_httpx_response(body)
    with patch("httpx.AsyncClient") as mock_cls:
        mock_cls.return_value.__aenter__.return_value.request = AsyncMock(return_value=resp)
        result = await client.post_full("/x", json={})
    assert result == body


@pytest.mark.anyio
async def test_request_no_data_key_returns_as_is_regardless_of_unwrap():
    """data 키 자체가 없는 응답(예: 배열)은 unwrap 값과 무관하게 그대로 반환된다."""
    from sprintable_mcp.api_client import SprintableClient

    client = SprintableClient()
    client.configure("http://test", "k")
    resp = _fake_httpx_response([{"id": "a"}, {"id": "b"}])
    with patch("httpx.AsyncClient") as mock_cls:
        mock_cls.return_value.__aenter__.return_value.request = AsyncMock(return_value=resp)
        result = await client.request("GET", "/x")
    assert result == [{"id": "a"}, {"id": "b"}]
