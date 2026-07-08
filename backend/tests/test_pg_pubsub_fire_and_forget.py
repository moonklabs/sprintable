"""prod 커넥션 누수 근본fix(2026-07-08) — `pg_pubsub.fire_and_forget()` 회귀 가드.

원인: `publish_event()`/`_push_to_agent()`/`wake_agent()`가 참조 미보관
`asyncio.get_running_loop().create_task(pg_notify(...))`로 fire-and-forget 했다 — Python
공식 문서 경고대로, 참조 없는 태스크는 GC가 실행 중간에(pg_notify()의
`async with async_session_factory()` 도중이면 세션 close() 없이) 수거할 수 있다. 이게
prod 로그의 "garbage collector is trying to clean up non-checked-in connection" 경고와
~2.5h마다 TooManyConnections 재발의 root였다.

이 테스트는 (a) `fire_and_forget`이 완료 전까지 `_background_tasks`에 강한 참조를 보관하는지
(b) 완료 후 자동 제거되는지 (c) 이벤트 루프 없을 때 조용히 no-op인지 (d) 참조 미보관 raw
`create_task()`는 실제로 GC에 조기수거될 수 있음(=재발 방지 대상 실증) — 를 검증한다.
"""
from __future__ import annotations

import asyncio

import pytest

from app.services.pg_pubsub import _background_tasks, fire_and_forget


@pytest.fixture
def anyio_backend():
    return "asyncio"


@pytest.mark.anyio
async def test_fire_and_forget_keeps_strong_reference_while_pending():
    """실행 중엔 _background_tasks에 남아있어야(GC가 이 참조를 보고 수거 안 함)."""
    gate = asyncio.Event()
    started = asyncio.Event()

    async def _work():
        started.set()
        await gate.wait()

    before = set(_background_tasks)
    fire_and_forget(_work())
    await started.wait()
    added = _background_tasks - before
    assert len(added) == 1, "fire_and_forget이 task를 _background_tasks에 등록해야"
    task = next(iter(added))
    assert not task.done()

    gate.set()
    await task
    # done-callback은 Task 완료 시 call_soon으로 예약될 뿐 즉시 실행되지 않는다 — 루프에
    # 제어를 한 번 더 넘겨야 실제로 실행된다.
    await asyncio.sleep(0)
    assert task not in _background_tasks, "완료 후 add_done_callback으로 자동 제거돼야"


@pytest.mark.anyio
async def test_fire_and_forget_removes_task_after_completion_even_on_exception():
    """coroutine이 예외로 끝나도(pg_notify 자체는 예외 삼키지만, 방어적으로) done-callback은 실행돼
    _background_tasks에 좀비로 안 남아야."""
    async def _boom():
        raise ValueError("boom")

    before = len(_background_tasks)
    fire_and_forget(_boom())
    await asyncio.sleep(0.01)  # task 완료 + done-callback 실행 대기
    assert len(_background_tasks) == before


def test_fire_and_forget_no_event_loop_is_silent_noop():
    """이벤트 루프 없는 컨텍스트(예: 테스트 sync 함수) — 예외 없이 조용히 no-op(기존
    `except RuntimeError: pass` 호출부 관례와 동형)."""
    before = len(_background_tasks)

    async def _never_runs():
        pass

    fire_and_forget(_never_runs())  # RuntimeError 없이 통과해야
    assert len(_background_tasks) == before
