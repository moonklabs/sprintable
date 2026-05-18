"""SSE 브릿지 — /api/v2/events/stream httpx long-lived stream 연결.

REST용 SprintableClient와 완전히 분리된 SSE 전용 httpx.AsyncClient 사용.
relay(S5-3), backoff 상세(S5-5)는 후속 스토리에서 확장.
"""
from __future__ import annotations

import asyncio
import sys
from dataclasses import dataclass, field
from typing import Any, Callable

import httpx

SseBridgeEventHandler = Callable[[str, Any], None]

_BASE_DELAY = 1.0
_MAX_DELAY = 10.0


def _log(msg: str) -> None:
    sys.stderr.write(f"[sse-bridge] {msg}\n")
    sys.stderr.flush()


# ── SSE Parser ─────────────────────────────────────────────────────────────────

@dataclass
class SseEvent:
    event_type: str = "message"
    data: str = ""
    last_event_id: str = ""


class SseParser:
    """RFC 8895 SSE 라인 파서.

    `feed(line)` 한 라인씩 공급. 이벤트 완성(blank line) 시 SseEvent 반환.
    `last_event_id`는 연결 재시도 시 dedup에 사용 (S5-5).
    """

    def __init__(self) -> None:
        self._event_type = "message"
        self._data_lines: list[str] = []
        self._last_event_id = ""

    @property
    def last_event_id(self) -> str:
        return self._last_event_id

    def feed(self, line: str) -> SseEvent | None:
        """한 라인 처리. 이벤트 완성 시 SseEvent 반환, 미완성이면 None."""
        line = line.rstrip("\r\n")

        # `:` prefix — heartbeat/comment, skip
        if line.startswith(":"):
            return None

        # blank line — dispatch
        if line == "":
            if self._data_lines:
                event = SseEvent(
                    event_type=self._event_type,
                    data="\n".join(self._data_lines),
                    last_event_id=self._last_event_id,
                )
                self._event_type = "message"
                self._data_lines = []
                return event
            return None

        # field: value
        if ":" in line:
            field_name, _, value = line.partition(":")
            if value.startswith(" "):
                value = value[1:]  # SSE spec: strip exactly one leading space
        else:
            field_name, value = line, ""

        if field_name == "event":
            self._event_type = value
        elif field_name == "data":
            self._data_lines.append(value)
        elif field_name == "id":
            self._last_event_id = value
        # unknown field — ignore per spec

        return None


# ── httpx SSE client ───────────────────────────────────────────────────────────

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

        parser = SseParser()
        async for raw_line in response.aiter_lines():
            event = parser.feed(raw_line)
            if event is not None:
                if event.event_type != "heartbeat":
                    _log(f"event={event.event_type} data={event.data[:200]}")
                    if on_event is not None:
                        on_event(event.event_type, event.data)

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
