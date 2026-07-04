"""E-EVENT-1CONFIG Part B: ACK retire 가드 (backfill landmine 박멸).

ack_event 가 acked_seq 전진뿐 아니라 recipient_seq <= seq 인 pending agent 이벤트를 같은
트랜잭션서 delivered 마킹함을 가드한다. 이게 빠지면 cleanup(expire-stale)이 영영 회수 못 해
pending 무한 적재 → restart backfill 폭주.

- mock 가드(CI 상시): UPDATE(events) 가 발행되는지 — retire 제거 시 FAIL.
- 실DB 가드(DATABASE_URL): <=seq delivered / >seq pending / idempotent 의미 검증.
"""
from __future__ import annotations

import os
import uuid
from types import SimpleNamespace
from unittest.mock import AsyncMock, MagicMock

import pytest
from sqlalchemy import text
from sqlalchemy.sql.dml import Update

from app.routers.agent_gateway import AckRequest, ack_event


@pytest.fixture
def anyio_backend():
    return "asyncio"


def _api_key_auth(agent_id: uuid.UUID) -> SimpleNamespace:
    return SimpleNamespace(
        claims={"app_metadata": {"api_key_id": "k1"}},
        user_id=str(agent_id),
    )


@pytest.mark.anyio
async def test_ack_issues_delivered_update_on_events():
    """ACK 시 cursor UPSERT 외에 events 대상 UPDATE(delivered)가 반드시 발행된다."""
    agent_id = uuid.uuid4()
    cursor = SimpleNamespace(acked_seq=0, updated_at=None, agent_id=agent_id)
    sel_result = MagicMock()
    sel_result.scalar_one_or_none.return_value = cursor

    executed: list = []

    async def _execute(stmt, *a, **k):
        executed.append(stmt)
        return sel_result

    db = SimpleNamespace(
        execute=_execute,
        add=MagicMock(),
        commit=AsyncMock(),
    )

    out = await ack_event(AckRequest(seq=7), db=db, auth=_api_key_auth(agent_id))
    assert out == {"acked_seq": 7}

    updates = [s for s in executed if isinstance(s, Update)]
    assert len(updates) == 1, "events delivered UPDATE 가 발행돼야 한다(retire)"
    assert updates[0].table.name == "events"


@pytest.mark.anyio
async def test_ack_requires_api_key():
    """비-API-key caller 는 403 (기존 거동 무회귀)."""
    from fastapi import HTTPException

    db = SimpleNamespace(execute=AsyncMock(), add=MagicMock(), commit=AsyncMock())
    auth = SimpleNamespace(claims={"app_metadata": {}}, user_id=str(uuid.uuid4()))
    with pytest.raises(HTTPException) as ei:
        await ack_event(AckRequest(seq=1), db=db, auth=auth)
    assert ei.value.status_code == 403


# ─── 실DB 의미 가드 ───────────────────────────────────────────────────────────

_ASYNCPG_URL = (
    os.getenv("DATABASE_URL", "").replace("postgresql+asyncpg://", "postgresql://")
    or None
)
_requires_db = pytest.mark.skipif(
    not _ASYNCPG_URL, reason="DATABASE_URL not set — real DB test skipped"
)


@_requires_db
@pytest.mark.anyio
async def test_ack_retire_semantics_realdb():
    """<=seq pending → delivered, >seq 유지, 재-ack idempotent."""
    from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine

    org, proj, agent = uuid.uuid4(), uuid.uuid4(), uuid.uuid4()
    # story 18eefc31: 테스트 전용 엔진(+dispose) — 프로덕션 전역 싱글턴
    # `app.core.database.async_session_factory` 는 pytest-asyncio 함수-스코프 이벤트루프와
    # 부딪혀 "attached to a different loop"(84파일 풀런서만 노출) — 다른 realdb 테스트와
    # 동일 관례로 전환.
    engine = create_async_engine(_ASYNCPG_URL.replace("postgresql://", "postgresql+asyncpg://"))
    Session = async_sessionmaker(engine, expire_on_commit=False)
    try:
        async with Session() as db:
            await db.execute(
                text("INSERT INTO organizations (id, name, slug) VALUES (:i, :n, :s)"),
                {"i": org, "n": f"ack-org-{org}", "s": f"ack-{org}"},
            )
            await db.execute(
                text("INSERT INTO projects (id, org_id, name) VALUES (:i, :o, :n)"),
                {"i": proj, "o": org, "n": f"ack-proj-{proj}"},
            )
            for seq in (1, 2, 3):
                await db.execute(
                    text(
                        "INSERT INTO events "
                        "(id, org_id, project_id, event_type, recipient_id, recipient_type, "
                        " payload, status, recipient_seq) VALUES "
                        "(gen_random_uuid(), :o, :p, 'conversation.message_created', :r, 'agent', "
                        " '{}', 'pending', :seq)"
                    ),
                    {"o": org, "p": proj, "r": agent, "seq": seq},
                )
            await db.commit()
            try:
                await ack_event(AckRequest(seq=2), db=db, auth=_api_key_auth(agent))

                rows = (await db.execute(
                    text("SELECT recipient_seq, status FROM events WHERE recipient_id = :r"),
                    {"r": agent},
                )).all()
                by_seq = {r[0]: r[1] for r in rows}
                assert by_seq[1] == "delivered"
                assert by_seq[2] == "delivered"
                assert by_seq[3] == "pending", ">seq 이벤트는 유지(미-ack)"

                # 재-ack: 동일 seq → no-op(idempotent), 에러 없음
                await ack_event(AckRequest(seq=2), db=db, auth=_api_key_auth(agent))
            finally:
                await db.execute(text("DELETE FROM events WHERE recipient_id = :r"), {"r": agent})
                await db.execute(text("DELETE FROM agent_event_cursors WHERE agent_id = :a"), {"a": agent})
                await db.execute(text("DELETE FROM projects WHERE id = :i"), {"i": proj})
                await db.execute(text("DELETE FROM organizations WHERE id = :i"), {"i": org})
                await db.commit()
    finally:
        await engine.dispose()
