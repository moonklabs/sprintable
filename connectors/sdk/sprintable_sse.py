"""Sprintable Gateway SSE Reference SDK — Python.

공통부: SSE 소비 · 파서 · dedup · ack(contiguous, min-1 앵커링) · backoff 재연결.
어댑터는 `on_message` 콜백(주입부)만 구현하면 된다.

Usage:
    from sprintable_sse import SprintableSSEClient, MessageContext

    async def inject(ctx: MessageContext) -> None:
        # runtime-specific turn injection
        response = await my_agent.handle(ctx.content)
        await ctx.reply(response)

    client = SprintableSSEClient(
        api_url="https://sprintable-backend-dev-57iommnikq-du.a.run.app",
        api_key="sk_live_...",
    )
    await client.run(inject)   # blocks forever, auto-reconnects
"""
from __future__ import annotations

import asyncio
import json
import logging
import time
import uuid
from dataclasses import dataclass, field
from typing import Any, Awaitable, Callable

try:
    import httpx
    HTTPX_AVAILABLE = True
except ImportError:
    HTTPX_AVAILABLE = False  # type: ignore[assignment]

logger = logging.getLogger(__name__)

DEFAULT_API_URL = "https://sprintable-backend-dev-57iommnikq-du.a.run.app"
RECONNECT_BACKOFF = [2, 5, 10, 30, 60]
STREAM_READ_TIMEOUT = 90
DEDUP_MAX_SIZE = 1000
DEDUP_TTL_SECONDS = 300.0

# ── E-EVENT-INJECT S2: 주입 허용 event_type (중앙 상수, recommended ONLY) ──────────
# 이 목록 밖의 event_type은 content가 실려있어도 work-turn으로 주입하지 않고 드롭한다
# (FYI poisoning 방지: status_changed/task_completed/agent_joined/sprint_closed/file_conflict 등).
# 워크플로 트리거(kickoff/review_request/qa_request/deploy_request/handoff)는 현재 백엔드가
# dispatched 이벤트로 전달하나, 향후 직접 event_type emit 대비해 명시 포함.
# ⚠️ 단일 출처 — hermes adapter.py가 이 상수를 import해서 사용(분기 중복 금지).
INJECTABLE_EVENT_TYPES = frozenset({
    "dispatched",
    "story_assigned",
    "conversation.message_created",
    "conversation:mention",
    "kickoff",
    "review_request",
    "qa_request",
    "deploy_request",
    "handoff",
})


# ── Public types ─────────────────────────────────────────────────────────────

@dataclass
class MessageImage:
    url: str
    name: str = ""
    mime: str = ""


@dataclass
class MessageContext:
    """어댑터 `on_message` 콜백에 전달되는 메시지 컨텍스트."""
    content: str
    conversation_id: str
    sender_id: str
    sender_name: str
    event_id: str
    seq: int
    is_backfill: bool
    images: list[MessageImage]
    raw: dict[str, Any]

    # reply() 지원을 위해 내부 주입
    _reply_url: str = field(default="", repr=False)
    _api_key: str = field(default="", repr=False)
    _http: Any = field(default=None, repr=False)

    async def reply(self, text: str) -> None:
        """POST /api/v2/conversations/{id}/messages."""
        if not self._reply_url or not self._http:
            raise RuntimeError("reply_url not available")
        resp = await self._http.post(
            self._reply_url,
            headers={"Authorization": f"Bearer {self._api_key}", "x-agent-api-key": self._api_key},
            json={"content": text},
            timeout=15.0,
        )
        resp.raise_for_status()


MessageHandler = Callable[[MessageContext], Awaitable[None]]


def _normalize_images(value: Any) -> list[MessageImage]:
    if not isinstance(value, list):
        return []
    images: list[MessageImage] = []
    for item in value:
        if not isinstance(item, dict):
            continue
        url = str(item.get("url") or "").strip()
        if not url:
            continue
        mime = str(item.get("mime") or item.get("mime_type") or "").strip()
        if mime and not mime.startswith("image/"):
            continue
        images.append(MessageImage(
            url=url,
            name=str(item.get("name") or ""),
            mime=mime,
        ))
    return images


# ── SDK client ────────────────────────────────────────────────────────────────

class SprintableSSEClient:
    """Sprintable Gateway SSE dial-out 클라이언트.

    `run(on_message)` 한 번 호출로 SSE 스트림 소비 + ack 처리 + 재연결을 담당.
    어댑터는 `on_message(MessageContext)` 콜백만 구현.
    """

    def __init__(self, api_url: str = DEFAULT_API_URL, api_key: str = "") -> None:
        if not HTTPX_AVAILABLE:
            raise ImportError("httpx is required: pip install httpx")
        self._api_url = api_url.rstrip("/")
        self._api_key = api_key
        self._http: httpx.AsyncClient | None = None
        self._last_event_id = ""
        self._last_acked = 0
        self._seen: dict[str, float] = {}

    def _auth(self) -> dict[str, str]:
        return {"Authorization": f"Bearer {self._api_key}", "x-agent-api-key": self._api_key}

    def _is_dup(self, event_id: str) -> bool:
        now = time.time()
        if len(self._seen) > DEDUP_MAX_SIZE:
            self._seen = {k: v for k, v in self._seen.items() if v > now - DEDUP_TTL_SECONDS}
        if event_id in self._seen:
            return True
        self._seen[event_id] = now
        return False

    async def _ack(self, seq: int) -> None:
        """contiguous-ack: seq <= _last_acked 이면 skip."""
        if seq <= self._last_acked or not self._http:
            return
        try:
            await self._http.post(
                f"{self._api_url}/api/v2/agent/events/ack",
                headers=self._auth(), json={"seq": seq}, timeout=10.0,
            )
            self._last_acked = seq
            logger.debug("ack seq=%d", seq)
        except Exception as exc:
            logger.warning("ack error seq=%d: %s", seq, exc)

    async def _parse_event(self, ev_type: str, ev_id: str, data_str: str) -> MessageContext | None:
        """SSE 이벤트 → MessageContext. heartbeat / no-content 는 None."""
        if ev_type == "heartbeat":
            return None
        try:
            data: dict[str, Any] = json.loads(data_str)
        except json.JSONDecodeError:
            return None

        payload = data.get("payload") or {}
        if isinstance(payload, str):
            payload = {}
        # E-EVENT-INJECT S2: recommended ONLY allow-list (content 체크 전). FYI 등은 드롭.
        event_type = data.get("event_type") or payload.get("event_type")
        if event_type not in INJECTABLE_EVENT_TYPES:
            return None
        content = (data.get("content") or payload.get("content") or "").strip()
        images = _normalize_images(data.get("images") or payload.get("images"))
        if not content and not images:
            return None

        event_id = str(data.get("event_id") or payload.get("id") or ev_id or uuid.uuid4())
        if self._is_dup(event_id):
            return None
        if ev_id:
            self._last_event_id = ev_id

        # seq: data 최상위 → payload fallback
        seq = 0
        for cand in (data.get("recipient_seq"), payload.get("recipient_seq")):
            try:
                n = int(cand)  # type: ignore[arg-type]
                if n > 0:
                    seq = n
                    break
            except (TypeError, ValueError):
                pass

        conversation_id = str(
            payload.get("conversation_id") or payload.get("thread_id")
            or data.get("conversation_id") or ""
        )
        sender = payload.get("sender") or {}
        if isinstance(sender, str):
            sender = {}
        sender_id = str(sender.get("id") or data.get("sender_id") or "sprintable")
        sender_name = str(sender.get("name") or sender_id)
        is_backfill = bool(data.get("is_backfill"))

        reply_url = (
            f"{self._api_url}/api/v2/conversations/{conversation_id}/messages"
            if conversation_id else ""
        )

        return MessageContext(
            content=content,
            conversation_id=conversation_id,
            sender_id=sender_id,
            sender_name=sender_name,
            event_id=event_id,
            seq=seq,
            is_backfill=is_backfill,
            images=images,
            raw=data,
            _reply_url=reply_url,
            _api_key=self._api_key,
            _http=self._http,
        )

    async def _consume(self, on_message: MessageHandler) -> None:
        assert self._http is not None
        headers = {**self._auth(), "Accept": "text/event-stream", "Cache-Control": "no-cache"}
        if self._last_event_id:
            headers["Last-Event-ID"] = self._last_event_id

        ev_type, ev_id, data_lines = "message", "", []
        async with self._http.stream(
            "GET", f"{self._api_url}/api/v2/agent/stream", headers=headers,
            timeout=httpx.Timeout(connect=15.0, read=STREAM_READ_TIMEOUT, write=15.0, pool=15.0),
        ) as resp:
            resp.raise_for_status()
            logger.info("stream open")
            async for raw in resp.aiter_lines():
                line = raw.rstrip("\n")
                if line == "":
                    if data_lines:
                        ctx = await self._parse_event(ev_type, ev_id, "\n".join(data_lines))
                        if ctx is not None:
                            logger.info("inbound seq=%d conv=%s: %s",
                                        ctx.seq, ctx.conversation_id, ctx.content[:80])
                            await on_message(ctx)
                            if ctx.seq:
                                await self._ack(ctx.seq)
                    ev_type, ev_id, data_lines = "message", "", []
                elif line.startswith(":"):
                    pass
                elif line.startswith("event:"):
                    ev_type = line[6:].strip()
                elif line.startswith("id:"):
                    ev_id = line[3:].strip()
                elif line.startswith("data:"):
                    v = line[5:]
                    data_lines.append(v[1:] if v.startswith(" ") else v)
        logger.info("stream closed")

    async def run(self, on_message: MessageHandler) -> None:
        """SSE 스트림 소비 + ack + backoff 재연결. 무한 루프."""
        self._http = httpx.AsyncClient(timeout=None)
        backoff_idx = 0
        try:
            while True:
                t0 = time.monotonic()
                try:
                    await self._consume(on_message)
                except asyncio.CancelledError:
                    return
                except Exception as exc:
                    logger.warning("stream error: %s", exc)
                if time.monotonic() - t0 >= 60.0:
                    backoff_idx = 0
                delay = RECONNECT_BACKOFF[min(backoff_idx, len(RECONNECT_BACKOFF) - 1)]
                logger.info("reconnecting in %ds", delay)
                await asyncio.sleep(delay)
                backoff_idx += 1
        finally:
            await self._http.aclose()
            self._http = None
