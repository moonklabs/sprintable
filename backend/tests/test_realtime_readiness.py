"""story #2295 — realtime_readiness 모듈 단위 테스트. 순수 상태기계, DB/네트워크 0."""
import time

import pytest


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
