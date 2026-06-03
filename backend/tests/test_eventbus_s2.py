"""E-EVENTBUS S2: MCP Streamable HTTP SSE 푸시 구현 테스트."""
from __future__ import annotations

import asyncio
import uuid
from datetime import datetime, timezone
from unittest.mock import AsyncMock, MagicMock, patch

import pytest
from httpx import ASGITransport, AsyncClient

from app.models.event import Event
from app.routers.events import _agent_connections, _push_to_agent


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
        "payload": {"title": "test"},
        "status": "pending",
        "created_at": datetime.now(timezone.utc),
        "delivered_at": None,
    }
    defaults.update(kwargs)
    event = MagicMock(spec=Event)
    for k, v in defaults.items():
        setattr(event, k, v)
    return event


@pytest.fixture
def org_id():
    return uuid.uuid4()


@pytest.fixture
def mock_session():
    session = AsyncMock()
    session.add = MagicMock()
    session.commit = AsyncMock()
    session.refresh = AsyncMock()
    session.execute = AsyncMock()
    return session


@pytest.fixture
def auth_ctx(org_id):
    ctx = MagicMock()
    ctx.user_id = str(uuid.uuid4())
    ctx.email = "agent@test.com"
    ctx.claims = {"app_metadata": {"org_id": str(org_id)}}
    return ctx


@pytest.fixture
async def client(mock_session, auth_ctx, org_id):
    from app.dependencies.auth import get_current_user, get_verified_org_id, get_current_user_streaming, get_verified_org_id_streaming
    from app.dependencies.database import get_db
    from app.main import app

    async def _db():
        yield mock_session

    async def _auth():
        return auth_ctx

    async def _org():
        return org_id

    app.dependency_overrides[get_db] = _db
    app.dependency_overrides[get_current_user] = _auth
    app.dependency_overrides[get_verified_org_id] = _org
    app.dependency_overrides[get_current_user_streaming] = _auth
    app.dependency_overrides[get_verified_org_id_streaming] = _org
    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as c:
        yield c
    app.dependency_overrides.clear()


# ─── AC1 + AC5: SSE 스트림 수립 + 해제 감지 ─────────────────────────────────

def test_agent_stream_registers_connection(mock_session, org_id):
    """GET /api/v2/events/stream 연결 시 _agent_connections에 등록됨."""
    from starlette.testclient import TestClient
    import threading
    from contextlib import asynccontextmanager

    member_id = uuid.uuid4()

    # 1st execute: member org 소속 검증 → member_id 반환
    # 2nd execute: pending 이벤트 조회 → 빈 목록
    membership_result = MagicMock()
    membership_result.scalar_one_or_none.return_value = member_id

    scalars_mock = MagicMock()
    scalars_mock.all.return_value = []
    pending_result = MagicMock()
    pending_result.scalars.return_value = scalars_mock

    mock_session.execute.side_effect = [membership_result, pending_result]

    from app.dependencies.auth import get_current_user, get_verified_org_id, get_current_user_streaming, get_verified_org_id_streaming
    from app.dependencies.database import get_db
    from app.main import app

    async def _db():
        yield mock_session

    async def _auth():
        ctx = MagicMock()
        ctx.user_id = str(member_id)  # API key: user_id = team_member.id
        ctx.claims = {"app_metadata": {"api_key_id": "test-key", "org_id": str(org_id)}}
        return ctx

    async def _org():
        return org_id

    @asynccontextmanager
    async def _session_factory():
        yield mock_session

    app.dependency_overrides[get_db] = _db
    app.dependency_overrides[get_current_user] = _auth
    app.dependency_overrides[get_verified_org_id] = _org
    app.dependency_overrides[get_current_user_streaming] = _auth
    app.dependency_overrides[get_verified_org_id_streaming] = _org

    try:
        with patch("app.core.database.async_session_factory", _session_factory):
            with patch("app.routers.events._SSE_HEARTBEAT_TIMEOUT", 0.1):
                with TestClient(app, raise_server_exceptions=False) as c:
                    with c.stream("GET", f"/api/v2/events/stream?member_id={member_id}") as resp:
                        assert resp.status_code == 200
                        assert str(member_id) in _agent_connections

                        def _inject():
                            import time; time.sleep(0.05)
                            for q in list(_agent_connections.get(str(member_id), set())):
                                try: q.put_nowait({"event_type": "__test_sentinel__"})
                                except: pass

                        t = threading.Thread(target=_inject)
                        t.start()
                        for line in resp.iter_lines():
                            if "__test_sentinel__" in line:
                                resp.close(); break
                        t.join(timeout=1.0)
    finally:
        app.dependency_overrides.clear()
        _agent_connections.pop(str(member_id), None)


# ─── AC2: 연결 중 에이전트 → SSE 즉시 전달 ───────────────────────────────────

@pytest.mark.anyio
async def test_push_to_agent_delivers_when_connected():
    """연결된 에이전트에게 _push_to_agent 호출 시 True 반환."""
    member_id = str(uuid.uuid4())
    queue: asyncio.Queue = asyncio.Queue(maxsize=10)
    _agent_connections[member_id] = {queue}  # set[Queue] 타입

    try:
        payload = {"event_type": "memo_created", "event_id": str(uuid.uuid4())}
        result = _push_to_agent(member_id, payload)
        assert result is True
        received = queue.get_nowait()
        assert received["event_type"] == "memo_created"
    finally:
        _agent_connections.pop(member_id, None)


# ─── AC3: 미연결 에이전트 → pending 유지 ─────────────────────────────────────

@pytest.mark.anyio
async def test_push_to_agent_returns_false_when_not_connected():
    """미연결 에이전트에게 _push_to_agent 호출 시 False 반환."""
    member_id = str(uuid.uuid4())
    # _agent_connections에 없음
    result = _push_to_agent(member_id, {"event_type": "memo_created"})
    assert result is False


@pytest.mark.anyio
async def test_create_event_stays_pending_when_agent_not_connected(client, mock_session):
    """미연결 에이전트 recipient → 이벤트 status=pending 유지."""
    recipient_id = uuid.uuid4()
    event = _make_event(recipient_id=recipient_id, recipient_type="agent", status="pending")

    member_result = MagicMock()
    member_result.scalar_one_or_none.return_value = "agent"
    mock_session.execute.return_value = member_result

    async def _refresh(obj):
        obj.id = event.id
        obj.status = "pending"
        obj.created_at = event.created_at
        obj.delivered_at = None
        obj.recipient_type = "agent"
        obj.org_id = uuid.uuid4()
        obj.project_id = uuid.uuid4()
        obj.event_type = "memo_created"
        obj.source_entity_type = None
        obj.source_entity_id = None
        obj.sender_id = None
        obj.recipient_id = recipient_id
        obj.payload = {}

    mock_session.refresh.side_effect = _refresh

    # _agent_connections에 없음 → pending 유지
    payload = {
        "project_id": str(uuid.uuid4()),
        "event_type": "memo_created",
        "recipient_id": str(recipient_id),
        "recipient_type": "agent",
    }
    resp = await client.post("/api/v2/events", json=payload)
    assert resp.status_code == 201
    data = resp.json()
    assert data["status"] == "pending"


@pytest.mark.anyio
async def test_create_event_delivered_when_agent_connected(client, mock_session):
    """연결 중인 에이전트 recipient → dispatch_router가 SSE 큐에 페이로드 전달."""
    recipient_id = uuid.uuid4()
    member_id_str = str(recipient_id)

    # 에이전트 연결 등록
    queue: asyncio.Queue = asyncio.Queue(maxsize=10)
    _agent_connections[member_id_str] = {queue}  # set[Queue] 타입

    member_result = MagicMock()
    member_result.scalar_one_or_none.return_value = "agent"
    mock_session.execute.return_value = member_result

    async def _refresh(obj):
        obj.id = uuid.uuid4()
        obj.created_at = datetime.now(timezone.utc)
        obj.delivered_at = None
        obj.recipient_type = "agent"
        obj.org_id = uuid.uuid4()
        obj.project_id = uuid.uuid4()
        obj.event_type = "memo_created"
        obj.source_entity_type = None
        obj.source_entity_id = None
        obj.sender_id = None
        obj.recipient_id = recipient_id
        obj.payload = {}
        obj.status = "pending"

    mock_session.refresh.side_effect = _refresh

    from app.routers.events import _push_to_agent as real_push

    async def _mock_dispatch_bg(event_id):
        # dispatch routing을 mock하되, 큐에 직접 push하여 SSE 도달 시뮬레이션
        real_push(member_id_str, {"event_type": "memo_created", "event_id": str(event_id)})

    try:
        with patch("app.routers.events._route_dispatch_bg", new=_mock_dispatch_bg):
            payload = {
                "project_id": str(uuid.uuid4()),
                "event_type": "memo_created",
                "recipient_id": member_id_str,
                "recipient_type": "agent",
            }
            resp = await client.post("/api/v2/events", json=payload)
            assert resp.status_code == 201
            data = resp.json()
            # create_event는 pending 반환 (delivered 마킹은 SSE receive 시 수행)
            assert data["status"] == "pending"

            # SSE 큐에 페이로드 도달했는지 — background task 실행 대기
            await asyncio.sleep(0.05)
            assert not queue.empty()
            received = queue.get_nowait()
            assert received["event_type"] == "memo_created"
    finally:
        _agent_connections.pop(member_id_str, None)


# ─── AC4: 재연결 시 pending 이벤트 즉시 전달 ────────────────────────────────

def test_stream_delivers_pending_on_connect(mock_session, org_id):
    """SSE 연결 시 pending 이벤트 즉시 백필 전달됨."""
    from starlette.testclient import TestClient
    import threading
    from contextlib import asynccontextmanager

    member_id = uuid.uuid4()
    pending_event = _make_event(
        recipient_id=member_id,
        org_id=org_id,
        status="pending",
        event_type="memo_created",
        created_at=datetime.now(timezone.utc),
    )

    # 1st execute: member org 소속 검증 → member_id 반환
    # 2nd execute: pending 이벤트 조회
    membership_result = MagicMock()
    membership_result.scalar_one_or_none.return_value = member_id

    scalars_mock = MagicMock()
    scalars_mock.all.return_value = [pending_event]
    pending_result = MagicMock()
    pending_result.scalars.return_value = scalars_mock

    mock_session.execute.side_effect = [membership_result, pending_result]

    from app.dependencies.auth import get_current_user, get_verified_org_id, get_current_user_streaming, get_verified_org_id_streaming
    from app.dependencies.database import get_db
    from app.main import app

    async def _db():
        yield mock_session

    async def _auth():
        ctx = MagicMock()
        ctx.user_id = str(member_id)  # API key: user_id = team_member.id
        ctx.claims = {"app_metadata": {"api_key_id": "test-key", "org_id": str(org_id)}}
        return ctx

    async def _org():
        return org_id

    app.dependency_overrides[get_db] = _db
    app.dependency_overrides[get_current_user] = _auth
    app.dependency_overrides[get_verified_org_id] = _org
    app.dependency_overrides[get_current_user_streaming] = _auth
    app.dependency_overrides[get_verified_org_id_streaming] = _org

    @asynccontextmanager
    async def _session_factory():
        yield mock_session

    try:
        with patch("app.core.database.async_session_factory", _session_factory):
            with patch("app.routers.events._SSE_HEARTBEAT_TIMEOUT", 0.1):
                with TestClient(app, raise_server_exceptions=False) as c:
                    with c.stream("GET", f"/api/v2/events/stream?member_id={member_id}") as resp:
                        assert resp.status_code == 200
                        assert str(member_id) in _agent_connections

                        # sentinel을 inject하여 스트림 종료
                        def _inject():
                            import time; time.sleep(0.2)
                            for q in list(_agent_connections.get(str(member_id), set())):
                                try: q.put_nowait({"event_type": "__test_sentinel__"})
                                except: pass

                        t = threading.Thread(target=_inject)
                        t.start()
                        for line in resp.iter_lines():
                            if "__test_sentinel__" in line:
                                resp.close(); break
                        t.join(timeout=1.0)
    finally:
        app.dependency_overrides.clear()
        _agent_connections.pop(str(member_id), None)

    # pending 이벤트가 delivered로 마킹됐는지 (backfill 처리 확인)
    assert pending_event.status == "delivered"
    assert pending_event.delivered_at is not None


# ─── AC6: 동시 다수 에이전트 격리 ───────────────────────────────────────────

@pytest.mark.anyio
async def test_agent_isolation_multiple_connections():
    """서로 다른 에이전트는 각자의 큐만 수신해야 함."""
    agent_a = str(uuid.uuid4())
    agent_b = str(uuid.uuid4())

    queue_a: asyncio.Queue = asyncio.Queue(maxsize=10)
    queue_b: asyncio.Queue = asyncio.Queue(maxsize=10)
    _agent_connections[agent_a] = {queue_a}  # set[Queue] 타입
    _agent_connections[agent_b] = {queue_b}

    try:
        payload_a = {"event_type": "memo_created", "for": "agent_a"}
        payload_b = {"event_type": "memo_replied", "for": "agent_b"}

        _push_to_agent(agent_a, payload_a)
        _push_to_agent(agent_b, payload_b)

        received_a = queue_a.get_nowait()
        received_b = queue_b.get_nowait()

        assert received_a["for"] == "agent_a"
        assert received_b["for"] == "agent_b"
        assert queue_a.empty()
        assert queue_b.empty()
    finally:
        _agent_connections.pop(agent_a, None)
        _agent_connections.pop(agent_b, None)


@pytest.mark.anyio
async def test_stream_rejects_cross_org_member(mock_session, org_id):
    """다른 org의 member_id로 stream 연결 시 404 반환."""
    foreign_member_id = uuid.uuid4()

    # E-MEMBER-SSOT Phase 0: resolve_member_identity는 TeamMember(.scalars().first())
    # → OrgMember(.scalar_one_or_none()) 순으로 조회 — 둘 다 미소속이어야 404
    membership_result = MagicMock()
    membership_result.scalars.return_value.first.return_value = None  # TeamMember 미소속
    membership_result.scalar_one_or_none.return_value = None  # OrgMember 미소속
    mock_session.execute.return_value = membership_result

    from app.dependencies.auth import get_current_user, get_verified_org_id, get_current_user_streaming, get_verified_org_id_streaming
    from app.dependencies.database import get_db
    from app.main import app

    async def _db():
        yield mock_session

    async def _auth():
        ctx = MagicMock()
        ctx.user_id = str(uuid.uuid4())
        ctx.claims = {}
        return ctx

    async def _org():
        return org_id

    app.dependency_overrides[get_db] = _db
    app.dependency_overrides[get_current_user] = _auth
    app.dependency_overrides[get_verified_org_id] = _org
    app.dependency_overrides[get_current_user_streaming] = _auth
    app.dependency_overrides[get_verified_org_id_streaming] = _org

    from contextlib import asynccontextmanager

    @asynccontextmanager
    async def _session_factory():
        yield mock_session

    try:
        with patch("app.core.database.async_session_factory", _session_factory):
            async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as c:
                resp = await c.get(f"/api/v2/events/stream?member_id={foreign_member_id}")
                assert resp.status_code == 404
    finally:
        app.dependency_overrides.clear()
