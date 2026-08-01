"""per-recipient dense commit-ordered seq 발급 헬퍼 + commit 후 자동 wake 예약.

이벤트 생성과 동일 트랜잭션에서 호출해야 직렬화 보장.
카운터 row-lock → seq N+1은 N 커밋 전에 발급 불가 → commit 순서 = seq 순서 = dense.
abort 시 카운터도 롤백 → 빈 번호 없음.

story #2381 — dispatch_notification()의 ~20개 호출부 어디도 commit 후 wake_agent()를 부르지
않아, 연결 中인 에이전트가 다음 재연결(SSE lifespan cap, 최대 300s+지터)까지 새 이벤트를
몰랐다(근본: 부르는 것 자체가 없었다). "각 호출부가 commit 후 기억해서 불러야 한다"는 조건부
계약을 하나 더 추가하는 대신 — assign_recipient_seq()가 agent Event 가시성(/stream 커서 쿼리
`recipient_seq > after_seq`)의 유일한 관문이라는, #2375가 이미 세운 불변식을 그대로 이용해
여기 한 곳에 자동 예약을 건다. 새 호출부가 생겨도(현재도 미래도) 이 함수를 거치지 않고는
agent Event가 애초에 안 보이므로, wake 도 구조적으로 놓칠 수 없다 — commit=False로 세션에
합류하는 호출부(예: gates.py의 기존 agent_wake 반환값 스레딩 경로, 0f428e1e 사고 계열)도 같은
db 세션 객체에 훅이 걸리므로 그 스레딩이 틀려도 이제 무음이 되지 않는다(다만 그 기존 경로를
이 스토리에서 제거하지는 않았다 — 중복 발화는 무해하고, 이미 검증된 코드의 블라스트 반경을
필요 이상으로 건드리지 않기 위함. scripts/jobs/README.md에 남긴 "알려진 갭, 안 고침"과 같은
판단).
"""
from __future__ import annotations

import logging

from sqlalchemy import event as sa_event
from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import Session

from app.models.event import Event

logger = logging.getLogger(__name__)

_PENDING_WAKES_KEY = "e2381_pending_agent_wakes"
_HOOKED_KEY = "e2381_wake_hook_installed"


async def assign_recipient_seq(db: AsyncSession, event: Event) -> int:
    """같은 트랜잭션에서 per-recipient seq 발급 후 event.recipient_seq 설정.

    반드시 Event INSERT + flush 후, commit 전에 호출. 이 세션이 실제로 commit에 성공하면
    자동으로 이 recipient에게 wake_agent()가 발화되도록 예약한다(호출자가 별도로 부를 필요
    없음 — _schedule_wake_after_commit 참고).
    """
    result = await db.execute(
        text("""
            INSERT INTO agent_event_seqs(recipient_id, last_seq)
            VALUES (:rid, 1)
            ON CONFLICT(recipient_id)
            DO UPDATE SET last_seq = agent_event_seqs.last_seq + 1,
                          updated_at = NOW()
            RETURNING last_seq
        """),
        {"rid": str(event.recipient_id)},
    )
    seq: int = result.scalar_one()
    event.recipient_seq = seq
    _schedule_wake_after_commit(db, str(event.recipient_id), seq)
    return seq


def _schedule_wake_after_commit(db: AsyncSession, recipient_id: str, seq: int) -> None:
    """commit 성공 後 wake_agent(recipient_id, seq)가 정확히 한 번 자동 발화되도록 세션에 예약.

    ⛔wake_agent()를 여기서 직접 부르지 않는다 — 아직 commit 前이면 recipient는 이 row를 볼 수
    없다(MVCC 가시성 레이스 — 이 스토리의 본체). SQLAlchemy의 `after_commit` 세션 이벤트는 실제
    COMMIT이 성공한 뒤에만(rollback 시엔 아예 안 불림) 호출을 보장한다 — "commit 후에"를 코드
    규율이 아니라 트랜잭션 경계 자체가 강제하게 만든다.

    ⚠️단위테스트가 db를 MagicMock/AsyncMock으로 대체하는 경로(assign_recipient_seq를 직접
    호출하는 기존 테스트 다수)에서는 `sync_session`이 진짜 Session이 아니라 SQLAlchemy가
    `event.listen()`에서 InvalidRequestError를 던진다 — 조용히 스킵한다(프로덕션은 db가 항상
    실 AsyncSession이라 여기 걸릴 일이 없다).
    """
    sync_session = db.sync_session
    if not isinstance(sync_session, Session):
        logger.debug(
            "wake scheduling skipped — db.sync_session is not a real Session (test double?) "
            "recipient_id=%s", recipient_id,
        )
        return
    pending: list[tuple[str, int]] = sync_session.info.setdefault(_PENDING_WAKES_KEY, [])
    pending.append((recipient_id, seq))
    if not sync_session.info.get(_HOOKED_KEY):
        sync_session.info[_HOOKED_KEY] = True
        sa_event.listen(sync_session, "after_commit", _fire_pending_wakes)
        sa_event.listen(sync_session, "after_rollback", _clear_pending_wakes_on_rollback)


def _fire_pending_wakes(sync_session: Session) -> None:
    pending = sync_session.info.pop(_PENDING_WAKES_KEY, None) or []
    if not pending:
        return
    from app.routers.agent_gateway import wake_agent

    for recipient_id, seq in pending:
        try:
            wake_agent(recipient_id, seq)
        except Exception:
            logger.warning(
                "post-commit wake_agent failed recipient_id=%s seq=%s", recipient_id, seq, exc_info=True,
            )


def _clear_pending_wakes_on_rollback(sync_session: Session) -> None:
    """롤백된 트랜잭션에서 쌓인 예약은 버린다 — 같은 세션이 다음 트랜잭션에 재사용돼도
    이전 롤백분이 잘못 발화되지 않도록(_HOOKED_KEY는 유지 — 리스너 재등록 방지, 예약 목록만 초기화)."""
    sync_session.info.pop(_PENDING_WAKES_KEY, None)
