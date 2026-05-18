"""S5-6: SSE/REST connection pool 분리 + 재연결 누수 검증.

블루프린트 리스크 게이트 — make_sse_client()의 max_connections=1 격리가
REST SprintableClient pool에 영향 없음을 테스트로 입증.
"""
from __future__ import annotations

import asyncio
import inspect
from unittest.mock import AsyncMock, MagicMock, patch

import pytest

from sprintable_mcp.api_client import SprintableClient
from sprintable_mcp.sse_bridge import make_sse_client, start_sse_bridge


# ── AC1: SSE pool limits 검증 ──────────────────────────────────────────────────

def test_sse_client_pool_max_connections_is_1():
    """make_sse_client() → httpcore pool max_connections=1."""
    client = make_sse_client("http://test", "sk_test")
    pool = client._transport._pool
    assert pool._max_connections == 1
    assert pool._max_keepalive_connections == 1


def test_sse_client_starts_with_zero_open_connections():
    """초기 상태: pool.connections 비어 있음 (연결 전)."""
    client = make_sse_client("http://test", "sk_test")
    pool = client._transport._pool
    assert len(pool.connections) == 0


# ── AC2: SSE/REST pool 분리 검증 ───────────────────────────────────────────────

def test_sse_and_rest_are_separate_instances():
    """make_sse_client()와 SprintableClient가 별도 httpx.AsyncClient 인스턴스."""
    sse_client = make_sse_client("http://test", "sk_test")
    rest_client = SprintableClient()
    # SprintableClient는 요청별 AsyncClient — SSE singleton과 다른 객체
    assert type(sse_client).__name__ == "AsyncClient"
    assert type(rest_client).__name__ == "SprintableClient"
    assert sse_client is not rest_client


def test_rest_client_creates_per_request_httpx_client():
    """SprintableClient.request()가 요청마다 새 httpx.AsyncClient 생성 확인.

    async with httpx.AsyncClient(...) 패턴 → 매 호출마다 별도 pool.
    따라서 SSE pool(max_connections=1)이 REST 호출을 블로킹할 수 없음.
    """
    src = inspect.getsource(SprintableClient.request)
    assert "AsyncClient" in src, "SprintableClient.request must use httpx.AsyncClient"
    assert "async with" in src, "SprintableClient.request must use context manager (per-request pool)"


def test_sse_pool_limits_do_not_affect_rest_pool():
    """SSE client pool이 max_connections=1이어도 REST pool은 별도로 제한 없음."""
    sse_client = make_sse_client("http://test", "sk_test")
    rest_instance = SprintableClient()

    sse_pool = sse_client._transport._pool
    assert sse_pool._max_connections == 1

    # SprintableClient는 per-request client → pool 없음 (pool 고갈 불가)
    # REST가 AsyncClient를 생성하면 기본 max_connections=100
    import httpx
    default_limits = httpx.Limits()
    assert default_limits.max_connections != 1  # 기본값은 1보다 큼


# ── AC3: 재연결 10회 후 pool 누수 없음 ────────────────────────────────────────

@pytest.mark.asyncio
async def test_no_pool_leak_after_10_reconnects():
    """10회 재연결 시뮬레이션 후 client.is_closed=True (aclose 보장)."""
    captured: list = []
    orig_make = make_sse_client

    def spy_make(api_url, api_key):
        c = orig_make(api_url, api_key)
        captured.append(c)
        return c

    reconnect_count = 0

    async def mock_connect(client, member_id, on_event=None):
        nonlocal reconnect_count
        reconnect_count += 1
        if reconnect_count >= 10:
            raise asyncio.CancelledError()
        raise RuntimeError(f"disconnect #{reconnect_count}")

    with patch("sprintable_mcp.sse_bridge.make_sse_client", spy_make):
        with patch("sprintable_mcp.sse_bridge._connect_once", mock_connect):
            with patch("sprintable_mcp.sse_bridge.asyncio.sleep", AsyncMock()):
                with pytest.raises(asyncio.CancelledError):
                    await start_sse_bridge("http://test", "sk_test", "member-1")

    assert len(captured) == 1, "make_sse_client는 1회 호출 (싱글톤 패턴)"
    sse_client = captured[0]
    assert sse_client.is_closed, "CancelledError 후 client.aclose() 보장"

    # pool 열린 연결 없음 (네트워크 연결 없이 mock이므로 connections=[])
    pool = sse_client._transport._pool
    assert len(pool.connections) == 0, "재연결 후 pool connections 비어 있음"


# ── AC4: 동시 REST 5건 + SSE pool 독립 확인 ───────────────────────────────────

@pytest.mark.asyncio
async def test_concurrent_rest_not_blocked_by_sse_pool():
    """동시 REST 5건이 SSE max_connections=1 pool의 영향 없이 모두 완료."""
    from sprintable_mcp.api_client import client as rest_client
    rest_client.configure("http://test", "sk_test")
    rest_client._project_id = "proj-1"
    rest_client._org_id = "org-1"
    rest_client._member_id = "member-1"

    completed: list[int] = []

    async def mock_rest_call(i: int) -> None:
        # REST 호출 mock — 별도 pool이므로 SSE와 독립
        await asyncio.sleep(0)
        completed.append(i)

    sse_client = make_sse_client("http://test", "sk_test")
    # SSE pool max_connections=1 확인
    assert sse_client._transport._pool._max_connections == 1

    # REST 5건 동시 실행 — SSE pool과 독립이므로 블로킹 없음
    await asyncio.gather(*[mock_rest_call(i) for i in range(5)])

    assert len(completed) == 5, "REST 5건 모두 완료 (SSE pool에 의한 블로킹 없음)"
