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

import functools
import logging

from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import Session

from app.models.event import Event

logger = logging.getLogger(__name__)



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
    없다(MVCC 가시성 레이스 — story #2381의 본체). 예약은 `app.services.after_commit`(커밋 뒤 배달의 단일 기전)이 맡는다:
    바깥 커밋 뒤에만 발화 · SAVEPOINT release에선 대기 · **예약한 트랜잭션(SAVEPOINT 포함)이 롤백되면 그 예약만** 버림.

    story #4230(까디르 4597 QA P1) — 예전 자체 훅은 `after_rollback`에서 목록을 통째로 비웠는데, SQLAlchemy 2.0은
    SAVEPOINT 롤백에도 `after_rollback`을 발화해 형제 SAVEPOINT(또는 바깥)의 정상 wake까지 지웠다. 반대로 롤백된
    SAVEPOINT 안의 wake가 남아 유령으로 나가는 경우도 있었다(그 SAVEPOINT 뒤 바깥이 커밋되면). 둘 다 소유 트랜잭션
    기준으로 닫는다.

    ⚠️단위테스트가 db를 MagicMock/AsyncMock으로 대체하는 경로(assign_recipient_seq를 직접
    호출하는 기존 테스트 다수)에서는 `sync_session`이 진짜 Session이 아니다 — 조용히 스킵한다(프로덕션은 db가 항상
    실 AsyncSession이라 여기 걸릴 일이 없다)."""
    sync_session = db.sync_session
    if not isinstance(sync_session, Session):
        logger.debug(
            "wake scheduling skipped — db.sync_session is not a real Session (test double?) "
            "recipient_id=%s", recipient_id,
        )
        return
    from app.services.after_commit import schedule_after_commit

    schedule_after_commit(db, [functools.partial(_fire_wake, recipient_id, seq)])


def _fire_wake(recipient_id: str, seq: int) -> None:
    from app.routers.agent_gateway import wake_agent

    try:
        wake_agent(recipient_id, seq)
    except Exception:
        logger.warning(
            "post-commit wake_agent failed recipient_id=%s seq=%s", recipient_id, seq, exc_info=True,
        )