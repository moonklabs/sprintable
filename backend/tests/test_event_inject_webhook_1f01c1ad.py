"""1f01c1ad: INJECTABLE 이벤트(dispatched/story_assigned) → member webhook 주입.

배경: dispatched/story_assigned는 wake_agent(SSE)로만 통지돼 CC 세션(member webhook 구동)에
영영 도달하지 못했다. deliver_injected_event_webhook이 conversation.message_created와 동일한
member webhook 경로로 INJECTABLE 이벤트를 주입한다(CC 릴레이 갭 보강).
"""
from __future__ import annotations

import contextlib
import uuid
from types import SimpleNamespace
from unittest.mock import AsyncMock, MagicMock, patch

import pytest

from app.services.conversation_webhook import (
    _to_discord_payload,
    deliver_injected_event_webhook,
)

ORG_ID = uuid.uuid4()
RECIPIENT_ID = uuid.uuid4()
DISCORD_URL = "https://discord.com/api/webhooks/123/abc"


@pytest.fixture
def anyio_backend():
    return "asyncio"


def _wh(url=DISCORD_URL, events=None, secret=None, member_id=RECIPIENT_ID):
    return SimpleNamespace(
        id=uuid.uuid4(), url=url, secret=secret, events=events,
        member_id=member_id, is_active=True,
    )


def _patch_factory(wh_rows):
    """async_session_factory mock — execute().scalars().all() → wh_rows."""
    db = MagicMock()
    result = MagicMock()
    result.scalars.return_value.all.return_value = list(wh_rows)
    db.execute = AsyncMock(return_value=result)

    def _factory():
        @contextlib.asynccontextmanager
        async def _cm():
            yield db
        return _cm()

    return _factory, db


async def _run(wh_rows, **kwargs):
    """deliver_injected_event_webhook 실행 — _attempt_delivery 호출 캡처."""
    factory, db = _patch_factory(wh_rows)
    calls: list[tuple] = []

    async def _capture(url, secret, payload):
        calls.append((url, secret, payload))

    base = dict(
        org_id=ORG_ID, recipient_id=RECIPIENT_ID,
        content="[story] Build — ship it", event_type="dispatched",
        source_entity_type="story", source_entity_id=uuid.uuid4(),
    )
    base.update(kwargs)
    with patch("app.core.database.async_session_factory", factory), \
         patch("app.services.conversation_webhook._attempt_delivery", new=AsyncMock(side_effect=_capture)):
        await deliver_injected_event_webhook(**base)
    return calls, db


# ── 핵심: 수신자 member webhook으로 1회 주입 ──────────────────────────────────

@pytest.mark.anyio
async def test_delivers_to_recipient_member_webhook():
    calls, _ = await _run([_wh()])
    assert len(calls) == 1
    url, _secret, payload = calls[0]
    assert url == DISCORD_URL
    assert payload["event_type"] == "dispatched"
    assert payload["content"] == "[story] Build — ship it"
    assert payload["source_entity_type"] == "story"


@pytest.mark.anyio
async def test_discord_payload_carries_content_for_cc_relay():
    """_to_discord_payload가 content를 CC 릴레이가 파싱하는 '📩 새 메시지' 포맷으로 변환."""
    calls, _ = await _run([_wh()])
    discord = _to_discord_payload(calls[0][2])
    assert "📩" in discord["content"]
    assert "[story] Build — ship it" in discord["content"]


# ── events 구독 필터 ──────────────────────────────────────────────────────────

@pytest.mark.anyio
async def test_subscribed_event_delivered():
    calls, _ = await _run([_wh(events=["dispatched", "conversation.message_created"])])
    assert len(calls) == 1


@pytest.mark.anyio
async def test_unsubscribed_event_dropped():
    calls, _ = await _run([_wh(events=["conversation.message_created"])])
    assert calls == []


@pytest.mark.anyio
async def test_empty_events_means_subscribe_all():
    calls, _ = await _run([_wh(events=[])])
    assert len(calls) == 1


# ── dup 0: 같은 endpoint 중복 발송 방지 ───────────────────────────────────────

@pytest.mark.anyio
async def test_duplicate_url_delivered_once():
    """동일 URL webhook이 2건이어도 1회만 발송 (acked_seq 전례 — 채널당 dup 0)."""
    calls, _ = await _run([_wh(), _wh(member_id=uuid.uuid4())])
    assert len(calls) == 1


# ── no-op 경로 ────────────────────────────────────────────────────────────────

@pytest.mark.anyio
async def test_no_webhook_no_delivery():
    calls, db = await _run([])
    assert calls == []


@pytest.mark.anyio
async def test_blank_content_short_circuits_before_db():
    """content 없으면 DB 조회 전 즉시 반환 (불필요한 쿼리 0)."""
    calls, db = await _run([_wh()], content="   ")
    assert calls == []
    db.execute.assert_not_awaited()
