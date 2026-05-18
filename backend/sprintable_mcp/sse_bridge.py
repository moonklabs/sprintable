"""SSE 브릿지 — /api/v2/events/stream httpx long-lived stream 연결.

REST용 SprintableClient와 완전히 분리된 SSE 전용 httpx.AsyncClient 사용.
backoff 상세(S5-5)는 후속 스토리에서 확장.
"""
from __future__ import annotations

import asyncio
import json
import sys
import time
from dataclasses import dataclass
from random import randint
from typing import TYPE_CHECKING, Any, Callable

import httpx

from .config import settings

if TYPE_CHECKING:
    from mcp.server.session import ServerSession

SseBridgeEventHandler = Callable[[str, Any], None]

_BASE_DELAY = 1.0
_MAX_DELAY = 10.0

# relay 대상 이벤트 타입
_RELAY_EVENT_TYPES = frozenset(["conversation:message", "conversation:mention"])


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
    """SSE 이벤트를 MCP log notification으로 클라이언트에 전송.

    세션 미등록 또는 에러 시 조용히 skip — MCP 도구 호출에 영향 없음.
    """
    if _active_session is None:
        return
    try:
        await _active_session.send_log_message(
            level="info",
            data={"event_type": event_type, "data": data_str},
            logger="sprintable.sse",
        )
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


# ── fakechat relay ─────────────────────────────────────────────────────────────

def _build_relay_payload(event_type: str, data: object) -> tuple[str, str, bool]:
    """SSE data에서 (text, thread_id, is_conversation_event) 추출."""
    if not isinstance(data, dict):
        return f"[{event_type}] {data}", "", False

    d: dict = data
    payload: dict = d.get("payload") if isinstance(d.get("payload"), dict) else d  # type: ignore[assignment]

    sender_raw = payload.get("sender") or d.get("sender_name") or d.get("member_name") or ""
    if isinstance(sender_raw, dict):
        sender_name = str(sender_raw.get("name", ""))
    else:
        sender_name = str(sender_raw)

    content = (
        payload.get("content")
        or d.get("content")
        or d.get("message")
        or d.get("text")
        or json.dumps(data, ensure_ascii=False)
    )

    text = f"[{event_type}] {sender_name}: {content}" if sender_name else f"[{event_type}] {content}"

    conversation_id = str(payload.get("conversation_id") or d.get("conversation_id") or "")
    thread_id = str(payload.get("thread_id") or d.get("thread_id") or conversation_id)
    is_conversation_event = bool(conversation_id) and not (
        payload.get("thread_id") or d.get("thread_id")
    )

    return text, thread_id, is_conversation_event


async def relay_to_fakechat(
    event_type: str,
    data_str: str,
    api_url: str,
    api_key: str,
    fakechat_port: int,
) -> None:
    """SSE 이벤트 → fakechat /upload POST.

    relay 대상: conversation:message, conversation:mention.
    비대상 이벤트 및 모든 에러는 조용히 skip — MCP 동작에 영향 없음 (AC4).
    """
    if event_type not in _RELAY_EVENT_TYPES:
        return

    uid = f"sse-{int(time.time() * 1000)}-{randint(0, 999999):06d}"

    try:
        parsed: Any = json.loads(data_str)
    except json.JSONDecodeError:
        parsed = data_str

    text, thread_id, is_conversation_event = _build_relay_payload(event_type, parsed)

    form: dict[str, str] = {"id": uid, "text": text}

    if thread_id:
        base_url = api_url.rstrip("/")
        form["thread_id"] = thread_id
        if base_url and api_key:
            callback_path = (
                f"/api/v2/conversations/{thread_id}/messages"
                if is_conversation_event
                else f"/api/v2/chats/{thread_id}/messages"
            )
            form["reply_callback_url"] = f"{base_url}{callback_path}"
            form["reply_callback_api_key"] = api_key

    try:
        async with httpx.AsyncClient(timeout=5.0) as client:
            resp = await client.post(
                f"http://127.0.0.1:{fakechat_port}/upload",
                data=form,
            )
            resp.raise_for_status()
    except Exception as exc:
        _log(f"relay error: {exc}")


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
    수신 이벤트는 fakechat relay + MCP notification + on_event 콜백으로 전달.
    """
    _log(f"starting bridge for member_id={member_id}")
    client = make_sse_client(api_url, api_key)
    port = settings.fakechat_port

    def _relay_and_dispatch(event_type: str, data: Any) -> None:
        asyncio.create_task(
            relay_to_fakechat(event_type, str(data), api_url, api_key, port)
        )
        asyncio.create_task(
            _send_mcp_notification(event_type, str(data))
        )
        if on_event is not None:
            on_event(event_type, data)

    attempt = 0
    try:
        while True:
            try:
                await _connect_once(client, member_id, _relay_and_dispatch)
                attempt = 0
            except Exception as exc:
                _log(f"error: {exc}")
            attempt += 1
            wait = min(_BASE_DELAY * 2 ** (attempt - 1), _MAX_DELAY)
            _log(f"reconnecting in {wait:.1f}s (attempt {attempt})")
            await asyncio.sleep(wait)
    finally:
        await client.aclose()
