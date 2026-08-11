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
import os
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

# ── E-ACTIVATION Phase 2 (X · system-side non-invoke) ─────────────────────────
# 배달을 «관찰(observation)»과 «호출(activation)»로 가른다. 활성화 프로토콜(설계문서
# agent-agent-loop-termination-research §3·§4·§7)의 X: 「관찰」로 온 메시지는 모델을
# «아예 안 돌린다» → 비지정 에이전트가 난입할 «기회 자체»가 없다(자제 의존 아님).
#
# 판정(모델 불요·결정적):
#   audience 미지정(broadcast) → addressed=True  (전체 대상 = 현행 보존)
#   audience 지정 & 내 recipient_id ∈ audience → addressed=True  (나를 호출)
#   audience 지정 & 내 recipient_id ∉ audience → addressed=False (관찰 = non-invoke)
# 백엔드가 이벤트에 audience/recipient_id 를 실어 보낸다(Y 스파인 #2953). recipient_id 는
# per-recipient fan-out 이라 «이 스트림 소유자(나)»다 — 별도 신원 주입 불필요.
#
# 순수 드롭이면 설계문서 §6-B(강등된 problem B)로 회귀한다("안 깨운 메시지는 hydrate
# 안 해 다음에도 못 봄"). 그래서 X 는 관찰을 «버퍼»에 쌓아 두고 다음 «활성화» 턴에
# context 로 hydrate 한다("다 봄"은 보존, "즉답 강제"만 제거). seq 는 ack 해 backfill
# 재범람(#2375)을 막는다.
#
# 게이트는 SPRINTABLE_NONINVOKE_OBSERVATIONS=1 일 때만 작동 — 기본 OFF = 라이브 fleet
# 무영향(모든 이벤트 현행대로 주입). Y(SPRINTABLE_ACTIVATION_HEADER)와 독립·조합 가능.
NONINVOKE_FLAG_ENV = "SPRINTABLE_NONINVOKE_OBSERVATIONS"
OBS_BUFFER_MAX = 20          # 대화별 버퍼 최대 항목(오래된 것부터 폐기)
OBS_ENTRY_MAXLEN = 500       # 항목 1건 최대 길이


def classify_activation(
    data: dict[str, Any], payload: dict[str, Any]
) -> tuple[bool, bool, Any, Any]:
    """이벤트를 «관찰 vs 호출»로 분류. 단일 출처(Y 헤더 + X 게이트가 공유).

    Returns ``(audience_targeted, addressed, message_kind, expects_response)``.
    - ``audience_targeted``: audience 가 지정됐는가(비어있지 않은가).
    - ``addressed``: 이 이벤트가 나를 «호출»하는가(True) / 단순 «관찰»인가(False).
    """
    audience = data.get("audience") or payload.get("audience")
    message_kind = data.get("message_kind") or payload.get("message_kind")
    expects_response = data.get("expects_response")
    if expects_response is None:
        expects_response = payload.get("expects_response")
    recipient_id = data.get("recipient_id") or payload.get("recipient_id")
    audience_targeted = bool(audience)
    addressed = (not audience_targeted) or (
        recipient_id is not None and str(recipient_id) in {str(a) for a in audience}
    )
    return audience_targeted, addressed, message_kind, expects_response


def render_observation_block(entries: list[str]) -> str:
    """버퍼된 관찰들을 다음 활성화 턴에 붙일 context 블록으로 렌더."""
    lines = "\n".join(f"- {e}" for e in entries)
    return (
        f"[읽음 · 당신이 대상이 아니어서 응답하지 않은 메시지 {len(entries)}건]\n"
        f"{lines}\n[/읽음]"
    )


# ── Public types ─────────────────────────────────────────────────────────────

@dataclass
class MessageImage:
    url: str
    name: str = ""
    mime: str = ""


@dataclass
class MessageAttachment:
    """일반 첨부(이미지 포함 전체) — #2568: 서버는 payload.attachments에 이미 이걸 싣지만
    이 SDK가 `images`(mime.startswith("image/") 필터)만 읽고 있어 .md 등 비-이미지
    첨부가 여기서 조용히 사라졌다(백엔드 _msg_payload/_dispatch_conversation_event는
    attachments를 정상 포함 — 실측 확認, 드롭 지점은 여기뿐)."""
    url: str
    name: str = ""
    content_type: str = ""
    size: int | None = None
    asset_id: str = ""


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
    attachments: list[MessageAttachment]
    raw: dict[str, Any]

    # E-ACTIVATION Phase 2 분류(기본값 = 현행 보존: 늘 호출로 취급).
    addressed: bool = True
    audience_targeted: bool = False
    message_kind: Any = None
    expects_response: Any = None

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


def _normalize_attachments(value: Any) -> list[MessageAttachment]:
    """`images`와 달리 mime 필터 없음 — 첨부는 전 타입(.md 등)이 대상(#2568)."""
    if not isinstance(value, list):
        return []
    out: list[MessageAttachment] = []
    for item in value:
        if not isinstance(item, dict):
            continue
        url = str(item.get("url") or "").strip()
        if not url:
            continue
        size = item.get("size")
        try:
            size = int(size) if size is not None else None
        except (TypeError, ValueError):
            size = None
        out.append(MessageAttachment(
            url=url,
            name=str(item.get("name") or ""),
            content_type=str(item.get("content_type") or ""),
            size=size,
            asset_id=str(item.get("asset_id") or ""),
        ))
    return out


def render_attachment_notice(attachments: list[MessageAttachment]) -> str:
    """#2568 AC3: 첨부 존재+회수 경로(asset text API)를 에이전트가 알 수 있게 텍스트로
    안내. asset_id가 있으면(정상 케이스) 그 경로를, 없으면(레거시/미등록) url을 안내."""
    lines = []
    for a in attachments:
        label = a.name or a.url
        if a.asset_id:
            lines.append(
                f"- {label} ({a.content_type or 'unknown type'}) — "
                f"본문 회수: GET /api/v2/assets/{a.asset_id}/text"
            )
        else:
            lines.append(f"- {label} ({a.content_type or 'unknown type'}) — url: {a.url}")
    return f"[첨부 {len(attachments)}건]\n" + "\n".join(lines) + "\n[/첨부]"


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
        # E-ACTIVATION Phase 2 (X): conversation_id -> 관찰 메시지 버퍼(다음 활성화 때 hydrate).
        self._obs_buffer: dict[str, list[str]] = {}

    def _auth(self) -> dict[str, str]:
        return {"Authorization": f"Bearer {self._api_key}", "x-agent-api-key": self._api_key}

    def _buffer_observation(self, ctx: "MessageContext") -> None:
        """관찰 이벤트를 대화별 버퍼에 쌓는다(오래된 것부터 폐기)."""
        buf = self._obs_buffer.setdefault(ctx.conversation_id, [])
        buf.append(f"{ctx.sender_name}: {ctx.content}"[:OBS_ENTRY_MAXLEN])
        if len(buf) > OBS_BUFFER_MAX:
            del buf[:-OBS_BUFFER_MAX]

    def _flush_observations_into(self, ctx: "MessageContext") -> None:
        """이 대화의 버퍼된 관찰을 활성화 ctx.content 앞에 context 로 hydrate 후 비운다."""
        buf = self._obs_buffer.pop(ctx.conversation_id, None)
        if not buf:
            return
        block = render_observation_block(buf)
        ctx.content = f"{block}\n{ctx.content}" if ctx.content else block

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
        attachments = _normalize_attachments(data.get("attachments") or payload.get("attachments"))
        if not content and not images and not attachments:
            return None
        # #2568 AC2/AC3: 첨부가 있으면 안내 블록을 content에 병합 — 어댑터마다 따로
        # 렌더하게 하지 않고 SDK 단일 지점에서 처리(어댑터 코드 수정 0으로 전파).
        if attachments:
            notice = render_attachment_notice(attachments)
            content = f"{content}\n\n{notice}" if content else notice

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

        audience_targeted, addressed, message_kind, expects_response = classify_activation(data, payload)

        return MessageContext(
            content=content,
            conversation_id=conversation_id,
            sender_id=sender_id,
            sender_name=sender_name,
            event_id=event_id,
            seq=seq,
            is_backfill=is_backfill,
            images=images,
            attachments=attachments,
            raw=data,
            addressed=addressed,
            audience_targeted=audience_targeted,
            message_kind=message_kind,
            expects_response=expects_response,
            _reply_url=reply_url,
            _api_key=self._api_key,
            _http=self._http,
        )

    async def _dispatch_event(self, ctx: "MessageContext", on_message: MessageHandler) -> None:
        """E-ACTIVATION Phase 2 (X): 관찰이면 버퍼+ack(모델 미주입), 호출이면 버퍼 flush 후 주입+ack.

        SPRINTABLE_NONINVOKE_OBSERVATIONS=1 일 때만 게이팅 — 기본 OFF = 모든 이벤트 현행대로 주입.
        """
        if os.getenv(NONINVOKE_FLAG_ENV) == "1":
            if not ctx.addressed:
                # 관찰 → 모델을 «아예 안 깨운다». 버퍼에 쌓고 seq 만 ack(backfill 재범람 방지).
                self._buffer_observation(ctx)
                logger.info("observation (non-invoke) seq=%d conv=%s from=%s",
                            ctx.seq, ctx.conversation_id, ctx.sender_name)
                if ctx.seq:
                    await self._ack(ctx.seq)
                return
            # 호출 → 쌓인 관찰을 context 로 hydrate 후 정상 주입.
            self._flush_observations_into(ctx)
        logger.info("inbound seq=%d conv=%s: %s",
                    ctx.seq, ctx.conversation_id, ctx.content[:80])
        await on_message(ctx)
        if ctx.seq:
            await self._ack(ctx.seq)

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
                            await self._dispatch_event(ctx, on_message)
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
