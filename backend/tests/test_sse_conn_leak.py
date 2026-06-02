"""P0 dev DB connection leak (#abaf6279) 회귀 가드.

근본 원인: get_current_user/get_verified_org_id가 Depends(get_db)로 요청 수명 동안
세션을 점유 → SSE long-lived yield 구간에 API key 해석 team_members 쿼리 커넥션이
idle-in-transaction 잔존 → max_connections 포화.

수정: SSE 전용 비점유 변형(get_current_user_streaming / get_verified_org_id_streaming)이
자체 단명 세션을 써서 즉시 닫음.

추가: 1c22da3e — 백필/라이브 delivered 선마킹 → 후마킹 (yield 실패 시 영구 누락 방지).
"""
from __future__ import annotations

import inspect
import uuid
from unittest.mock import AsyncMock, MagicMock, patch

import pytest


@pytest.fixture
def anyio_backend():
    return "asyncio"


# ─── CP1: SSE 핸들러가 비점유 streaming auth dep을 사용 ────────────────────────

def test_agent_event_stream_uses_streaming_auth_deps():
    """events.agent_event_stream이 get_db 점유형 dep을 쓰지 않고 streaming 변형을 쓴다."""
    from app.routers import events
    sig = inspect.signature(events.agent_event_stream)
    src = inspect.getsource(events.agent_event_stream)
    # streaming 변형 사용 + 점유형 dep 미사용
    assert "get_current_user_streaming" in src, "SSE는 비점유 auth(get_current_user_streaming) 사용 필수"
    assert "get_verified_org_id_streaming" in src, "SSE는 비점유 org dep(get_verified_org_id_streaming) 사용 필수"
    # 직접 get_db 주입 금지
    assert "Depends(get_db)" not in src, "SSE 핸들러는 get_db를 요청 수명 동안 점유하면 안 됨"


def test_agent_gateway_stream_uses_streaming_auth_dep():
    """agent_gateway.agent_stream(SSE)도 비점유 streaming auth 사용 (#abaf6279 후속).

    잔존 leak: agent_stream이 get_current_user(get_db 점유)를 쓰면 API key 해석
    team_members 쿼리 커넥션이 SSE 수명 내내 idle-in-transaction 잔존.
    """
    from app.routers import agent_gateway
    src = inspect.getsource(agent_gateway.agent_stream)
    assert "get_current_user_streaming" in src, "agent SSE 스트림은 비점유 auth 사용 필수"
    assert "Depends(get_current_user)" not in src, "agent SSE 스트림은 점유형 get_current_user 금지"


# ─── CP1: streaming auth dep이 get_db를 파라미터로 받지 않음 (비점유 보장) ──────

def test_streaming_auth_deps_do_not_depend_on_get_db():
    """get_current_user_streaming / get_verified_org_id_streaming 시그니처에 get_db 없음."""
    from app.dependencies import auth
    for fn_name in ("get_current_user_streaming", "get_verified_org_id_streaming"):
        fn = getattr(auth, fn_name)
        params = inspect.signature(fn).parameters
        for p in params.values():
            default = p.default
            # Depends(get_db) 가 기본값으로 들어있으면 안 됨
            dep_str = repr(default)
            assert "get_db" not in dep_str, f"{fn_name}.{p.name} 가 get_db를 점유하면 안 됨"
        # 본문은 자체 단명 세션(async with async_session_factory) 사용
        src = inspect.getsource(fn)
        assert "async_session_factory()" in src, f"{fn_name}은 자체 단명 세션을 써야 함"


# ─── CP1: API key 경로에서 세션이 즉시 close 되는지 (점유 0) ───────────────────

@pytest.mark.anyio
async def test_streaming_auth_api_key_closes_session():
    """get_current_user_streaming API key 경로 — _resolve_api_key 후 세션 context 종료."""
    from app.dependencies import auth

    closed = {"v": False}

    class _FakeSession:
        async def __aenter__(self):
            return AsyncMock()
        async def __aexit__(self, *a):
            closed["v"] = True
            return False

    fake_ctx = MagicMock()
    with patch.object(auth, "async_session_factory", return_value=_FakeSession()), \
         patch.object(auth, "_resolve_api_key", new=AsyncMock(return_value=fake_ctx)) as mock_resolve:
        result = await auth.get_current_user_streaming(
            credentials=None, x_agent_api_key="sk_live_abc",
        )
    assert result is fake_ctx
    mock_resolve.assert_awaited_once()
    assert closed["v"] is True, "API key 해석 후 세션이 즉시 close 되어야 함 (점유 0)"


# ─── CP3 (1c22da3e): 백필/라이브 delivered 후마킹 순서 ─────────────────────────

def test_backfill_marks_delivered_after_yield():
    """백필: yield 후 delivered 마킹 (선마킹 시 yield 실패→영구 누락)."""
    from app.routers import events
    src = inspect.getsource(events.agent_event_stream)
    # yield 라인이 'status = "delivered"' 보다 먼저 와야 함 (후마킹)
    yield_idx = src.find('is_backfill\': True')
    mark_idx = src.find('evt.status = "delivered"')
    assert yield_idx != -1 and mark_idx != -1
    assert yield_idx < mark_idx, "백필 delivered 마킹은 yield 이후여야 함 (1c22da3e)"


def test_live_marks_delivered_after_yield():
    """라이브: yield 후 delivered 마킹 (선마킹 시 yield 실패→영구 누락)."""
    from app.routers import events
    src = inspect.getsource(events.agent_event_stream)
    # 라이브 yield(_live_id 사용) 가 update(Event)...delivered 마킹보다 먼저
    yield_idx = src.find('id: {_live_id}')
    # 라이브 후마킹 블록 (update + values status delivered)
    mark_idx = src.find('.values(status="delivered"')
    assert yield_idx != -1 and mark_idx != -1
    assert yield_idx < mark_idx, "라이브 delivered 마킹은 yield 이후여야 함 (1c22da3e)"
