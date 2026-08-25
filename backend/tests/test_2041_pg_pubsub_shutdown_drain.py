"""story #2041(그라운딩 doc 67b44d1e, PR-A) — pg_pubsub.drain_background_tasks() 회귀가드.

핵심 검증축:
①미완료 fire_and_forget 태스크가 dispose()보다 먼저 drain(대기/취소)된다(순서 위반=레이스).
②timeout 안에 끝나면 정상 완료를 기다린다(불필요한 cancel 없음).
③timeout을 넘기면 cancel한다(영구 대기 금지).
④스냅샷 의미 — drain 진입 시점의 task만 대상. 그 뒤 추가된 task는 이번 호출이 기다리지 않는다
  (페드루 PO 지시 ① 반영, 무한정 확장 방지).
⑤`_background_tasks`가 비어 있으면 즉시 반환(no-op, sleep/wait 없음).
"""
from __future__ import annotations

import asyncio

import pytest

pytestmark = pytest.mark.anyio


@pytest.fixture
def anyio_backend():
    return "asyncio"


@pytest.fixture(autouse=True)
def _clean_background_tasks():
    """모듈 전역 set — 테스트 간 오염 방지(다른 테스트 파일이 fire_and_forget을 실제로 썼다면
    잔여 task가 있을 수 있음)."""
    from app.services import pg_pubsub
    pg_pubsub._background_tasks.clear()
    yield
    pg_pubsub._background_tasks.clear()


async def test_drain_awaits_pending_task_that_finishes_within_timeout():
    from app.services import pg_pubsub

    finished = asyncio.Event()

    async def _quick():
        await asyncio.sleep(0.01)
        finished.set()

    pg_pubsub.fire_and_forget(_quick())
    assert len(pg_pubsub._background_tasks) == 1

    await pg_pubsub.drain_background_tasks(timeout=1.0)

    assert finished.is_set(), "timeout 안에 끝나는 태스크는 정상 완료까지 기다려야 한다"
    assert len(pg_pubsub._background_tasks) == 0


async def test_drain_cancels_task_that_exceeds_timeout():
    from app.services import pg_pubsub

    cancelled = asyncio.Event()

    async def _forever():
        try:
            await asyncio.Event().wait()
        except asyncio.CancelledError:
            cancelled.set()
            raise

    pg_pubsub.fire_and_forget(_forever())

    await pg_pubsub.drain_background_tasks(timeout=0.05)

    assert cancelled.is_set(), "timeout을 넘긴 태스크는 cancel돼야 한다(영구 대기 금지)"


async def test_drain_no_op_when_no_pending_tasks():
    """빈 set이면 즉시 반환 — asyncio.wait([])는 ValueError이므로 이 가드가 실제로 의미 있다."""
    from app.services import pg_pubsub

    assert len(pg_pubsub._background_tasks) == 0
    await pg_pubsub.drain_background_tasks(timeout=1.0)  # ValueError 나면 여기서 실패


async def test_drain_snapshot_ignores_tasks_added_after_drain_started():
    """④ — drain 진입 시점 이후 추가된 task는 같은 호출이 기다리지 않는다(스냅샷 의미)."""
    from app.services import pg_pubsub

    late_task_added = asyncio.Event()
    late_finished = asyncio.Event()

    async def _late():
        await asyncio.sleep(0.03)
        late_finished.set()

    async def _early():
        # drain이 스냅샷을 뜬 뒤(대기 진입 후) 새 task를 추가 — 이번 drain 호출 대상에 안 들어가야 함.
        await asyncio.sleep(0.005)
        pg_pubsub.fire_and_forget(_late())
        late_task_added.set()

    pg_pubsub.fire_and_forget(_early())

    await pg_pubsub.drain_background_tasks(timeout=1.0)

    assert late_task_added.is_set(), "_early가 끝나 _late를 추가했어야 한다"
    # drain 호출은 이미 반환했다 — _late는 그 반환 시점에 끝나 있지 않았을 수 있다(스냅샷 밖).
    assert pg_pubsub._background_tasks, (
        "스냅샷 밖에서 추가된 _late 태스크는 이번 drain이 기다리지 않아 아직 set에 남아 있어야 한다"
    )
    await late_finished.wait()  # 정리 — 다음 테스트로 pending 태스크가 새지 않게.


async def test_shutdown_drains_before_dispose_end_to_end(monkeypatch):
    """①/③ 통합 — main.lifespan 실제 shutdown 경로에서 drain이 engine.dispose()보다 먼저
    관측된다. test_lifespan_engine_dispose_33e0c681.py의 _FakeEngine 패턴 재사용."""
    from unittest.mock import AsyncMock, MagicMock

    from app.main import lifespan
    from app.services import pg_pubsub

    fake_engine = MagicMock()
    call_order: list[str] = []

    async def _fake_dispose():
        call_order.append("engine_dispose")

    fake_engine.dispose = AsyncMock(side_effect=_fake_dispose)
    monkeypatch.setattr("app.core.database.engine", fake_engine)

    started = asyncio.Event()

    async def fake_listen():
        started.set()
        try:
            await asyncio.Event().wait()
        except asyncio.CancelledError:
            return

    monkeypatch.setattr("app.services.pg_pubsub.listen_loop", fake_listen)

    # 기본 timeout(5s)까지 실제로 블록하지 않도록, 정상 완료(취소 아님)로 순서를 검증한다 —
    # cancel-on-timeout 경로는 test_drain_cancels_task_that_exceeds_timeout이 짧은 timeout으로
    # 이미 따로 덮는다. 여기서는 "drain이 dispose보다 먼저 일어난다"만 end-to-end로 확인.
    async def _pending_pubsub_work():
        await asyncio.sleep(0.01)
        call_order.append("pending_task_finished")

    async with lifespan(MagicMock()):
        await asyncio.wait_for(started.wait(), timeout=1)
        # 상신 중인 pg_notify류 fire-and-forget 태스크를 흉내낸다(예: 결재 카드 알림).
        pg_pubsub.fire_and_forget(_pending_pubsub_work())

    assert "pending_task_finished" in call_order, "미완료 fire_and_forget 태스크가 drain되지 않음"
    assert call_order.index("pending_task_finished") < call_order.index("engine_dispose"), (
        f"순서 위반 — engine.dispose()가 pg_pubsub drain보다 먼저(또는 동시에) 일어남: {call_order}"
    )
