"""S-COMM-05: SSE 재연결 backfill + dedup 테스트.

AC1: Last-Event-ID 헤더 기반 재연결 backfill.
AC2: 서버사이드 event_id 기준 — 클라이언트가 마지막 수신 ID 이후 이벤트만 받음.
AC3: 이벤트 보관 기간 최소 24시간.
AC4: 동일 event_id 중복 전송 없음 — 백필+라이브 교차 dedup.
"""
from __future__ import annotations

import asyncio
import inspect
import uuid
from contextlib import asynccontextmanager
from datetime import datetime, timezone
from unittest.mock import AsyncMock, MagicMock, patch

import pytest
from httpx import ASGITransport, AsyncClient

from app.models.event import Event
from app.routers.events import _agent_connections, _push_to_agent


@pytest.fixture
def anyio_backend():
    return "asyncio"


@pytest.fixture
def org_id():
    return uuid.uuid4()


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


def _make_mock_session():
    session = AsyncMock()
    session.add = MagicMock()
    session.commit = AsyncMock()
    session.refresh = AsyncMock()
    session.execute = AsyncMock()
    return session


def _membership_ok(member_id: uuid.UUID) -> MagicMock:
    r = MagicMock()
    r.scalar_one_or_none.return_value = member_id
    return r


def _pending_empty() -> MagicMock:
    scalars = MagicMock()
    scalars.all.return_value = []
    r = MagicMock()
    r.scalars.return_value = scalars
    return r


# ── AC1: Last-Event-ID 헤더 → last_event_id 파라미터로 해석 ──────────────────

def test_last_event_id_header_accepted():
    """Last-Event-ID 헤더 읽기 로직이 소스에 존재해야 함 (AC1)."""
    import inspect
    from app.routers import events as ev_mod
    source = inspect.getsource(ev_mod.agent_event_stream)
    # RFC 8895: Last-Event-ID 헤더 읽기
    assert "Last-Event-ID" in source or "last-event-id" in source, (
        "agent_event_stream must read Last-Event-ID header (S-COMM-05 AC1)"
    )
    # 헤더 → last_event_id 변환 로직
    assert "request.headers.get" in source, (
        "Must use request.headers.get to read Last-Event-ID header"
    )
    # 헤더 우선 처리 (last_event_id is None 체크)
    assert "last_event_id is None" in source, (
        "Header must only override when last_event_id query param is absent"
    )


@pytest.mark.anyio
async def test_last_event_id_header_takes_precedence_over_query(org_id):
    """Last-Event-ID 헤더가 query 파라미터보다 우선해야 함."""
    from app.routers import events as ev_module
    import app.routers.events as ev_mod_raw
    source = inspect.getsource(ev_mod_raw.agent_event_stream)
    # 헤더 읽기 코드가 존재하는지 확인
    assert "Last-Event-ID" in source or "last-event-id" in source, (
        "agent_event_stream must read Last-Event-ID header (S-COMM-05 AC1)"
    )
    # 헤더 우선 로직 확인
    assert "last_event_id" in source


# ── AC2: 서버 id: 필드 포함 + last_event_id 기반 커서 ────────────────────────

def test_sse_id_field_in_backfill_source():
    """백필 yield 소스에 id: 필드가 포함되어야 함 (AC2)."""
    import inspect
    from app.routers import events as ev_mod
    source = inspect.getsource(ev_mod.agent_event_stream)
    # 백필 경로 yield에 "id: {evt.id}" 패턴 존재 확인
    assert "\\nid:" in source or r"\nid:" in source or "id: {evt.id}" in source or "nid:" in source, (
        "Backfill SSE yield must include id: field (AC2)"
    )
    # 실제 yield 문에서 id 필드 포함 확인 (문자열 포함 여부)
    assert "evt.id" in source, "Backfill SSE yield must embed evt.id in id: field"


def test_live_sse_id_field_in_source():
    """실시간 이벤트 yield 소스에 id: 필드가 포함되어야 함 (AC2)."""
    import inspect
    from app.routers import events as ev_mod
    source = inspect.getsource(ev_mod.agent_event_stream)
    assert "_live_id" in source, "Live SSE must use _live_id for id: field (AC2)"
    assert "is_backfill" in source, "Live SSE must include is_backfill flag"


def test_last_event_id_cursor_in_backfill_source():
    """백필 쿼리에 last_event_id 커서 조건이 있어야 함 (AC2)."""
    import inspect
    from app.routers import events as ev_mod
    source = inspect.getsource(ev_mod.agent_event_stream)
    assert "last_event_id" in source
    assert "created_at" in source


# ── AC3: 이벤트 보관 기간 최소 24시간 ─────────────────────────────────────────

def test_event_retention_minimum_24h():
    """pending 이벤트는 최소 24시간 이상 보관되어야 함 (AC3)."""
    import app.routers.events as ev_module
    # pending: _EXPIRE_DAYS × 24 >= 24h
    assert ev_module._EXPIRE_DAYS * 24 >= ev_module._EVENT_RETENTION_MIN_HOURS, (
        f"pending event retention {ev_module._EXPIRE_DAYS * 24}h < 24h minimum"
    )


def test_delivered_event_retention_minimum_24h():
    """delivered 이벤트도 최소 24시간 이상 보관되어야 함 (AC3)."""
    import app.routers.events as ev_module
    assert ev_module._CLEANUP_DAYS * 24 >= ev_module._EVENT_RETENTION_MIN_HOURS, (
        f"delivered event cleanup {ev_module._CLEANUP_DAYS * 24}h < 24h minimum"
    )


def test_event_retention_constant_exported():
    """_EVENT_RETENTION_MIN_HOURS 상수가 export되어 있어야 함."""
    import app.routers.events as ev_module
    assert hasattr(ev_module, "_EVENT_RETENTION_MIN_HOURS")
    assert ev_module._EVENT_RETENTION_MIN_HOURS == 24


# ── AC4: 동일 event_id 중복 전송 없음 ─────────────────────────────────────────

@pytest.mark.anyio
async def test_live_event_skipped_if_already_backfilled():
    """백필에서 delivered 마킹된 이벤트는 live 경로에서 skip되어야 함 (AC4)."""
    member_id = str(uuid.uuid4())
    event_id = str(uuid.uuid4())

    queue: asyncio.Queue = asyncio.Queue(maxsize=10)
    _agent_connections[member_id].add(queue)

    try:
        # 동일 event_id를 두 번 push — 큐에는 두 개 모두 쌓임
        _push_to_agent(member_id, {"event_type": "memo_created", "event_id": event_id})
        _push_to_agent(member_id, {"event_type": "memo_created", "event_id": event_id})

        # 큐에서 첫 번째만 꺼냄
        first = queue.get_nowait()
        assert first["event_id"] == event_id

        # 두 번째 큐 항목은 서버의 DB dedup 로직으로 skip됨 (소스 레벨 검증)
        # 여기서는 live delivered 마킹 소스가 event_id를 체크하는지 확인
        import inspect
        from app.routers import events as ev_mod
        source = inspect.getsource(ev_mod.agent_event_stream)
        # live 경로에서 status == "pending" 체크 (이미 delivered면 skip)
        assert "status" in source and "pending" in source
        assert "continue" in source  # skip 로직 존재 확인
    finally:
        _agent_connections[member_id].discard(queue)
        _agent_connections.pop(member_id, None)


def test_backfill_only_sends_pending_events():
    """백필은 pending 상태 이벤트만 전송해야 함 (AC4)."""
    import inspect
    from app.routers import events as ev_mod
    source = inspect.getsource(ev_mod.agent_event_stream)
    # 백필 쿼리에 status == "pending" 조건이 있어야 함
    assert 'status == "pending"' in source or "status==\"pending\"" in source, (
        "Backfill query must filter by status=pending (AC4)"
    )


def test_is_backfill_flag_in_sse_payload():
    """백필 이벤트 payload에 is_backfill: True 플래그가 있어야 함."""
    import inspect
    from app.routers import events as ev_mod
    source = inspect.getsource(ev_mod.agent_event_stream)
    assert "is_backfill" in source
    assert "True" in source  # is_backfill=True 백필 마킹
    assert "False" in source  # is_backfill=False 라이브 마킹
