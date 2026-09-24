"""story #4230 — 호출자 트랜잭션이 **실제로 커밋된 뒤에만** 실행할 일(SSE push · ws 브로드캐스트 · background task 등)을
세션에 예약한다.

서버 훅(`publish_preset_event`)은 게이트 전이 한가운데서 메시지를 남긴다. 예전엔 그 안의 `send_message`가 스스로
커밋해 전이 트랜잭션을 중간에 확정했다. 이제 훅은 flush만 하고, 밖으로 나가는 배달은 여기 예약해 전이를 연 쪽의 커밋
뒤에 나간다 — 전이가 롤백되면 배달도 없다.

`app.services.event_seq._schedule_wake_after_commit`(wake 예약)과 같은 패턴:
- `after_commit` 세션 이벤트는 SAVEPOINT release에서도 발화한다 → `in_nested_transaction()`이면 건너뛰고 바깥 커밋을 기다린다.
- `after_rollback`이면 예약을 버린다(같은 세션이 다음 트랜잭션에 재사용돼도 옛 예약이 새지 않게).
- 예약된 일의 오류는 **로그만** 남긴다 — 이미 커밋된 트랜잭션을 되돌리려 하지 않는다.
- 비동기 일(코루틴을 돌려주는 호출)은 실행 중인 이벤트 루프에 태스크로 띄운다(`after_commit` 콜백은 동기).

한계(기록): 예약한 **뒤** 호출자가 자기 SAVEPOINT를 롤백하고 바깥은 커밋하면 예약은 남아 실행된다(event_seq wake와 같은
한계). 예약하는 쪽(`publish_preset_event`)은 자기 SAVEPOINT가 성공한 뒤에만 예약하고, 실패하면 예약하지 않는다.
"""
from __future__ import annotations

import asyncio
import inspect
import logging
from collections.abc import Callable
from typing import Any

from sqlalchemy import event as sa_event
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import Session

logger = logging.getLogger(__name__)

_PENDING_KEY = "_after_commit_pending"
_HOOKED_KEY = "_after_commit_hooked"
# 띄운 태스크를 끝날 때까지 붙잡아 둔다(가비지 컬렉션으로 중간에 사라지지 않게 — asyncio 문서 권고).
_RUNNING: set[asyncio.Task] = set()


def schedule_after_commit(db: AsyncSession, actions: list[Callable[[], Any]]) -> None:
    """`actions`를 이 세션의 다음 **바깥** 커밋 뒤에 한 번 실행하도록 예약한다(롤백되면 버린다)."""
    if not actions:
        return
    sync_session = db.sync_session
    if not isinstance(sync_session, Session):
        raise TypeError("schedule_after_commit에는 실 AsyncSession이 필요하다")
    pending: list[Callable[[], Any]] = sync_session.info.setdefault(_PENDING_KEY, [])
    pending.extend(actions)
    if not sync_session.info.get(_HOOKED_KEY):
        sync_session.info[_HOOKED_KEY] = True
        sa_event.listen(sync_session, "after_commit", _run_pending)
        sa_event.listen(sync_session, "after_rollback", _clear_pending)


def _run_pending(sync_session: Session) -> None:
    if sync_session.in_nested_transaction():
        return  # SAVEPOINT release — 바깥 커밋 때 실행
    actions = sync_session.info.pop(_PENDING_KEY, None) or []
    for action in actions:
        try:
            result = action()
        except Exception:
            logger.warning("after-commit action failed: %r", action, exc_info=True)
            continue
        if inspect.isawaitable(result):
            task = asyncio.get_running_loop().create_task(_logged(result, action))
            _RUNNING.add(task)
            task.add_done_callback(_RUNNING.discard)


async def _logged(awaitable: Any, action: Callable[[], Any]) -> None:
    try:
        await awaitable
    except Exception:
        logger.warning("after-commit action failed: %r", action, exc_info=True)


def _clear_pending(sync_session: Session) -> None:
    sync_session.info.pop(_PENDING_KEY, None)


async def drain_after_commit_tasks() -> None:
    """테스트용 — 띄운 커밋 뒤 태스크가 끝날 때까지 기다린다."""
    while _RUNNING:
        await asyncio.gather(*list(_RUNNING), return_exceptions=True)
