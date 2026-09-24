"""story #4230 — 호출자 트랜잭션이 **실제로 커밋된 뒤에만** 실행할 일(SSE push · ws 브로드캐스트 · background task ·
에이전트 wake 등)을 세션에 예약한다. 커밋 뒤 배달이 필요한 자리는 전부 이 한 기전을 쓴다(`event_seq` wake ·
`approval_delivery` gate_created push · `publish_preset_event` 배달).

서버 훅(`publish_preset_event`)은 게이트 전이 한가운데서 메시지를 남긴다. 예전엔 그 안의 `send_message`가 스스로
커밋해 전이 트랜잭션을 중간에 확정했다. 이제 훅은 flush만 하고, 밖으로 나가는 배달은 여기 예약해 전이를 연 쪽의 커밋
뒤에 나간다 — 전이가 롤백되면 배달도 없다.

**예약은 그 예약을 만든 트랜잭션(SAVEPOINT 포함)에 속한다** (까디르 4597 QA P1):
- 예약 시점의 가장 안쪽 트랜잭션(`get_nested_transaction() or get_transaction()`)을 주인으로 기록한다.
- 어떤 트랜잭션이 롤백되면(`after_soft_rollback` — SAVEPOINT 롤백 포함) **그 트랜잭션이나 그 아래에서** 만든 예약만
  버린다. 바깥(루트) 롤백이면 결과적으로 전부 버린다. 형제 SAVEPOINT의 롤백은 다른 SAVEPOINT·바깥의 예약을 지우지 않는다.
  (예전엔 `after_rollback`에 «통째 비우기»를 걸었는데, SQLAlchemy 2.0은 SAVEPOINT 롤백에도 `after_rollback`을 발화해
  성공한 형제 발행의 배달까지 지웠다 — 실측: SQLAlchemy 2.0.49, `after_rollback`이 `in_nested_transaction()=True`로 발화.)
- `after_commit`은 SAVEPOINT release에서도 발화한다 → `in_nested_transaction()`이면 건너뛰고 바깥 커밋 때 실행한다.
- 예약된 일의 오류는 **로그만** 남긴다 — 이미 커밋된 트랜잭션을 되돌리려 하지 않는다.
- 비동기 일(코루틴을 돌려주는 호출)은 `pg_pubsub.fire_and_forget`으로 띄운다(`after_commit` 콜백은 동기). 참조 보관 ·
  종료 시 drain(`drain_background_tasks`)은 그 한 원천이 맡는다(#1970 커넥션 누수 근본 fix · 참조 미보관 가드).
"""
from __future__ import annotations

import inspect
import logging
from collections.abc import Callable
from typing import Any

from sqlalchemy import event as sa_event
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import Session, SessionTransaction

from app.services.pg_pubsub import fire_and_forget

logger = logging.getLogger(__name__)

_PENDING_KEY = "_after_commit_pending"
_HOOKED_KEY = "_after_commit_hooked"


def schedule_after_commit(db: AsyncSession | Session, actions: list[Callable[[], Any]]) -> None:
    """`actions`를 이 세션의 다음 **바깥** 커밋 뒤에 한 번 실행하도록 예약한다. 예약한 트랜잭션(또는 그 조상)이 롤백되면
    버린다. `db`는 AsyncSession 또는 그 sync Session."""
    if not actions:
        return
    sync_session = db.sync_session if isinstance(db, AsyncSession) else db
    if not isinstance(sync_session, Session):
        raise TypeError("schedule_after_commit needs a real AsyncSession")
    owner = sync_session.get_nested_transaction() or sync_session.get_transaction()
    pending: list[tuple[SessionTransaction | None, Callable[[], Any]]] = sync_session.info.setdefault(_PENDING_KEY, [])
    pending.extend((owner, action) for action in actions)
    if not sync_session.info.get(_HOOKED_KEY):
        sync_session.info[_HOOKED_KEY] = True
        sa_event.listen(sync_session, "after_commit", _run_pending)
        sa_event.listen(sync_session, "after_soft_rollback", _drop_rolled_back)


def _owned_by(owner: SessionTransaction | None, rolled_back: SessionTransaction) -> bool:
    """`owner`가 `rolled_back` 자신이거나 그 아래(자손) 트랜잭션인가."""
    txn = owner
    while txn is not None:
        if txn is rolled_back:
            return True
        txn = txn.parent
    return False


def _drop_rolled_back(sync_session: Session, previous_transaction: SessionTransaction) -> None:
    pending = sync_session.info.get(_PENDING_KEY)
    if not pending:
        return
    sync_session.info[_PENDING_KEY] = [(o, a) for o, a in pending if not _owned_by(o, previous_transaction)]


def _run_pending(sync_session: Session) -> None:
    if sync_session.in_nested_transaction():
        return  # SAVEPOINT release — 바깥 커밋 때 실행
    pending = sync_session.info.pop(_PENDING_KEY, None) or []
    for _owner, action in pending:
        try:
            result = action()
        except Exception:
            logger.warning("after-commit action failed: %r", action, exc_info=True)
            continue
        if inspect.isawaitable(result):
            fire_and_forget(_logged(result, action))


async def _logged(awaitable: Any, action: Callable[[], Any]) -> None:
    try:
        await awaitable
    except Exception:
        logger.warning("after-commit action failed: %r", action, exc_info=True)

