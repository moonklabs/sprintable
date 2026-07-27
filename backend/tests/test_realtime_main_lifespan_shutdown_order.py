"""story #2089(2026-07-25, 오르테가군 지시) — `app/realtime_main.py`가
`test_no_unreferenced_fire_and_forget.py`의 허용목록에 들어간 근거(main.py와 동일한
"로컬변수 보관 + lifespan finally에서 cancel()+await로 명시 추적" 패턴)가 **지금도 참인지**
실행으로 지킨다.

허용목록은 "그때 사람이 코드를 봤다"는 선언일 뿐이라, 이 파일이 나중에 바뀌면 그 선언이
조용히 거짓이 될 수 있다(#2174가 "until 만료"로 지키는 것과 같은 필요 — 여기서는 "패턴이
유지되는가"를 실행으로 지킨다). 검증 대상: 백그라운드 루프 태스크의 취소가 반드시
`engine.dispose()` **前에** 일어나는 것(오늘 하루 세운 순서 — cancel→await→dispose. 순서가
깨지면 아직 도는 루프가 이미 dispose된 엔진의 커넥션을 쓰려는 레이스가 생긴다).
"""
from __future__ import annotations

import asyncio
from unittest.mock import AsyncMock, patch

import pytest

pytestmark = pytest.mark.anyio


@pytest.fixture
def anyio_backend():
    return "asyncio"


class _FakeEngine:
    """AsyncEngine.dispose는 슬롯 속성이라 개별 메서드 patch가 안 됨(AttributeError:
    read-only) — 엔진 객체 전체를 대체한다."""

    def __init__(self, on_dispose=None):
        self._on_dispose = on_dispose

    async def dispose(self):
        if self._on_dispose is not None:
            await self._on_dispose()


async def test_listen_loop_cancelled_before_engine_dispose():
    """listen_loop()의 취소(cancellation)가 engine.dispose() 호출보다 먼저 관측돼야 한다."""
    import app.realtime_main as rm

    call_order: list[str] = []

    async def _fake_listen_loop():
        try:
            await asyncio.Event().wait()  # 영원히 대기 — 취소돼야만 빠져나감
        except asyncio.CancelledError:
            call_order.append("listen_loop_cancelled")
            raise

    async def _fake_dispose():
        call_order.append("engine_dispose")

    with patch("app.services.event_broker.resolve_backplane", return_value="pg"), \
         patch("app.services.pg_pubsub.check_listen_config", return_value=None), \
         patch("app.services.pg_pubsub.listen_loop", side_effect=_fake_listen_loop), \
         patch("app.services.event_broker.check_outbox_dual_publish_config", return_value=None), \
         patch("app.core.database.engine", new=_FakeEngine(_fake_dispose)):
        async with rm.realtime_lifespan(rm.app):
            # startup 완료 — listen_task가 실제로 생성돼 _fake_listen_loop에서 대기 중이어야 함.
            await asyncio.sleep(0)
        # realtime_lifespan의 __aexit__(= finally 블록)이 여기서 이미 실행 완료됨.

    assert "listen_loop_cancelled" in call_order, (
        "listen_loop가 취소되지 않았다 — lifespan finally가 태스크 참조를 잃었을 가능성"
    )
    assert "engine_dispose" in call_order
    assert call_order.index("listen_loop_cancelled") < call_order.index("engine_dispose"), (
        f"순서 위반 — engine.dispose()가 listen_loop 취소보다 먼저(또는 동시에) 일어남: {call_order}. "
        "아직 도는 루프가 이미 dispose된 엔진의 커넥션을 쓰려는 레이스 위험."
    )


async def test_all_three_background_tasks_are_referenced_and_awaited():
    """listen_task/redis_shadow_task/outbox_dispatcher_task 셋 다 실제로 취소·await되는지
    (백그라운드 루프가 셋 다 켜진 조합에서) — 하나라도 참조를 잃으면 그 루프만 GC 조기수거
    위험에 노출된다."""
    import app.realtime_main as rm

    cancelled: set[str] = set()

    def _tracked_loop(name: str):
        async def _loop():
            try:
                await asyncio.Event().wait()
            except asyncio.CancelledError:
                cancelled.add(name)
                raise
        return _loop

    with patch("app.services.event_broker.resolve_backplane", return_value="pg"), \
         patch("app.services.pg_pubsub.check_listen_config", return_value=None), \
         patch("app.services.pg_pubsub.listen_loop", side_effect=_tracked_loop("listen")), \
         patch("app.services.event_broker.check_outbox_dual_publish_config", return_value=None), \
         patch("app.core.config.settings.event_broker_redis_dual_publish_enabled", True), \
         patch("app.core.config.settings.event_broker_redis_consume_enabled", True), \
         patch("app.services.event_broker.redis_consume_loop", side_effect=_tracked_loop("redis_shadow")), \
         patch("app.core.config.settings.event_broker_outbox_enabled", True), \
         patch("app.services.event_broker.outbox_dispatcher_loop", side_effect=_tracked_loop("outbox")), \
         patch("app.core.database.engine", new=_FakeEngine()):
        async with rm.realtime_lifespan(rm.app):
            await asyncio.sleep(0)

    assert cancelled == {"listen", "redis_shadow", "outbox"}, (
        f"일부 백그라운드 루프가 취소되지 않음(GC 조기수거 위험) — cancelled={cancelled}"
    )
