"""SSE 브릿지 — /api/v2/events/stream httpx long-lived stream 연결.

REST용 SprintableClient와 완전히 분리된 SSE 전용 httpx.AsyncClient 사용.
"""
from __future__ import annotations

import asyncio
import json
import sys
import time
from collections import OrderedDict
from dataclasses import dataclass
from datetime import datetime, timezone
from random import uniform
from typing import TYPE_CHECKING, Any, Callable

import httpx
from mcp.shared.session import ServerMessageMetadata, SessionMessage
from mcp.types import JSONRPCMessage, JSONRPCNotification

from .config import settings

if TYPE_CHECKING:
    from mcp.server.session import ServerSession

SseBridgeEventHandler = Callable[[str, Any], None]
_SseInternalHandler = Callable[["SseEvent"], None]

_BASE_DELAY = 1.0
_MAX_DELAY = 10.0
_JITTER_FACTOR = 0.5    # wait * uniform(0, 0.5) jitter

# ── SeenIdsCache: LRU + TTL dedup 캐시 (S6-2) ────────────────────────────────

class SeenIdsCache:
    """LRU + TTL 기반 SSE dedup 캐시.

    - max_size 초과: LRU eviction (가장 오래 미사용 항목 제거)
    - TTL 만료: __contains__ 접근 시 lazy 제거 + add() 시 배치 정리
    - eviction 발동 시 DEBUG 로그 출력
    """

    def __init__(self, max_size: int, ttl_seconds: float) -> None:
        self._max_size = max_size
        self._ttl = ttl_seconds
        self._store: OrderedDict[str, float] = OrderedDict()

    def __contains__(self, event_id: str) -> bool:
        if event_id not in self._store:
            return False
        added_at = self._store[event_id]
        if time.monotonic() - added_at > self._ttl:
            del self._store[event_id]
            _log(f"[debug] ttl-evict event_id={event_id}")
            return False
        self._store.move_to_end(event_id)
        return True

    def add(self, event_id: str) -> None:
        """event_id 추가. 이미 존재하면 LRU 갱신."""
        if event_id in self._store:
            self._store.move_to_end(event_id)
            return
        self._evict_expired()
        self._store[event_id] = time.monotonic()
        while len(self._store) > self._max_size:
            oldest_id, _ = self._store.popitem(last=False)
            _log(f"[debug] lru-evict max_size={self._max_size} event_id={oldest_id}")

    def _evict_expired(self) -> None:
        now = time.monotonic()
        expired = [k for k, v in self._store.items() if now - v > self._ttl]
        for k in expired:
            del self._store[k]
        if expired:
            _log(f"[debug] ttl-batch-evict count={len(expired)}")

    def __len__(self) -> int:
        return len(self._store)


def _log(msg: str) -> None:
    sys.stderr.write(f"[sse-bridge] {msg}\n")
    sys.stderr.flush()


# ── MCP Session Registry ───────────────────────────────────────────────────────

_active_session: ServerSession | None = None


def register_session(session: ServerSession) -> None:
    """활성 MCP ServerSession 등록. __main__.py _handle_message 패치에서 호출."""
    global _active_session
    _active_session = session


async def _send_mcp_notification(event_type: str, data_str: str) -> None:
    """SSE 이벤트를 notifications/claude/channel 로 Claude Code 세션에 전송.

    send_log_message는 MCP logging spec이라 Claude Code가 대화 입력으로 인식 안 함 (오스카군 실검증).
    JSONRPCNotification을 _write_stream에 직접 write하여 fakechat TS SDK와 동일 경로로 전송.
    세션 미등록 또는 에러 시 조용히 skip — MCP 도구 호출에 영향 없음.
    """
    if _active_session is None:
        return
    try:
        # data_str 파싱으로 meta 필드 구성
        try:
            payload = json.loads(data_str) if data_str else {}
        except (json.JSONDecodeError, TypeError):
            payload = {}

        event_id = payload.get("event_id") or payload.get("id") or ""
        conversation_id = payload.get("conversation_id") or payload.get("source_entity_id") or ""
        ts = datetime.now(timezone.utc).isoformat()

        meta: dict[str, Any] = {
            "chat_id": "web",
            "message_id": str(event_id) if event_id else "",
            "user": "web",
            "ts": ts,
        }
        if conversation_id:
            meta["thread_id"] = str(conversation_id)

        # content: 이벤트 타입 + 주요 필드 요약 (Claude Code 채널 입력으로 인식되는 텍스트)
        content = data_str or f"(event_type={event_type})"

        notification = JSONRPCNotification(
            jsonrpc="2.0",
            method="notifications/claude/channel",
            params={"content": content, "meta": meta},
        )
        session_message = SessionMessage(
            message=JSONRPCMessage(notification),
            metadata=None,
        )
        await _active_session._write_stream.send(session_message)
    except Exception as exc:
        _log(f"notification error: {exc}")


# ── SSE Parser ─────────────────────────────────────────────────────────────────

@dataclass
class SseEvent:
    event_type: str = "message"
    data: str = ""
    last_event_id: str = ""


class SseParser:
    """RFC 8895 SSE 라인 파서.

    `feed(line)` 한 라인씩 공급. 이벤트 완성(blank line) 시 SseEvent 반환.
    `last_event_id`는 reconnect dedup(S5-5)에 사용.
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
    last_event_id: str = "",
    on_event: _SseInternalHandler | None = None,
) -> None:
    """SSE 스트림에 한 번 연결해서 이벤트 수신. 스트림 종료 시 반환.

    `async with client.stream(...)` context manager가 response.aclose() 보장.
    last_event_id 전달 시 서버가 해당 이벤트 이후 backfill만 반환.
    """
    params: dict[str, str] = {"member_id": member_id}
    if last_event_id:
        params["last_event_id"] = last_event_id

    async with client.stream(
        "GET",
        "/api/v2/events/stream",
        params=params,
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
                        on_event(event)  # SseEvent 전체 전달 → dedup/relay/notify

        _log("stream ended")


async def start_sse_bridge(
    api_url: str,
    api_key: str,
    member_id: str,
    on_event: SseBridgeEventHandler | None = None,
) -> None:
    """SSE 브릿지 시작. 연결 실패 시 에러 로그 + jitter exponential backoff 재연결.

    - backoff: BASE * 2^attempt (max MAX_DELAY) + uniform(0, wait * JITTER_FACTOR)
    - dedup: SeenIdsCache (LRU + TTL) 기반 중복 skip
    - MCP stdio 서버와 동일 이벤트 루프에서 asyncio.create_task()로 실행
    - graceful shutdown: CancelledError → finally: client.aclose()
    """
    _log(f"starting bridge for member_id={member_id}")
    client = make_sse_client(api_url, api_key)

    # S6-2: LRU + TTL dedup 캐시 (환경변수 기반 설정)
    seen_ids = SeenIdsCache(
        max_size=settings.sse_seen_ids_max_size,
        ttl_seconds=settings.sse_seen_ids_ttl_seconds,
    )
    # S6-1: 마지막 수신 event_id — 재연결 시 backfill 기준점으로 전달
    _current_last_event_id: str = ""

    def _handle(event: SseEvent) -> None:
        nonlocal _current_last_event_id
        # id: 필드 우선 dedup
        if event.last_event_id:
            if event.last_event_id in seen_ids:
                _log(f"dedup: skip event_id={event.last_event_id}")
                return
            seen_ids.add(event.last_event_id)
            _current_last_event_id = event.last_event_id
        else:
            # id: 필드 없을 때 data.event_id fallback dedup — 백필/live id 불일치 방어
            try:
                _data_eid = json.loads(event.data).get("event_id") if event.data else None
                if _data_eid:
                    if _data_eid in seen_ids:
                        _log(f"dedup(data): skip event_id={_data_eid}")
                        return
                    seen_ids.add(_data_eid)
            except (json.JSONDecodeError, AttributeError):
                pass

        # MCP notification: webhook 유무·backfill 여부 무관하게 항상 발송 (AC-4)
        asyncio.create_task(
            _send_mcp_notification(event.event_type, event.data)
        )

        if on_event is not None:
            on_event(event.event_type, event.data)

    attempt = 0
    try:
        while True:
            try:
                await _connect_once(client, member_id, _current_last_event_id, _handle)
                attempt = 0
            except Exception as exc:
                _log(f"error: {exc}")
            attempt += 1
            base_wait = min(_BASE_DELAY * 2 ** (attempt - 1), _MAX_DELAY)
            wait = base_wait + uniform(0, base_wait * _JITTER_FACTOR)
            _log(f"reconnecting in {wait:.2f}s (attempt {attempt})")
            await asyncio.sleep(wait)
    finally:
        await client.aclose()
