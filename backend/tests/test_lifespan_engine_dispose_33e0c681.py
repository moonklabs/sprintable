"""S:33e0c681: 백엔드 graceful shutdown — lifespan 종료 시 engine.dispose() 호출 검증.

prod 인시던트 근본: main.py lifespan 이 shutdown 에서 SQLAlchemy 엔진을 dispose 하지 않아
Cloud Run 인스턴스 교체/스케일다운 시 풀 연결이 좀비로 남음 → 100 cap 초과 → TooManyConnections.
fix = lifespan 종료 경로에서 `await engine.dispose()`. 본 테스트는 (1) dispose 실제 호출
(2) 정상 startup→yield→shutdown 흐름 + pg_pubsub task 생명주기 유지 (3) pubsub task 가
예외로 끝나도 dispose 가 반드시 실행됨(좀비 박멸 보장) 을 검증한다.
"""
import asyncio
from unittest.mock import AsyncMock, MagicMock

import pytest


@pytest.fixture
def anyio_backend():
    return "asyncio"


def _patch_engine(monkeypatch):
    """app.core.database.engine 을 dispose 스파이가 달린 가짜 엔진으로 교체.

    lifespan 은 호출 시점에 `from app.core.database import engine` 로 가져오므로 모듈 속성
    교체로 충분(실 AsyncEngine setattr 제약 회피)."""
    fake_engine = MagicMock()
    fake_engine.dispose = AsyncMock()
    monkeypatch.setattr("app.core.database.engine", fake_engine)
    return fake_engine


@pytest.mark.anyio
async def test_lifespan_disposes_engine_on_shutdown(monkeypatch):
    """⚠️ 핵심(AC1): shutdown 경로서 engine.dispose() 가 정확히 1회 await 된다."""
    from app.main import lifespan

    fake_engine = _patch_engine(monkeypatch)

    started = asyncio.Event()

    async def fake_listen():
        started.set()
        try:
            await asyncio.Event().wait()  # cancel 까지 블록
        except asyncio.CancelledError:
            return

    monkeypatch.setattr("app.services.pg_pubsub.listen_loop", fake_listen)

    async with lifespan(MagicMock()):
        # startup: pubsub task 기동, 아직 dispose 안 됨(정상 흐름 유지)
        await asyncio.wait_for(started.wait(), timeout=1)
        fake_engine.dispose.assert_not_awaited()

    # shutdown 완료 → dispose 정확히 1회
    fake_engine.dispose.assert_awaited_once()


@pytest.mark.anyio
async def test_lifespan_cancels_pubsub_task_and_then_disposes(monkeypatch):
    """AC3 회귀: pg_pubsub task 가 shutdown 에서 취소되고(좀비 raw conn 없음) dispose 가 뒤따른다."""
    from app.main import lifespan

    fake_engine = _patch_engine(monkeypatch)

    running = asyncio.Event()
    state = {"cancelled": False, "dispose_seen_cancelled": None}

    async def fake_listen():
        running.set()
        try:
            await asyncio.Event().wait()
        except asyncio.CancelledError:
            state["cancelled"] = True
            raise

    monkeypatch.setattr("app.services.pg_pubsub.listen_loop", fake_listen)

    async def record_order(*_a, **_k):
        # dispose 시점에 pubsub 이 이미 취소됐는지 기록 → 순서(task 정리 후 dispose) 보장
        state["dispose_seen_cancelled"] = state["cancelled"]

    fake_engine.dispose.side_effect = record_order

    async with lifespan(MagicMock()):
        # task 가 실제로 기동(블록)할 때까지 대기 — cancel 이 의미를 갖도록
        await asyncio.wait_for(running.wait(), timeout=1)

    assert state["cancelled"] is True, "pg_pubsub task 가 취소되지 않음(좀비 raw conn 위험)"
    assert state["dispose_seen_cancelled"] is True, "dispose 가 task 정리보다 먼저 실행됨(순서 위반)"
    fake_engine.dispose.assert_awaited_once()


@pytest.mark.anyio
async def test_lifespan_disposes_even_if_pubsub_task_raises(monkeypatch):
    """⚠️ 좀비 박멸 보장: pubsub task 가 비-Cancelled 예외로 끝나도 dispose 는 반드시 실행된다
    (nested finally). dispose 누락이 곧 prod 연결 누수이므로 어떤 종료 경로서도 보장돼야 한다."""
    from app.main import lifespan

    fake_engine = _patch_engine(monkeypatch)

    failed = asyncio.Event()

    async def bad_listen():
        failed.set()
        raise RuntimeError("pubsub boom")

    monkeypatch.setattr("app.services.pg_pubsub.listen_loop", bad_listen)

    with pytest.raises(RuntimeError, match="pubsub boom"):
        async with lifespan(MagicMock()):
            # task 가 먼저 실행돼 예외로 종료되도록(취소가 선점하지 않게) 대기
            await asyncio.wait_for(failed.wait(), timeout=1)
            await asyncio.sleep(0)  # task 가 예외로 완전히 종료되게 양보

    fake_engine.dispose.assert_awaited_once()
