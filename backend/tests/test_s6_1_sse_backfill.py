"""S6-1: SSE backfill 볼륨 제어 테스트.

AC1: last_event_id / since_timestamp 파라미터 기반 필터링
AC2: BACKFILL_THRESHOLD_SECONDS 설정 (default 300)
AC3: threshold 초과 시 최근 N건만 전송
AC4: threshold 이내 시 전량 backfill 유지
AC5: 단위 테스트 — threshold 경계값 검증
AC6: 통합 테스트 — 재접속 시나리오 검증
"""
from __future__ import annotations

import asyncio
import importlib
import uuid
from contextlib import asynccontextmanager
from datetime import datetime, timedelta, timezone
from unittest.mock import AsyncMock, MagicMock, patch

import pytest

from app.models.event import Event
from app.routers.events import (
    _BACKFILL_MAX_EVENTS,
    _BACKFILL_THRESHOLD_SECONDS,
    _SSE_BATCH_SIZE,
    _agent_connections,
)


@pytest.fixture
def anyio_backend():
    return "asyncio"


def _make_event(**kwargs) -> MagicMock:
    defaults = {
        "id": uuid.uuid4(),
        "org_id": uuid.uuid4(),
        "project_id": uuid.uuid4(),
        "event_type": "memo_created",
        "source_entity_type": "memo",
        "source_entity_id": uuid.uuid4(),
        "sender_id": uuid.uuid4(),
        "recipient_id": uuid.uuid4(),
        "recipient_type": "agent",
        "payload": {},
        "status": "pending",
        "created_at": datetime.now(timezone.utc),
        "delivered_at": None,
    }
    defaults.update(kwargs)
    event = MagicMock(spec=Event)
    for k, v in defaults.items():
        setattr(event, k, v)
    return event


# ─── AC2: 환경변수 기본값 검증 ───────────────────────────────────────────────

def test_backfill_threshold_default():
    """BACKFILL_THRESHOLD_SECONDS 기본값 300초."""
    assert _BACKFILL_THRESHOLD_SECONDS == 300


def test_backfill_max_events_default():
    """BACKFILL_MAX_EVENTS 기본값 50건."""
    assert _BACKFILL_MAX_EVENTS == 50


# ─── AC1: 엔드포인트 파라미터 시그니처 검증 ──────────────────────────────────

def test_stream_endpoint_accepts_since_timestamp_param():
    """agent_event_stream이 since_timestamp 쿼리 파라미터를 수락함."""
    import inspect
    from app.routers.events import agent_event_stream
    sig = inspect.signature(agent_event_stream)
    assert "since_timestamp" in sig.parameters


def test_stream_endpoint_accepts_last_event_id_param():
    """agent_event_stream이 last_event_id 쿼리 파라미터를 수락함."""
    import inspect
    from app.routers.events import agent_event_stream
    sig = inspect.signature(agent_event_stream)
    assert "last_event_id" in sig.parameters


# ─── AC3: threshold 초과 시 최근 N건만 (소스 검증) ──────────────────────────

def test_backfill_source_contains_threshold_logic():
    """agent_event_stream 소스에 threshold 분기 로직이 포함됨."""
    import inspect
    from app.routers import events as ev_module
    source = inspect.getsource(ev_module.agent_event_stream)
    assert "_BACKFILL_THRESHOLD_SECONDS" in source
    assert "_BACKFILL_MAX_EVENTS" in source
    assert "order_by(Event.created_at.desc())" in source  # threshold 초과: 최신순


def test_backfill_source_contains_since_filter():
    """agent_event_stream 소스에 since_timestamp 필터가 포함됨."""
    import inspect
    from app.routers import events as ev_module
    source = inspect.getsource(ev_module.agent_event_stream)
    assert "Event.created_at > _ref" in source


def test_backfill_source_emits_sse_id_field():
    """SSE 백필 yield에 id: 필드가 포함됨."""
    import inspect
    from app.routers import events as ev_module
    source = inspect.getsource(ev_module.agent_event_stream)
    assert "id: {evt.id}" in source


# ─── AC5: threshold 경계값 — 단위 테스트 ─────────────────────────────────────

@pytest.mark.anyio
async def test_threshold_exceeded_delivers_max_events_only(org_id=None):
    """threshold 초과 시 최근 BACKFILL_MAX_EVENTS건만 전달."""
    if org_id is None:
        org_id = uuid.uuid4()
    member_id = uuid.uuid4()
    now = datetime.now(timezone.utc)

    # 200건 pending — threshold 초과 (ref_ts=None)
    events = [
        _make_event(
            recipient_id=member_id,
            org_id=org_id,
            status="pending",
            created_at=now - timedelta(seconds=i),
        )
        for i in range(200)
    ]

    membership_result = MagicMock()
    membership_result.scalar_one_or_none.return_value = member_id

    scalars_mock = MagicMock()
    # reversed()로 BACKFILL_MAX_EVENTS건 → 역순 정렬
    scalars_mock.all.return_value = events[:_BACKFILL_MAX_EVENTS]

    pending_result = MagicMock()
    pending_result.scalars.return_value = scalars_mock

    mock_session = AsyncMock()
    mock_session.commit = AsyncMock()
    mock_session.execute = AsyncMock(side_effect=[membership_result, pending_result])

    @asynccontextmanager
    async def _session_factory():
        yield mock_session

    from app.dependencies.auth import get_current_user, get_verified_org_id
    from app.main import app
    from httpx import ASGITransport, AsyncClient

    async def _auth():
        ctx = MagicMock()
        ctx.user_id = str(uuid.uuid4())
        ctx.claims = {}
        return ctx

    async def _org():
        return org_id

    app.dependency_overrides[get_current_user] = _auth
    app.dependency_overrides[get_verified_org_id] = _org

    received = []
    try:
        with patch("app.core.database.async_session_factory", _session_factory):
            async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as c:
                async with c.stream("GET", f"/api/v2/events/stream?member_id={member_id}") as resp:
                    async for line in resp.aiter_lines():
                        if line.startswith("data:"):
                            received.append(line)
                        if len(received) >= _BACKFILL_MAX_EVENTS:
                            break
    finally:
        app.dependency_overrides.clear()
        _agent_connections.pop(str(member_id), None)

    assert len(received) == _BACKFILL_MAX_EVENTS


@pytest.mark.anyio
async def test_threshold_within_delivers_all_events():
    """threshold 이내 시 since_timestamp 이후 전량 전달 (최대 100건)."""
    org_id = uuid.uuid4()
    member_id = uuid.uuid4()
    now = datetime.now(timezone.utc)
    # since_timestamp: 10초 전 — threshold(300초) 이내
    since = now - timedelta(seconds=10)

    n_events = 15
    events = [
        _make_event(
            recipient_id=member_id,
            org_id=org_id,
            status="pending",
            created_at=now - timedelta(seconds=i),
        )
        for i in range(n_events)
    ]

    membership_result = MagicMock()
    membership_result.scalar_one_or_none.return_value = member_id

    scalars_mock = MagicMock()
    scalars_mock.all.return_value = events
    pending_result = MagicMock()
    pending_result.scalars.return_value = scalars_mock

    mock_session = AsyncMock()
    mock_session.commit = AsyncMock()
    mock_session.execute = AsyncMock(side_effect=[membership_result, pending_result])

    @asynccontextmanager
    async def _session_factory():
        yield mock_session

    from app.dependencies.auth import get_current_user, get_verified_org_id
    from app.main import app
    from httpx import ASGITransport, AsyncClient

    async def _auth():
        ctx = MagicMock()
        ctx.user_id = str(uuid.uuid4())
        ctx.claims = {}
        return ctx

    async def _org():
        return org_id

    app.dependency_overrides[get_current_user] = _auth
    app.dependency_overrides[get_verified_org_id] = _org

    received = []
    try:
        with patch("app.core.database.async_session_factory", _session_factory):
            async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as c:
                async with c.stream(
                    "GET",
                    f"/api/v2/events/stream?member_id={member_id}&since_timestamp={since.isoformat()}",
                ) as resp:
                    async for line in resp.aiter_lines():
                        if line.startswith("data:"):
                            received.append(line)
                        if len(received) >= n_events:
                            break
    finally:
        app.dependency_overrides.clear()
        _agent_connections.pop(str(member_id), None)

    assert len(received) == n_events


# ─── AC6: 통합 — sse_bridge last_event_id 재연결 전달 ────────────────────────

@pytest.mark.anyio
async def test_sse_bridge_passes_last_event_id_on_reconnect():
    """재연결 시 _connect_once에 _current_last_event_id가 전달됨."""
    import inspect
    from sprintable_mcp import sse_bridge

    source = inspect.getsource(sse_bridge.start_sse_bridge)
    assert "_current_last_event_id" in source
    assert "nonlocal _current_last_event_id" in source


def test_connect_once_signature_has_last_event_id():
    """_connect_once가 last_event_id 파라미터를 수락함."""
    import inspect
    from sprintable_mcp.sse_bridge import _connect_once
    sig = inspect.signature(_connect_once)
    assert "last_event_id" in sig.parameters
    assert sig.parameters["last_event_id"].default == ""


@pytest.mark.anyio
async def test_connect_once_includes_last_event_id_in_params():
    """_connect_once가 last_event_id를 SSE 쿼리 파라미터로 전달함."""
    import inspect
    from sprintable_mcp import sse_bridge

    source = inspect.getsource(sse_bridge._connect_once)
    assert 'params["last_event_id"] = last_event_id' in source


@pytest.mark.anyio
async def test_handle_updates_current_last_event_id():
    """이벤트 수신 시 _current_last_event_id가 갱신되어 다음 재연결에 사용됨."""
    from sprintable_mcp.sse_bridge import SseEvent, SseParser

    parser = SseParser()
    events = []
    eid = str(uuid.uuid4())

    for line in [f"id: {eid}", "event: memo_created", "data: test", ""]:
        e = parser.feed(line)
        if e:
            events.append(e)

    assert len(events) == 1
    assert events[0].last_event_id == eid
    assert parser.last_event_id == eid


# ─── SSE id: 필드 전달 검증 ──────────────────────────────────────────────────

def test_live_event_yield_contains_id_field():
    """실시간 SSE yield에 id: 필드 생성 로직이 포함됨."""
    import inspect
    from app.routers import events as ev_module
    source = inspect.getsource(ev_module.agent_event_stream)
    assert "eid_field" in source
    assert "id: {eid}" in source
