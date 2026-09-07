"""story #2295 — realtime_readiness 모듈 단위 테스트. 순수 상태기계, DB/네트워크 0."""
import asyncio
import time
from contextlib import asynccontextmanager
from unittest.mock import AsyncMock, patch

import pytest

pytestmark = pytest.mark.anyio


@pytest.fixture
def anyio_backend():
    return "asyncio"


@pytest.fixture(autouse=True)
def _reset_module_state():
    """모듈 레벨 전역이라 테스트 간 오염 방지 — 매 테스트 전후 리셋."""
    from app.services import realtime_readiness as rr
    rr._connected = False
    rr._disconnected_since = None
    rr._last_error = None
    yield
    rr._connected = False
    rr._disconnected_since = None
    rr._last_error = None


def test_initial_state_is_ready_not_yet_connected():
    """AC — 기동 직후(첫 연결 시도 前)는 fail-open으로 ready(정상 기동 유예)."""
    from app.services import realtime_readiness as rr

    healthy, detail = rr.is_ready()
    assert healthy is True
    assert detail["pg_listen"] == "not_yet_connected"


def test_connected_is_ready():
    from app.services import realtime_readiness as rr

    rr.mark_connected()
    healthy, detail = rr.is_ready()
    assert healthy is True
    assert detail["pg_listen"] == "connected"


def test_disconnected_within_grace_still_ready():
    """AC4 — 끊긴 직후(유예시간 안)는 아직 ready — backoff 재시도가 진행 중일 수 있어서
    반짝 끊김 한 번에 바로 UNHEALTHY로 flapping하지 않는다."""
    from app.services import realtime_readiness as rr

    rr.mark_connected()
    rr.mark_disconnected("ConnectionRefusedError: test")
    healthy, detail = rr.is_ready()
    assert healthy is True
    assert detail["pg_listen"] == "reconnecting"
    assert detail["last_error"] == "ConnectionRefusedError: test"


def test_disconnected_past_grace_is_not_ready(monkeypatch):
    """AC1 — 유예시간을 넘어서도 재연결 못 하면 UNHEALTHY. 실제로 30초를 기다리지 않고
    UNHEALTHY_GRACE_SECONDS를 낮춰 경계를 물린다."""
    from app.services import realtime_readiness as rr

    monkeypatch.setattr(rr, "UNHEALTHY_GRACE_SECONDS", 0.05)
    rr.mark_connected()
    rr.mark_disconnected("stale socket: bind: address already in use")
    time.sleep(0.1)
    healthy, detail = rr.is_ready()
    assert healthy is False
    assert detail["pg_listen"] == "disconnected"
    assert "stale socket" in detail["last_error"]


def test_reconnect_after_disconnect_clears_state():
    """연결이 끊겼다가 다시 성공하면 disconnected_since가 리셋된다(다음 끊김이 새 유예
    창을 받는다 — 누적되지 않음)."""
    from app.services import realtime_readiness as rr

    rr.mark_connected()
    rr.mark_disconnected("blip")
    assert rr._disconnected_since is not None
    rr.mark_connected()
    healthy, detail = rr.is_ready()
    assert healthy is True
    assert detail["pg_listen"] == "connected"
    assert rr._disconnected_since is None


# ─── story #3616 — run_active_probe_loop(): ③ 능동 프로브(트래픽·backplane 무관 신호원) ──

class _FakeConn:
    def __init__(self, *, fail: bool = False):
        self._fail = fail

    async def execute(self, *args, **kwargs):
        if self._fail:
            raise ConnectionRefusedError("probe: simulated DB down")


class _FakeEngine:
    def __init__(self, *, fail: bool = False):
        self._fail = fail

    @asynccontextmanager
    async def connect(self):
        yield _FakeConn(fail=self._fail)


async def _run_one_iteration_then_cancel(interval_seconds: float = 999.0):
    """루프 첫 반복(engine.connect→execute→mark_*)이 끝나고 asyncio.sleep에 진입하는
    순간을 asyncio.sleep을 스파이해서 잡는다 — 그 시점에 태스크를 취소해 정확히
    "1회 반복"만 관측한다(sleep 값 자체는 크게 둬서 자연 만료로 테스트가 오염되지 않게)."""
    from app.services import realtime_readiness as rr

    entered_sleep = asyncio.Event()
    real_sleep = asyncio.sleep

    async def _spy_sleep(seconds):
        entered_sleep.set()
        await real_sleep(seconds)

    task = asyncio.create_task(rr.run_active_probe_loop(interval_seconds))
    with patch("asyncio.sleep", side_effect=_spy_sleep):
        await asyncio.wait_for(entered_sleep.wait(), timeout=1.0)
    task.cancel()
    try:
        await task
    except asyncio.CancelledError:
        pass


async def test_active_probe_success_marks_connected():
    from app.services import realtime_readiness as rr

    with patch("app.core.database.engine", new=_FakeEngine(fail=False)):
        await _run_one_iteration_then_cancel()

    assert rr._connected is True


async def test_active_probe_failure_marks_disconnected_without_crashing_loop():
    """AC — DB 왕복 실패해도 예외가 루프를 죽이면 안 된다(그러면 ③ 신호가 영구
    소실돼 반쪽 처방이 된다) — mark_disconnected만 호출되고 태스크는 다음 sleep으로
    넘어가 살아있어야 한다(취소 전까지 CancelledError 외엔 절대 안 죽음)."""
    from app.services import realtime_readiness as rr

    with patch("app.core.database.engine", new=_FakeEngine(fail=True)):
        await _run_one_iteration_then_cancel()

    assert rr._connected is False
    assert rr._last_error is not None and "ConnectionRefusedError" in rr._last_error


async def test_active_probe_cancellation_is_not_swallowed():
    """루프 자체가 CancelledError를 삼키면 lifespan finally의 await가 영원히 안
    끝난다(다른 세 태스크와 동형 계약) — 취소가 정상적으로 전파돼야 한다. 실 DB
    엔진에 기대지 않도록(reachability에 따라 flaky해지는 것 방지) 성공 스텁으로 고정."""
    from app.services import realtime_readiness as rr

    with patch("app.core.database.engine", new=_FakeEngine(fail=False)):
        task = asyncio.create_task(rr.run_active_probe_loop(999.0))
        await asyncio.sleep(0.05)
        task.cancel()
        with pytest.raises(asyncio.CancelledError):
            await task


async def test_active_probe_uses_short_lived_connection_not_persistent():
    """engine.connect()가 매 반복 새로 호출되는지(커넥션을 계속 들고 있지 않는지) —
    async with 블록을 벗어나면 연결이 반환된다는 것을 스파이로 확인."""
    from app.services import realtime_readiness as rr

    connect_call_count = 0
    real_connect = _FakeEngine.connect

    class _CountingEngine(_FakeEngine):
        def connect(self):
            nonlocal connect_call_count
            connect_call_count += 1
            return real_connect(self)

    with patch("app.core.database.engine", new=_CountingEngine(fail=False)):
        await _run_one_iteration_then_cancel()

    assert connect_call_count == 1, "1회 반복에 connect()가 정확히 1번만 불려야 한다(상주 연결 금지)"
