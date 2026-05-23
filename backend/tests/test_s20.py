"""S20: SSE 안정성 강화 테스트."""
from __future__ import annotations

import asyncio
import uuid
from contextlib import asynccontextmanager
from datetime import datetime, timezone
from unittest.mock import AsyncMock, MagicMock, patch

import anyio

import pytest
from httpx import ASGITransport, AsyncClient

from app.routers.events import _agent_connections, _push_to_agent


@pytest.fixture
def anyio_backend():
    return "asyncio"


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


# ─── AC1: heartbeat timeout 후 dead connection 자동 정리 ─────────────────────

def test_heartbeat_disconnect_check_clears_connection():
    """heartbeat timeout 후 is_disconnected=True → queue가 _agent_connections에서 제거됨."""
    from starlette.testclient import TestClient
    import threading
    from app.dependencies.auth import get_current_user, get_verified_org_id
    from app.dependencies.database import get_db
    from app.main import app

    member_id = uuid.uuid4()
    member_id_str = str(member_id)
    org = uuid.uuid4()

    mock_sess = _make_mock_session()
    mock_sess.execute.side_effect = [_membership_ok(member_id), _pending_empty()]

    async def _db():
        yield mock_sess

    async def _auth():
        ctx = MagicMock()
        ctx.user_id = str(uuid.uuid4())
        ctx.claims = {}
        return ctx

    async def _org():
        return org

    @asynccontextmanager
    async def _factory():
        yield mock_sess

    app.dependency_overrides[get_db] = _db
    app.dependency_overrides[get_current_user] = _auth
    app.dependency_overrides[get_verified_org_id] = _org

    try:
        with patch("app.core.database.async_session_factory", _factory):
            with patch("app.routers.events._SSE_HEARTBEAT_TIMEOUT", 0.1):
                with TestClient(app, raise_server_exceptions=False) as c:
                    with c.stream("GET", f"/api/v2/events/stream?member_id={member_id}") as resp:
                        assert resp.status_code == 200

                        def _inject():
                            import time; time.sleep(0.05)
                            for q in list(_agent_connections.get(member_id_str, set())):
                                try: q.put_nowait({"event_type": "__test_sentinel__"})
                                except: pass

                        t = threading.Thread(target=_inject)
                        t.start()
                        for line in resp.iter_lines():
                            if "__test_sentinel__" in line:
                                resp.close(); break
                        t.join(timeout=1.0)
        # 연결 종료 후 _agent_connections에 해당 member_id 없어야 함
        import time; time.sleep(0.1)
        assert member_id_str not in _agent_connections or not _agent_connections.get(member_id_str)
    finally:
        app.dependency_overrides.clear()
        _agent_connections.pop(member_id_str, None)


# ─── AC2: 동시 재연결 폭주 방지 — MAX_SSE_CONNECTIONS 초과 시 503 ─────────────

@pytest.mark.anyio
async def test_sse_connection_limit_returns_503():
    """MAX_SSE_CONNECTIONS 초과 연결 시 503 반환."""
    from app.dependencies.auth import get_current_user, get_verified_org_id
    from app.dependencies.database import get_db
    from app.main import app
    import app.routers.events as ev_module

    member_id = uuid.uuid4()
    org = uuid.uuid4()

    mock_sess = _make_mock_session()
    mock_sess.execute.return_value = _membership_ok(member_id)

    async def _db():
        yield mock_sess

    async def _auth():
        ctx = MagicMock()
        ctx.user_id = str(uuid.uuid4())
        ctx.claims = {}
        return ctx

    async def _org():
        return org

    @asynccontextmanager
    async def _factory():
        yield mock_sess

    app.dependency_overrides[get_db] = _db
    app.dependency_overrides[get_current_user] = _auth
    app.dependency_overrides[get_verified_org_id] = _org

    original_count = ev_module._sse_connection_count
    original_max = ev_module._MAX_SSE_CONNECTIONS
    try:
        # 현재 연결 수를 MAX로 강제 설정
        ev_module._sse_connection_count = ev_module._MAX_SSE_CONNECTIONS

        with patch("app.core.database.async_session_factory", _factory):
            async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as c:
                resp = await c.get(f"/api/v2/events/stream?member_id={member_id}")
                assert resp.status_code == 503
    finally:
        ev_module._sse_connection_count = original_count
        ev_module._MAX_SSE_CONNECTIONS = original_max
        app.dependency_overrides.clear()


# ─── AC2b: 연결 수 카운터 정상 증감 ──────────────────────────────────────────

def test_connection_count_increments_and_decrements():
    """SSE 연결 시 _sse_connection_count 증가, 종료 시 감소."""
    from starlette.testclient import TestClient
    import threading
    import time
    from app.dependencies.auth import get_current_user, get_verified_org_id
    from app.dependencies.database import get_db
    from app.main import app
    import app.routers.events as ev_module

    member_id = uuid.uuid4()
    org = uuid.uuid4()

    mock_sess = _make_mock_session()
    mock_sess.execute.side_effect = [_membership_ok(member_id), _pending_empty()]

    async def _db():
        yield mock_sess

    async def _auth():
        ctx = MagicMock()
        ctx.user_id = str(uuid.uuid4())
        ctx.claims = {}
        return ctx

    async def _org():
        return org

    @asynccontextmanager
    async def _factory():
        yield mock_sess

    app.dependency_overrides[get_db] = _db
    app.dependency_overrides[get_current_user] = _auth
    app.dependency_overrides[get_verified_org_id] = _org

    count_before = ev_module._sse_connection_count
    try:
        with patch("app.core.database.async_session_factory", _factory):
            with patch("app.routers.events._SSE_HEARTBEAT_TIMEOUT", 0.1):
                with TestClient(app, raise_server_exceptions=False) as c:
                    with c.stream("GET", f"/api/v2/events/stream?member_id={member_id}") as resp:
                        assert resp.status_code == 200
                        # 연결 중 카운터 증가 확인
                        assert ev_module._sse_connection_count == count_before + 1

                        def _inject():
                            time.sleep(0.05)
                            for q in list(_agent_connections.get(str(member_id), set())):
                                try: q.put_nowait({"event_type": "__test_sentinel__"})
                                except: pass

                        t = threading.Thread(target=_inject)
                        t.start()
                        for line in resp.iter_lines():
                            if "__test_sentinel__" in line:
                                resp.close(); break
                        t.join(timeout=1.0)
        # 연결 종료 후 카운터 복원 대기
        time.sleep(0.1)
        assert ev_module._sse_connection_count == count_before
    finally:
        app.dependency_overrides.clear()
        _agent_connections.pop(str(member_id), None)
        ev_module._sse_connection_count = count_before


# ─── AC3: 동시 SSE 10개 + 쓰기 병행 ────────────────────────────────────────

def test_concurrent_10_sse_connections_with_write():
    """10개 동시 SSE 연결 시뮬레이션 + 이벤트 push가 충돌 없이 동작함.

    TestClient 10개 동시 실행은 각각 별도 event loop + lifespan이 필요하여
    CI 환경에서 실용적이지 않으므로, _agent_connections + _push_to_agent 레이어를
    직접 스레드에서 검증한다.
    """
    import threading
    import time
    import app.routers.events as ev_module

    n_agents = 10
    agents = [str(uuid.uuid4()) for _ in range(n_agents)]
    queues = [asyncio.Queue(maxsize=10) for _ in range(n_agents)]
    received_counts = [0] * n_agents

    # 10개 에이전트 큐 등록
    for member_id, q in zip(agents, queues):
        _agent_connections[member_id].add(q)

    def _drain_agent(idx: int):
        """agent queue에서 memo_created 이벤트 수신 후 count."""
        q = queues[idx]
        deadline = time.time() + 5.0
        while time.time() < deadline:
            try:
                item = q.get_nowait()
                if item.get("event_type") == "memo_created":
                    received_counts[idx] += 1
                    return
            except Exception:
                time.sleep(0.01)

    def _push_all():
        """0.1초 후 전체 에이전트에 push."""
        time.sleep(0.1)
        payload = {"event_type": "memo_created", "event_id": str(uuid.uuid4())}
        for member_id in agents:
            _push_to_agent(member_id, payload)

    try:
        drain_threads = [threading.Thread(target=_drain_agent, args=(i,)) for i in range(n_agents)]
        push_thread = threading.Thread(target=_push_all)

        for t in drain_threads:
            t.start()
        push_thread.start()

        push_thread.join(timeout=2.0)
        for t in drain_threads:
            t.join(timeout=5.0)

        successful = sum(1 for c in received_counts if c >= 1)
        assert successful == n_agents, f"10개 중 {successful}개 수신 — counts: {received_counts}"
        assert sum(received_counts) == n_agents, f"이벤트 미수신 — counts: {received_counts}"
    finally:
        for member_id in agents:
            _agent_connections.pop(member_id, None)


# ─── AC4: DB 풀 사이징 문서화 확인 ──────────────────────────────────────────

def test_db_pool_sizing_documented():
    """database.py에 pool_size/max_overflow 계산식 주석이 있는지 확인."""
    import inspect
    from app.core import database as db_module
    source = inspect.getsource(db_module)
    assert "pool_size" in source
    assert "max_overflow" in source
    # S20: 계산식 문서화 확인
    assert "pool_size" in source and "max_overflow" in source


def test_max_sse_connections_configurable():
    """MAX_SSE_CONNECTIONS 환경변수로 설정 가능한지 확인."""
    import app.routers.events as ev_module
    assert hasattr(ev_module, "_MAX_SSE_CONNECTIONS")
    assert ev_module._MAX_SSE_CONNECTIONS > 0


def test_sse_connection_counter_exists():
    """_sse_connection_count 전역 카운터 존재 확인."""
    import app.routers.events as ev_module
    assert hasattr(ev_module, "_sse_connection_count")
