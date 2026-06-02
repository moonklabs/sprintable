"""per-recipient dense commit-ordered seq 발급 헬퍼.

이벤트 생성과 동일 트랜잭션에서 호출해야 직렬화 보장.
카운터 row-lock → seq N+1은 N 커밋 전에 발급 불가 → commit 순서 = seq 순서 = dense.
abort 시 카운터도 롤백 → 빈 번호 없음.
"""
from __future__ import annotations

import uuid

from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.event import Event


async def assign_recipient_seq(db: AsyncSession, event: Event) -> int:
    """같은 트랜잭션에서 per-recipient seq 발급 후 event.recipient_seq 설정.

    반드시 Event INSERT + flush 후, commit 전에 호출.
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
    return seq
