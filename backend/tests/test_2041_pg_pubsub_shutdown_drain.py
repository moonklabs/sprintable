"""story #2041(그라운딩 doc 67b44d1e, PR-A) — pg_pubsub.drain_background_tasks() 회귀가드.

핵심 검증축:
①미완료 fire_and_forget 태스크가 dispose()보다 먼저 drain(대기/취소)된다(순서 위반=레이스).
②timeout 안에 끝나면 정상 완료를 기다린다(불필요한 cancel 없음).
③timeout을 넘기면 cancel한다(영구 대기 금지).
④스냅샷 의미 — drain 진입 시점의 task만 대상. 그 뒤 추가된 task는 이번 호출이 기다리지 않는다
  (페드루 PO 지시 ① 반영, 무한정 확장 방지).
⑤`_background_tasks`가 비어 있으면 즉시 반환(no-op, sleep/wait 없음).

story #4248 — 순서는 **시간(sleep)이 아니라 이벤트로** 고정한다. 예전 ④는 `_early`가 5ms 자고 드레인이 1초 안에 끝나길 기대해,
러너가 드레인 진입 직후 1초 넘게 멈추면(CI 실측: «drain timeout(1.0s) — 미완료 태스크 1건 cancel» · 스냅숏은 `_early` 하나) timeout이
`_early`의 첫 스텝보다 먼저 와 RED였다. 이제 각 task는 이벤트를 기다리고, 그 이벤트는 `loop.call_soon`으로 **드레인이 스냅숏을 뜬 뒤**에
풀린다(드레인은 첫 await 전에 스냅숏을 뜨므로, 드레인 호출 직전에 예약한 콜백은 반드시 스냅숏 뒤에 돈다). timeout은 넉넉히 둔다 —
정상 경로는 timeout에 닿지 않는다.
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


@pytest.fixture(autouse=True)
def _reset_shutdown_event_after():
    """CI 실측(2026-08-26, 페드루 PO 재현·delta) — 이 파일의 test_shutdown_drains_before_
    dispose_end_to_end만 실 `app.main.lifespan()`을 왕복한다. 그 finally가 프로세스 전역
    `app.core.shutdown.shutdown_event`를 set()하는데(shutdown.py 계약), 이후 같은 pytest
    프로세스에서 그 이벤트를 다시 startup 경로로 reset하는 코드가 전혀 없으면 "이미
    셧다운됨" 상태가 그대로 남는다 — 알파벳순으로 이 파일 뒤에 도는
    test_2143_agent_stream_legacy_push_id_omission.py의 agent_stream() SSE 제너레이터가
    (`app/routers/agent_gateway.py`의 shutdown_task가 즉시 done) presence 프레임 도달 전에
    "event: shutdown_reconnect"를 내고 즉시 return — StopIteration으로 관측됐다(단독 실행 시
    통과·이 조합에서만 3/3 결정적 재현, 실측 완료). shutdown_event는 이 테스트만 건드리므로
    (다른 4개는 pg_pubsub 함수 단위) 여기서 자기 발자국을 스스로 지운다 — main.py startup과
    동일한 공개 API(reset_shutdown_event)로 되돌려 "이 테스트 실행 전/후 전역 상태 불변"을
    복원한다(테스트가 안 건드렸으면 no-op와 동형이라 나머지 4개엔 부작용 없음)."""
    yield
    from app.core import shutdown as shutdown_module
    shutdown_module.reset_shutdown_event()


async def test_drain_awaits_pending_task_that_finishes_within_timeout():
    from app.services import pg_pubsub

    finished = asyncio.Event()
    release = asyncio.Event()

    async def _quick():
        await release.wait()
        finished.set()

    pg_pubsub.fire_and_forget(_quick())
    assert len(pg_pubsub._background_tasks) == 1

    asyncio.get_running_loop().call_soon(release.set)  # 드레인이 스냅숏을 뜬 뒤 풀린다
    await pg_pubsub.drain_background_tasks(timeout=30.0)

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
    early_go = asyncio.Event()
    late_release = asyncio.Event()
    late_task: list[asyncio.Task] = []

    async def _late():
        await late_release.wait()  # 드레인이 반환할 때까지 절대 안 끝난다(시간과 무관)

    async def _early():
        # drain이 스냅샷을 뜬 뒤 새 task를 추가 — 이번 drain 호출 대상에 안 들어가야 함.
        await early_go.wait()
        pg_pubsub.fire_and_forget(_late())
        late_task.extend(t for t in pg_pubsub._background_tasks if t is not asyncio.current_task())
        late_task_added.set()

    pg_pubsub.fire_and_forget(_early())

    asyncio.get_running_loop().call_soon(early_go.set)  # 드레인이 스냅숏을 뜬 뒤 풀린다
    await pg_pubsub.drain_background_tasks(timeout=30.0)

    assert late_task_added.is_set(), "_early가 끝나 _late를 추가했어야 한다"
    assert late_task and not late_task[0].done(), (
        "스냅샷 밖에서 추가된 _late 태스크는 이번 drain이 기다리지 않아 아직 안 끝났어야 한다"
    )
    assert late_task[0] in pg_pubsub._background_tasks
    late_release.set()  # 정리 — 다음 테스트로 pending 태스크가 새지 않게.
    await late_task[0]


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
    # story #4248 — 시간(sleep) 대신: 이 task는 셧다운 드레인이 스냅숏을 뜬 **뒤**에야 풀려 끝난다 → «드레인이 기다렸다»가 순서로 증명된다.
    release = asyncio.Event()

    async def _pending_pubsub_work():
        await release.wait()
        call_order.append("pending_task_finished")

    real_drain = pg_pubsub.drain_background_tasks

    async def _drain_then_release(timeout: float = 5.0) -> None:
        asyncio.get_running_loop().call_soon(release.set)
        await real_drain(timeout=timeout)

    monkeypatch.setattr(pg_pubsub, "drain_background_tasks", _drain_then_release)

    async with lifespan(MagicMock()):
        await asyncio.wait_for(started.wait(), timeout=1)
        # 상신 중인 pg_notify류 fire-and-forget 태스크를 흉내낸다(예: 결재 카드 알림).
        pg_pubsub.fire_and_forget(_pending_pubsub_work())

    assert "pending_task_finished" in call_order, "미완료 fire_and_forget 태스크가 drain되지 않음"
    assert call_order.index("pending_task_finished") < call_order.index("engine_dispose"), (
        f"순서 위반 — engine.dispose()가 pg_pubsub drain보다 먼저(또는 동시에) 일어남: {call_order}"
    )


async def test_drain_ignores_tasks_from_another_event_loop():
    """story #4248 — 같은 프로세스에서 앞 루프(테스트마다 새 루프)가 남긴 task는 이 루프의 드레인 대상이 아니다. 섞이면 끝날 수도
    cancel될 수도 없어(그 루프는 닫힘) timeout까지 기다린 뒤 닫힌 루프에 cancel을 걸다 RuntimeError가 난다."""
    import logging

    from app.services import pg_pubsub

    other = asyncio.new_event_loop()
    stale = other.create_future()  # 다른 루프에 묶인 미완료 future — 이미 닫힌 루프가 남긴 것을 흉내
    other.close()
    pg_pubsub._background_tasks.add(stale)  # type: ignore[arg-type]

    caught: list[logging.LogRecord] = []
    handler = logging.Handler()
    handler.emit = caught.append  # type: ignore[method-assign]
    logging.getLogger("app.services.pg_pubsub").addHandler(handler)
    try:
        await pg_pubsub.drain_background_tasks(timeout=0.2)  # 기다리지도 · cancel하지도 않는다
    finally:
        logging.getLogger("app.services.pg_pubsub").removeHandler(handler)
    assert not stale.done()
    assert not [r for r in caught if "drain timeout" in r.getMessage()], "다른 루프 task를 기다리다 timeout이 났다"
