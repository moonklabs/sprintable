"""story c4c72eb1(E-ARCH GCE realtime-gateway 이전) PR-A: shutdown-aware SSE 종료.

이전에는 SIGTERM → graceful-shutdown 타이머 만료 → 강제 CancelledError로 SSE가
비정상 종료됐다. 이제는 전역 shutdown_event를 구독해 하트비트 주기(최대 30초)를
기다리지 않고 즉시 반응, 정리 이벤트(`shutdown_reconnect`)를 yield하고 **정상
return**한다 — EventSource가 깔끔한 스트림 종료로 인지해 즉시 재연결하도록.

PR-A 검증 범위: Cloud Run은 terminationGracePeriodSeconds=10 캡이 있어 graceful
timeout 확장 자체의 효과(오래 버티기)는 GCE(PR-B)에서만 열린다. 여기서 검증하는
건 "셧다운 신호에 즉시 반응해 정상 종료하는가"이지 "얼마나 오래 버티는가"가 아니다.

⚠️ shutdown_event.set()은 asyncio.Event라 스레드 세이프하지 않다 — 테스트에서 별도
threading.Thread로 트리거하면 TestClient의 내부 이벤트루프와 다른 스레드에서 건드리게
돼 신호가 전달되지 않는다(뮤테이션 셀프체크로 확認: 첫 시도는 이렇게 짜서 타임아웃
났다). AsyncClient + asyncio.create_task로 **같은 이벤트루프 안에서** 트리거한다.
"""
from __future__ import annotations

import asyncio
import time
import uuid
from contextlib import asynccontextmanager
from unittest.mock import AsyncMock, MagicMock, patch

import pytest
from httpx import ASGITransport, AsyncClient


@pytest.fixture
def anyio_backend():
    return "asyncio"


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


def test_reset_shutdown_event_creates_new_object_each_call():
    """asyncio.Event는 최초 wait()/set() 시점의 실행 루프에 바인딩되므로, lifespan startup마다
    객체 자체를 교체해야 한다(단순 .clear()는 이전 루프 바인딩이 남아 다른 루프에서
    RuntimeError — 뮤테이션 셀프체크로 재현됨). reset_shutdown_event()가 진짜 새 객체를
    만드는지(같은 객체를 재사용하며 clear만 하는 게 아닌지) 직접 확認."""
    from app.core import shutdown as shutdown_module

    first = shutdown_module.shutdown_event
    shutdown_module.reset_shutdown_event()
    second = shutdown_module.shutdown_event
    assert first is not second, "reset_shutdown_event가 객체를 재생성하지 않음(동일 인스턴스 재사용)"
    assert not second.is_set()


@pytest.mark.anyio
async def test_sse_stream_reacts_to_shutdown_signal_immediately_and_closes_cleanly():
    """전역 shutdown_event.set() 시 SSE가 하트비트 타임아웃(길게 설정)을 기다리지 않고
    즉시 shutdown_reconnect 이벤트를 내보내고 스트림을 정상 종료하는지 실측.

    ASGITransport/TestClient를 거치면 라이브러리 내부 스케줄링과 얽혀 트리거 태스크가
    굶는 현상이 있었다(뮤테이션 셀프체크로 확認) — 라우트 함수를 직접 호출해 반환된
    StreamingResponse의 body_iterator를 이 테스트 코루틴에서 직접 펌프하는 방식으로
    ASGI 계층을 완전히 우회한다(검증 대상인 generate() 로직 자체는 동일).
    """
    from app.core import shutdown as shutdown_module
    import app.routers.events as ev_module

    member_id = uuid.uuid4()
    org = uuid.uuid4()

    mock_sess = _make_mock_session()
    mock_sess.execute.side_effect = [_membership_ok(member_id), _pending_empty()]

    @asynccontextmanager
    async def _factory():
        yield mock_sess

    class _FakeRequest:
        headers: dict = {}

        async def is_disconnected(self) -> bool:
            return False

    auth_ctx = MagicMock()
    auth_ctx.user_id = str(member_id)
    auth_ctx.claims = {"app_metadata": {"api_key_id": "test-key", "org_id": str(org)}}

    count_before = ev_module._sse_connection_count
    saw_shutdown_event = False
    elapsed = None
    try:
        with patch("app.core.database.async_session_factory", _factory):
            with patch.object(ev_module, "_SSE_HEARTBEAT_TIMEOUT", 30.0):
                response = await ev_module.agent_event_stream(
                    request=_FakeRequest(),
                    member_id=None,
                    auth=auth_ctx,
                    org_id=org,
                    since_timestamp=None,
                    last_event_id=None,
                )
                assert ev_module._sse_connection_count == count_before + 1

                async def _trigger_shutdown():
                    await asyncio.sleep(0.1)
                    shutdown_module.shutdown_event.set()

                trigger_task = asyncio.create_task(_trigger_shutdown())
                started = time.monotonic()

                # break 없이 끝까지 소진 — generate()가 shutdown_reconnect yield 후 스스로
                # return(정상 종료)해 StopAsyncIteration으로 자연 종료돼야 finally(카운터
                # 정리)가 실행된다. 중간에 break하면 아직 return에 안 닿아 정리가 안 된다.
                async for chunk in response.body_iterator:
                    if "shutdown_reconnect" in chunk:
                        saw_shutdown_event = True
                elapsed = time.monotonic() - started
                await trigger_task

        assert saw_shutdown_event, "shutdown_reconnect 이벤트가 스트림에 안 실림"
        # 하트비트 타임아웃(30초)을 기다리지 않고 즉시(수 초 내) 반응했는지 — PR-A의 핵심 주장.
        assert elapsed is not None and elapsed < 5.0, (
            f"shutdown 신호 반응이 너무 느림({elapsed}s) — 즉시 반응이어야 함"
        )
        await asyncio.sleep(0.1)
        assert ev_module._sse_connection_count == count_before, "shutdown 후 카운터 정리 안 됨"
    finally:
        ev_module._agent_connections.pop(str(member_id), None)
        ev_module._sse_connection_count = count_before
        shutdown_module.reset_shutdown_event()
