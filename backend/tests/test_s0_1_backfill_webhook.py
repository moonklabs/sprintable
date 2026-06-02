"""S0-1: fakechat backfill 교정 + conversations 웹훅 검증.

AC1: SSE reconnect 시 sse_bridge가 last_event_id 전달 (S6-1 이미 구현, 소스 검증)
AC2: last_event_id=None (초기 연결) 시 backfill 상한 BACKFILL_INITIAL_EVENTS (default 5)
AC3: conversations send_message 시 webhook BackgroundTask 추가됨
AC4: conversation:message 이벤트가 sse_bridge relay 대상
AC5: memo 경로(send_memo/reply_memo) 기능 영향 없음
"""
from __future__ import annotations

import inspect
import uuid
from datetime import datetime, timedelta, timezone
from unittest.mock import AsyncMock, MagicMock, patch

import pytest

from app.routers.events import (
    _BACKFILL_INITIAL_EVENTS,
    _BACKFILL_MAX_EVENTS,
    _BACKFILL_THRESHOLD_SECONDS,
    _compute_backfill_mode,
)


@pytest.fixture
def anyio_backend():
    return "asyncio"


# ─── AC2: 초기 연결 backfill 상한 ────────────────────────────────────────────

def test_initial_events_default():
    """BACKFILL_INITIAL_EVENTS 기본값 5건."""
    assert _BACKFILL_INITIAL_EVENTS == 5


def test_initial_connect_uses_initial_limit():
    """initial=True + ref_ts=None → BACKFILL_INITIAL_EVENTS 상한."""
    now = datetime.now(timezone.utc)
    exceed, limit = _compute_backfill_mode(None, now, initial=True)
    assert exceed is True
    assert limit == _BACKFILL_INITIAL_EVENTS


def test_reconnect_uses_max_events_limit():
    """initial=False + ref_ts=None → BACKFILL_MAX_EVENTS 상한 (재연결 fallback)."""
    now = datetime.now(timezone.utc)
    exceed, limit = _compute_backfill_mode(None, now, initial=False)
    assert exceed is True
    assert limit == _BACKFILL_MAX_EVENTS


def test_initial_within_threshold_uses_asc():
    """initial=True라도 ref_ts가 threshold 이내 → ASC 전량 (initial 무관)."""
    now = datetime.now(timezone.utc)
    ref = now - timedelta(seconds=10)
    exceed, limit = _compute_backfill_mode(ref, now, initial=True)
    assert exceed is False
    assert limit == 100


def test_initial_connect_source_in_generate():
    """generate() 소스에 is_initial 분기가 포함됨."""
    from app.routers.events import agent_event_stream
    source = inspect.getsource(agent_event_stream)
    assert "is_initial" in source
    assert "last_event_id is None and since_timestamp is None" in source
    assert "initial=is_initial" in source


# ─── AC1: SSE reconnect last_event_id 전달 ───────────────────────────────────

def test_sse_bridge_stores_last_event_id_on_reconnect():
    """_current_last_event_id가 갱신되어 재연결 시 _connect_once에 전달됨."""
    from sprintable_mcp import sse_bridge
    source = inspect.getsource(sse_bridge.start_sse_bridge)
    assert "_current_last_event_id" in source
    assert "nonlocal _current_last_event_id" in source
    assert "_current_last_event_id = event.last_event_id" in source


def test_connect_once_passes_last_event_id_param():
    """_connect_once가 last_event_id를 SSE 쿼리 파라미터에 포함."""
    from sprintable_mcp import sse_bridge
    source = inspect.getsource(sse_bridge._connect_once)
    assert 'params["last_event_id"] = last_event_id' in source


def test_backfill_yields_sse_id_field():
    """SSE backfill yield에 id: 필드 포함 → bridge가 last_event_id 파싱 가능."""
    from app.routers.events import agent_event_stream
    source = inspect.getsource(agent_event_stream)
    assert "id: {evt.id}" in source


def test_live_sse_always_yields_id_field():
    """live SSE yield에 event_id 없어도 uuid4()로 id: 보장."""
    from app.routers.events import agent_event_stream
    source = inspect.getsource(agent_event_stream)
    assert "_live_id = eid or str(uuid.uuid4())" in source


# ─── AC3: conversations webhook BackgroundTask 검증 ──────────────────────────

def test_send_message_webhook_background_task_in_source():
    """send_message 소스에 deliver_conversation_message_webhook BackgroundTask 추가 확인."""
    import inspect
    from app.routers import conversations as cv
    source = inspect.getsource(cv.send_message)
    assert "deliver_conversation_message_webhook" in source
    assert "background_tasks.add_task" in source
    # webhook에 필수 파라미터 전달 확인
    assert "message_id=msg.id" in source
    assert "conversation_id=conversation_id" in source
    assert "content=msg.content" in source


# ─── AC5: memo 경로 기능 영향 없음 ───────────────────────────────────────────

@pytest.mark.xfail(reason="E-MEMO-RETIRE S3-3: send_memo 도구 제거됨", strict=False)
def test_send_memo_tool_still_registered():
    """send_memo 도구가 MCP 서버에 등록되어 있음."""
    import os
    os.environ.setdefault("SPRINTABLE_API_URL", "http://test")
    os.environ.setdefault("AGENT_API_KEY", "sk_test")
    from sprintable_mcp.server import mcp
    tools = mcp._tool_manager._tools
    assert "sprintable_send_memo" in tools


@pytest.mark.xfail(reason="E-MEMO-RETIRE S3-3: reply_memo 도구 제거됨", strict=False)
def test_reply_memo_tool_still_registered():
    """reply_memo 도구가 MCP 서버에 등록되어 있음."""
    import os
    os.environ.setdefault("SPRINTABLE_API_URL", "http://test")
    os.environ.setdefault("AGENT_API_KEY", "sk_test")
    from sprintable_mcp.server import mcp
    tools = mcp._tool_manager._tools
    assert "sprintable_reply_memo" in tools


def test_backfill_threshold_unchanged():
    """S6-1 backfill threshold 기본값 300초 유지."""
    assert _BACKFILL_THRESHOLD_SECONDS == 300


def test_backfill_max_events_unchanged():
    """S6-1 BACKFILL_MAX_EVENTS 기본값 50건 유지 (재연결 시 기준)."""
    assert _BACKFILL_MAX_EVENTS == 50
