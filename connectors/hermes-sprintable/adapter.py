"""Sprintable platform adapter (Hermes plugin).

Dial-out last-mile injection adapter for the Sprintable Agent Gateway.
Holds a long-lived OUTBOUND SSE connection to ``GET /api/v2/agent/stream``
(no inbound domain / tunnel required), injects each delivered platform
message into the running hermes session as a new turn via
``handle_message()``, and posts the agent's reply back to the Sprintable
Conversations API. Acks each consumed event so the server cursor advances
and reconnects do not re-flood backfill.

Mirrors the ntfy plugin's HTTP-streaming pattern; the only differences are
SSE framing (event:/id:/data:) and the ack POST.

Config (env wins over config.yaml ``extra``):
    SPRINTABLE_API_URL   Backend base URL (default: dev backend)
    AGENT_API_KEY        Agent API key (Bearer) — required
"""

import asyncio
import json
import logging
import os
import time
import uuid
from datetime import datetime, timezone
from typing import Any, Dict, Optional

try:
    import httpx
    HTTPX_AVAILABLE = True
except ImportError:
    HTTPX_AVAILABLE = False
    httpx = None  # type: ignore[assignment]

# E-EVENT-INJECT S2: 주입 allow-list는 SDK(connectors/sdk/sprintable_sse.py)가 단일 출처.
# hermes 런타임 path에 sdk가 없으면 sibling 디렉터리를 추가해 import (분기 중복 금지).
try:
    from sprintable_sse import INJECTABLE_EVENT_TYPES
except ImportError:
    import sys
    sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "sdk"))
    from sprintable_sse import INJECTABLE_EVENT_TYPES

from gateway.config import Platform, PlatformConfig
from gateway.platforms.base import (
    BasePlatformAdapter,
    MessageEvent,
    MessageType,
    SendResult,
)

logger = logging.getLogger(__name__)

DEFAULT_API_URL = "https://sprintable-backend-dev-57iommnikq-du.a.run.app"
RECONNECT_BACKOFF = [2, 5, 10, 30, 60]
STREAM_READ_TIMEOUT = 90  # gateway heartbeats keep the stream alive
DEDUP_MAX_SIZE = 1000


def _api_url() -> str:
    return (os.getenv("SPRINTABLE_API_URL", DEFAULT_API_URL) or DEFAULT_API_URL).rstrip("/")


def check_requirements() -> bool:
    if not HTTPX_AVAILABLE:
        return False
    return bool(os.getenv("AGENT_API_KEY", "").strip())


def validate_config(config) -> bool:
    extra = getattr(config, "extra", {}) or {}
    return bool(extra.get("api_key") or os.getenv("AGENT_API_KEY", "").strip())


def is_connected(config) -> bool:
    extra = getattr(config, "extra", {}) or {}
    return bool(extra.get("api_key") or os.getenv("AGENT_API_KEY", "").strip())


class SprintableAdapter(BasePlatformAdapter):
    """Sprintable Agent Gateway dial-out adapter."""

    def __init__(self, config: PlatformConfig):
        platform = Platform("sprintable")
        super().__init__(config=config, platform=platform)

        extra = config.extra or {}
        self._api_url: str = (extra.get("api_url") or _api_url()).rstrip("/")
        self._api_key: str = extra.get("api_key") or os.getenv("AGENT_API_KEY", "")

        self._stream_task: Optional[asyncio.Task] = None
        self._http_client: Optional["httpx.AsyncClient"] = None
        self._last_event_id: str = ""       # SSE Last-Event-ID for reconnect
        self._last_acked: int = 0           # highest seq acked
        self._seen: Dict[str, float] = {}   # event_id -> ts (dedup)

    # -- lifecycle ----------------------------------------------------------

    async def connect(self) -> bool:
        if not HTTPX_AVAILABLE:
            logger.warning("[%s] httpx not installed", self.name)
            return False
        if not self._api_key:
            logger.warning("[%s] AGENT_API_KEY not configured", self.name)
            return False
        try:
            self._http_client = httpx.AsyncClient(timeout=None)
            self._stream_task = asyncio.create_task(self._run_stream())
            self._mark_connected()
            logger.info("[%s] Connected — dial-out to %s/api/v2/agent/stream", self.name, self._api_url)
            return True
        except Exception as e:
            logger.error("[%s] connect failed: %s", self.name, e)
            return False

    async def disconnect(self) -> None:
        self._running = False
        self._mark_disconnected()
        if self._stream_task:
            self._stream_task.cancel()
            try:
                await self._stream_task
            except asyncio.CancelledError:
                pass
            self._stream_task = None
        if self._http_client:
            await self._http_client.aclose()
            self._http_client = None
        logger.info("[%s] Disconnected", self.name)

    # -- inbound stream -----------------------------------------------------

    def _auth_headers(self) -> Dict[str, str]:
        return {"Authorization": f"Bearer {self._api_key}", "x-agent-api-key": self._api_key}

    async def _run_stream(self) -> None:
        backoff_idx = 0
        url = f"{self._api_url}/api/v2/agent/stream"
        while self._running:
            stream_start = time.monotonic()
            try:
                await self._consume_stream(url)
            except asyncio.CancelledError:
                return
            except Exception as e:
                if not self._running:
                    return
                logger.warning("[%s] stream error: %s", self.name, e)
            if not self._running:
                return
            if time.monotonic() - stream_start >= 60.0:
                backoff_idx = 0
            delay = RECONNECT_BACKOFF[min(backoff_idx, len(RECONNECT_BACKOFF) - 1)]
            logger.info("[%s] reconnecting in %ds", self.name, delay)
            await asyncio.sleep(delay)
            backoff_idx += 1

    async def _consume_stream(self, url: str) -> None:
        headers = {**self._auth_headers(), "Accept": "text/event-stream", "Cache-Control": "no-cache"}
        if self._last_event_id:
            headers["Last-Event-ID"] = self._last_event_id
        ev_type, ev_id, data_lines = "message", "", []
        async with self._http_client.stream(
            "GET", url, headers=headers,
            timeout=httpx.Timeout(connect=15.0, read=STREAM_READ_TIMEOUT, write=15.0, pool=15.0),
        ) as response:
            response.raise_for_status()
            logger.info("[%s] stream open", self.name)
            async for raw in response.aiter_lines():
                if not self._running:
                    return
                line = raw.rstrip("\n")
                if line == "":
                    # dispatch accumulated event
                    if data_lines:
                        await self._on_event(ev_type, ev_id, "\n".join(data_lines))
                    ev_type, ev_id, data_lines = "message", "", []
                    continue
                if line.startswith(":"):
                    continue  # comment
                if line.startswith("event:"):
                    ev_type = line[6:].strip()
                elif line.startswith("id:"):
                    ev_id = line[3:].strip()
                elif line.startswith("data:"):
                    data_lines.append(line[5:].lstrip())

    async def _on_event(self, ev_type: str, ev_id: str, data_str: str) -> None:
        if ev_type == "heartbeat":
            return
        try:
            data = json.loads(data_str)
        except json.JSONDecodeError:
            return
        # event shape: content/conversation_id/sender/recipient_seq are top-level
        # in conversation.message_created; SSE id: = event_id UUID (not the seq).
        payload = data.get("payload") or {}
        # E-EVENT-INJECT S2: recommended ONLY allow-list (content 체크 전). FYI 등은 드롭.
        event_type = data.get("event_type") or payload.get("event_type")
        if event_type not in INJECTABLE_EVENT_TYPES:
            return  # not a recommended inject type (e.g. status_changed FYI)
        content = (data.get("content") or payload.get("content") or "").strip()
        if not content:
            return  # nothing to inject (e.g. dispatched/system event without text)

        event_id = data.get("event_id") or payload.get("id") or ev_id or uuid.uuid4().hex
        if self._is_duplicate(event_id):
            return

        conversation_id = payload.get("conversation_id") or payload.get("thread_id") or data.get("conversation_id") or ev_id
        sender = data.get("sender") or payload.get("sender") or {}  # AC1: data top-level 우선
        sender_id = sender.get("id") or data.get("sender_id") or "sprintable"
        sender_name = sender.get("name") or sender_id

        # seq for ack + reconnect cursor — check SSE id, then several data locations
        seq = 0
        for cand in (ev_id, data.get("recipient_seq"), data.get("seq"), payload.get("recipient_seq")):
            try:
                if cand is not None and str(cand) != "":
                    seq = int(cand)
                    break
            except (ValueError, TypeError):
                continue
        if ev_id:
            self._last_event_id = ev_id

        source = self.build_source(
            chat_id=conversation_id,
            chat_name=payload.get("conversation_title") or "Sprintable",
            chat_type="group",
            user_id=sender_id,
            user_name=sender_name,
        )
        message_event = MessageEvent(
            text=content,
            message_type=MessageType.TEXT,
            source=source,
            message_id=event_id,
            raw_message=data,
            timestamp=datetime.now(tz=timezone.utc),
        )
        logger.info("[%s] inbound seq=%s conv=%s: %s", self.name, seq, conversation_id, content[:80])
        await self.handle_message(message_event)
        if seq:
            await self._send_ack(seq)

    def _is_duplicate(self, event_id: str) -> bool:
        now = time.time()
        if len(self._seen) > DEDUP_MAX_SIZE:
            self._seen = {k: v for k, v in self._seen.items() if v > now - 300}
        if event_id in self._seen:
            return True
        self._seen[event_id] = now
        return False

    async def _send_ack(self, seq: int) -> None:
        if seq <= self._last_acked:
            return
        try:
            await self._http_client.post(
                f"{self._api_url}/api/v2/agent/events/ack",
                headers=self._auth_headers(), json={"seq": seq}, timeout=10.0,
            )
            self._last_acked = seq
            logger.info("[%s] ack seq=%s", self.name, seq)
        except Exception as e:
            logger.warning("[%s] ack error seq=%s: %s", self.name, seq, e)

    # -- outbound (agent reply -> Sprintable) -------------------------------

    async def send(
        self,
        chat_id: str,
        content: str,
        reply_to: Optional[str] = None,
        metadata: Optional[Dict[str, Any]] = None,
    ) -> SendResult:
        if not self._http_client:
            return SendResult(success=False, error="HTTP client not initialized")
        url = f"{self._api_url}/api/v2/conversations/{chat_id}/messages"
        try:
            resp = await self._http_client.post(
                url, headers=self._auth_headers(), json={"content": content}, timeout=15.0,
            )
            if resp.status_code < 300:
                try:
                    mid = (resp.json() or {}).get("id") or uuid.uuid4().hex[:12]
                except Exception:
                    mid = uuid.uuid4().hex[:12]
                return SendResult(success=True, message_id=str(mid))
            return SendResult(success=False, error=f"HTTP {resp.status_code}: {resp.text[:200]}", retryable=resp.status_code >= 500)
        except httpx.TimeoutException:
            return SendResult(success=False, error="timeout posting reply", retryable=True)
        except Exception as e:
            logger.error("[%s] send error: %s", self.name, e)
            return SendResult(success=False, error=str(e))

    async def send_typing(self, chat_id: str, metadata=None) -> None:
        pass

    async def get_chat_info(self, chat_id: str) -> Dict[str, Any]:
        return {"name": chat_id, "type": "group"}


# ---------------------------------------------------------------------------
# Plugin registration
# ---------------------------------------------------------------------------

def _env_enablement() -> dict | None:
    key = os.getenv("AGENT_API_KEY", "").strip()
    if not key:
        return None
    return {"api_url": _api_url(), "api_key": key}


def register(ctx) -> None:
    """Plugin entry point — called by the Hermes plugin system at startup."""
    ctx.register_platform(
        name="sprintable",
        label="Sprintable",
        adapter_factory=lambda cfg: SprintableAdapter(cfg),
        check_fn=check_requirements,
        validate_config=validate_config,
        is_connected=is_connected,
        required_env=["AGENT_API_KEY"],
        allowed_users_env="SPRINTABLE_ALLOWED_USERS",
        allow_all_env="SPRINTABLE_ALLOW_ALL_USERS",
        install_hint="pip install httpx   # already a Hermes dependency",
        env_enablement_fn=_env_enablement,
        emoji="🏃",
        pii_safe=False,
        allow_update_command=True,
        platform_hint=(
            "You are communicating via the Sprintable agent gateway. "
            "Messages are teammates (humans and other agents) in a Sprintable "
            "project conversation. Reply concisely; your reply is posted back "
            "to the same conversation."
        ),
    )
