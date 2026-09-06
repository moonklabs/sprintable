"""E-EVENTBUS S2: MCP Streamable HTTP SSE 푸시 구현 테스트."""
from __future__ import annotations

import asyncio
import time
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


async def _wait_until(predicate, *, timeout: float = 5.0, interval: float = 0.005) -> bool:
    """story #3580(근본원인, 페드루 PO 確定 2026-09-06) — 이 파일의 threading.Thread
    injector 재작성이 쓰는 유일한 폴링 축. #3494에서 threading.Thread + time.sleep로
    구현했던 게 진짜 플레이키 근원이었다 — `asyncio.Queue.put_nowait`/`asyncio.Event.
    set()`은 이벤트 루프를 도는 **바로 그 스레드**에서 불려야 대기자(waiter)에게
    안전하게 통지된다는 게 asyncio의 계약인데, 별도 OS 스레드(injector)가 그 두
    프리미티브를 직접 건드리고 있었다 — 대개는 우연히 동작하지만 CI 러너가 붐빌 때
    (오늘 FE-only PR 2건과 동시 실행 등, GIL/스레드 스케줄링 타이밍이 달라지는 조건)
    통지가 늦게 도착하거나 씹혀 폴링이 데드라인을 넘겨 조용히 flaky해진다 — 실 결함이
    스레드 재작성 자체가 아니라 "asyncio 프리미티브를 그 이벤트 루프의 스레드 밖에서
    건드린 것"이었다는 뜻(그 자리에 `loop.call_soon_threadsafe`를 끼워도 고칠 수
    있었겠지만, 이 테스트엔 실 스레드가 아예 필요 없다 — SSE 제너레이터가 시작한 스트림
    응답 자체를 `asyncio.create_task()`로 감싸면, injector 로직도 같은 이벤트 루프
    위의 평범한 코루틴이 되어 매 `await` 지점마다 협조적으로 스케줄링된다 — 스레드도
    락도 `call_soon_threadsafe`도 필요 없어진다, ASGITransport가 앱 콜러블 전체가
    끝나야 응답을 돌려준다는 #3494의 제약은 그대로지만 이제 그게 문제가 안 된다:
    `client.get(...)`을 태스크로 띄워두고 메인 코루틴이 `_agent_connections`/큐 상태를
    `await asyncio.sleep(interval)`로 협조적으로 재확인하다가, 관찰되면 그제서야
    `shutdown_event.set()`으로 제너레이터를 정상 종료시켜 그 태스크가 완주하게 한다.

    타임아웃 5.0s(원래 1.0s)로 실측 상향 — 이 재작성판 자체도 로컬에서 다른 pytest
    프로세스와 동시 실행되는 조건(이 파일 자체를 3-way 동시 20회씩 돌린 재현 실험)
    아래서 20회 중 5회 연속 실패가 실제로 재현됐다(재현 로그: 격리 실행 20/20·30/30
    green, 겹쳐 돈 구간에서만 실패 — 스레드 안전성 결함이 아니라 순수 스케줄링
    지연이 1.0s 예산을 넘긴 것, 재현 후 이 코루틴 자신의 이벤트 루프가 잠깐 CPU를
    못 받아도 흡수할 여유를 5배로 늘렸다). 프로세스 스케줄링 지연을 흡수하는 자리라
    "왜 5.0s인지"는 코드가 아니라 이 재현 실험이 근거다 — CI 잡 전체 타임아웃(분 단위)
    에 비하면 무시할 수 있는 상한."""
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        if predicate():
            return True
        await asyncio.sleep(interval)
    return predicate()


@pytest.mark.anyio
async def test_agent_stream_registers_connection(mock_session, org_id):
    """GET /api/v2/events/stream 연결 시 _agent_connections에 등록됨.

    story #3494(1차 근본원인) — ASGITransport/TestClient 둘 다 앱 콜러블이 완전히
    끝날 때까지 응답을 안 돌려준다(httpx._transports.asgi.ASGITransport.
    handle_async_request 소스 확認 — `await self.app(...)`가 끝나야 Response가
    생성된다). "응답을 받은 뒤 등록을 확認"하는 구조 자체가 성립 불가능해 "등록 관찰"과
    "종료 후 결과 확認"을 분리해야 한다는 처방은 그대로 옳았다.

    story #3580(2차 근본원인, 페드루 PO 確定 2026-09-06) — 그 분리를 별도 OS
    threading.Thread injector로 구현한 게 재발의 진짜 원인이었다(`_wait_until`
    docstring 참조). 처방: 스트림 요청을 `asyncio.create_task()`로 같은 이벤트
    루프 위에 띄우고, injector도 평범한 async 코루틴으로 만든다 — 스레드 0개."""
    member_id = uuid.uuid4()
    member_id_str = str(member_id)

    # 1st execute: member org 소속 검증 → member_id 반환
    # 2nd execute: pending 이벤트 조회 → 빈 목록
    membership_result = MagicMock()
    membership_result.scalar_one_or_none.return_value = member_id

    scalars_mock = MagicMock()
    scalars_mock.all.return_value = []
    pending_result = MagicMock()
    pending_result.scalars.return_value = scalars_mock

    mock_session.execute.side_effect = [membership_result, pending_result]

    from app.core import shutdown as shutdown_module
    from app.dependencies.auth import get_current_user, get_verified_org_id, get_current_user_streaming, get_verified_org_id_streaming
    from app.dependencies.database import get_db
    from app.main import app

    async def _db():
        yield mock_session

    async def _auth():
        ctx = MagicMock()
        ctx.user_id = member_id_str  # API key: user_id = team_member.id
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

    registered_observed = False
    consumed_observed = False
    body = ""
    try:
        with patch("app.core.database.async_session_factory", _session_factory):
            with patch("app.routers.events._SSE_HEARTBEAT_TIMEOUT", 0.1):
                async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as c:
                    stream_task = asyncio.create_task(
                        c.get(f"/api/v2/events/stream?member_id={member_id}")
                    )
                    registered_observed = await _wait_until(lambda: member_id_str in _agent_connections)
                    queues = list(_agent_connections.get(member_id_str, set())) if registered_observed else []
                    for q in queues:
                        q.put_nowait({"event_type": "__test_sentinel__"})
                    if queues:
                        consumed_observed = await _wait_until(lambda: all(q.empty() for q in queues))
                    shutdown_module.shutdown_event.set()
                    resp = await asyncio.wait_for(stream_task, timeout=5.0)
                    assert resp.status_code == 200
                    body = resp.text
    finally:
        app.dependency_overrides.clear()
        _agent_connections.pop(member_id_str, None)
        # story #3494(PO REQUIRED, 2026-09-05) — shutdown_event는 프로세스 전역이라
        # 이 테스트가 set()한 채로 남으면 다음 lifespan startup 前까지(또는 lifespan을
        # 안 타는 테스트라면 영영) 다른 테스트의 SSE 스트림까지 즉시 shutdown_reconnect로
        # 오판시킨다 — 명시로 되돌린다.
        shutdown_module.reset_shutdown_event()

    assert registered_observed, "injector never observed the connection in _agent_connections"
    assert consumed_observed, "generator never consumed the injected sentinel from its queue"
    assert "__test_sentinel__" in body
    assert member_id_str not in _agent_connections  # cleanup 계약 — 완주 뒤엔 반드시 비어야 함


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

@pytest.mark.anyio
async def test_stream_delivers_pending_on_connect(mock_session, org_id):
    """SSE 연결 시 pending 이벤트 즉시 백필 전달됨.

    story #3580 — test_agent_stream_registers_connection과 같은 근본원인·같은 처방
    (`_wait_until` docstring 참조 — injector를 threading.Thread가 아니라 같은
    이벤트 루프 위 코루틴으로 만들어 asyncio 프리미티브 cross-thread 위반을 없앤다)."""
    member_id = uuid.uuid4()
    member_id_str = str(member_id)
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

    from app.core import shutdown as shutdown_module
    from app.dependencies.auth import get_current_user, get_verified_org_id, get_current_user_streaming, get_verified_org_id_streaming
    from app.dependencies.database import get_db
    from app.main import app

    async def _db():
        yield mock_session

    async def _auth():
        ctx = MagicMock()
        ctx.user_id = member_id_str  # API key: user_id = team_member.id
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

    registered_observed = False
    consumed_observed = False
    body = ""
    try:
        with patch("app.core.database.async_session_factory", _session_factory):
            with patch("app.routers.events._SSE_HEARTBEAT_TIMEOUT", 0.1):
                async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as c:
                    stream_task = asyncio.create_task(
                        c.get(f"/api/v2/events/stream?member_id={member_id}")
                    )
                    registered_observed = await _wait_until(lambda: member_id_str in _agent_connections)
                    queues = list(_agent_connections.get(member_id_str, set())) if registered_observed else []
                    for q in queues:
                        q.put_nowait({"event_type": "__test_sentinel__"})
                    if queues:
                        consumed_observed = await _wait_until(lambda: all(q.empty() for q in queues))
                    shutdown_module.shutdown_event.set()
                    resp = await asyncio.wait_for(stream_task, timeout=5.0)
                    assert resp.status_code == 200
                    body = resp.text
    finally:
        app.dependency_overrides.clear()
        _agent_connections.pop(member_id_str, None)
        # story #3494(PO REQUIRED, 2026-09-05) — shutdown_event는 프로세스 전역이라
        # 이 테스트가 set()한 채로 남으면 다음 lifespan startup 前까지(또는 lifespan을
        # 안 타는 테스트라면 영영) 다른 테스트의 SSE 스트림까지 즉시 shutdown_reconnect로
        # 오판시킨다 — 명시로 되돌린다.
        shutdown_module.reset_shutdown_event()

    assert registered_observed, "injector never observed the connection in _agent_connections"
    assert consumed_observed, "generator never consumed the injected sentinel from its queue"
    assert "__test_sentinel__" in body
    assert member_id_str not in _agent_connections  # cleanup 계약

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
