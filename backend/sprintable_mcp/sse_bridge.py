"""SSE 브릿지 — /api/v2/events/stream httpx long-lived stream 연결.

REST용 SprintableClient와 완전히 분리된 SSE 전용 httpx.AsyncClient 사용.
파싱(S5-2), relay(S5-3), backoff 상세(S5-5)는 후속 스토리에서 확장.
"""
from __future__ import annotations

import asyncio
import sys
from typing import Any, Callable

import httpx

SseBridgeEventHandler = Callable[[str, Any], None]

_BASE_DELAY = 1.0
_MAX_DELAY = 10.0


def _log(msg: str) -> None:
    sys.stderr.write(f"[sse-bridge] {msg}\n")
    sys.stderr.flush()


def make_sse_client(api_url: str, api_key: str) -> httpx.AsyncClient:
    """SSE 전용 httpx.AsyncClient 생성.

    REST SprintableClient와 connection pool 완전 분리.
    max_connections=1: SSE는 단일 장기 연결 전용.
    """
    return httpx.AsyncClient(
        base_url=api_url.rstrip("/"),
        headers={
            "Authorization": f"Bearer {api_key}",
            "x-agent-api-key": api_key,
        },
        limits=httpx.Limits(max_connections=1, max_keepalive_connections=1),
        timeout=httpx.Timeout(connect=10.0, read=None, write=None, pool=None),
    )


async def _connect_once(
    client: httpx.AsyncClient,
    member_id: str,
    on_event: SseBridgeEventHandler | None = None,
) -> None:
    """SSE 스트림에 한 번 연결해서 이벤트 수신. 스트림 종료 시 반환."""
    async with client.stream(
        "GET",
        "/api/v2/events/stream",
        params={"member_id": member_id},
        headers={"Accept": "text/event-stream", "Cache-Control": "no-cache"},
    ) as response:
        if response.status_code != 200:
            raise RuntimeError(f"SSE connect failed: HTTP {response.status_code}")

        _log("connected")

        event_type = "message"
        data_lines: list[str] = []

        async for raw_line in response.aiter_lines():
            line = raw_line.rstrip()
            if line.startswith("event:"):
                event_type = line[6:].strip()
            elif line.startswith("data:"):
                data_lines.append(line[5:].strip())
            elif line == "":
                if data_lines:
                    data_str = "\n".join(data_lines)
                    if event_type != "heartbeat":
                        _log(f"event={event_type} data={data_str[:200]}")
                        if on_event is not None:
                            on_event(event_type, data_str)
                    event_type = "message"
                    data_lines = []

        _log("stream ended")


async def start_sse_bridge(
    api_url: str,
    api_key: str,
    member_id: str,
    on_event: SseBridgeEventHandler | None = None,
) -> None:
    """SSE 브릿지 시작. 연결 실패 시 에러 로그 + 재연결 루프 진입.

    MCP stdio 서버와 동일한 이벤트 루프에서 asyncio.create_task()로 실행.
    """
    _log(f"starting bridge for member_id={member_id}")
    client = make_sse_client(api_url, api_key)
    attempt = 0
    try:
        while True:
            try:
                await _connect_once(client, member_id, on_event)
                attempt = 0
            except Exception as exc:
                _log(f"error: {exc}")
            attempt += 1
            wait = min(_BASE_DELAY * 2 ** (attempt - 1), _MAX_DELAY)
            _log(f"reconnecting in {wait:.1f}s (attempt {attempt})")
            await asyncio.sleep(wait)
    finally:
        await client.aclose()
