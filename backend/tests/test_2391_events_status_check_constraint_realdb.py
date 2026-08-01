"""story #2391 AC2 — events.status에 붙인 ck_events_status가 실제 라이브 DB에서 무는지.

로컬(직접) 검증은 pgvector/pg16 docker 컨테이너로 이미 했다(PR 설명 참조 — 4개 유효값 삽입
성공 + 무효값 삽입이 정확히 "ck_events_status violates check constraint"로 실패). 이 테스트는
그 확認을 CI의 실제 Postgres(backend-test job의 `DATABASE_URL`)에서도 고정한다 — DB env
없으면 skip(로컬 무DB 환경 배려, 다른 `_realdb` 테스트와 동일 관례).
"""
from __future__ import annotations

import os
import uuid

import pytest
from sqlalchemy import text
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine

_RAW = os.environ.get("DATABASE_URL") or ""
pytestmark = pytest.mark.skipif(not _RAW, reason="real-DB URL(DATABASE_URL) 미설정 — skip")

ORG = uuid.UUID("2391e000-0000-0000-0000-000000000001")
PROJECT = uuid.UUID("2391e000-0000-0000-0000-000000000002")
RECIPIENT = uuid.UUID("2391e000-0000-0000-0000-000000000003")


@pytest.fixture
def anyio_backend():
    return "asyncio"


async def _seed(s):
    # events.recipient_id/sender_id는 실측(2026-08-01, \d events)상 FK가 없다 — team_members가
    # 뷰(0088_team_members_projection_view)라 DB 레벨 FK를 못 건다(purge_test_agents.py
    # docstring이 이미 문서화한 사실). 그래서 recipient_id는 실 members row 없이도 들어간다 —
    # organizations/projects(둘 다 실 FK 있음, `\d events` 확認)만 심으면 된다.
    for sql in [
        f"DELETE FROM events WHERE org_id='{ORG}'",
        f"DELETE FROM projects WHERE id='{PROJECT}'",
        f"DELETE FROM organizations WHERE id='{ORG}'",
        f"INSERT INTO organizations (id,name,slug,plan) VALUES ('{ORG}','2391-org','2391-org-{uuid.uuid4().hex[:8]}','free')",
        f"INSERT INTO projects (id,org_id,name) VALUES ('{PROJECT}','{ORG}','2391-proj')",
    ]:
        await s.execute(text(sql))
    await s.commit()


async def _cleanup(s):
    for sql in [
        f"DELETE FROM events WHERE org_id='{ORG}'",
        f"DELETE FROM projects WHERE id='{PROJECT}'",
        f"DELETE FROM organizations WHERE id='{ORG}'",
    ]:
        await s.execute(text(sql))
    await s.commit()


def _insert_event_sql(status: str) -> str:
    eid = uuid.uuid4()
    return (
        "INSERT INTO events (id,org_id,project_id,event_type,recipient_id,recipient_type,payload,status) "
        f"VALUES ('{eid}','{ORG}','{PROJECT}','2391_test','{RECIPIENT}','agent','{{}}'::jsonb,'{status}')"
    )


@pytest.mark.anyio
async def test_ck_events_status_rejects_a_value_outside_the_enum():
    engine = create_async_engine(_RAW)
    session_factory = async_sessionmaker(engine, expire_on_commit=False)
    async with session_factory() as s:
        await _seed(s)
        try:
            with pytest.raises(IntegrityError, match="ck_events_status"):
                await s.execute(text(_insert_event_sql("bogus_status")))
                await s.commit()
        finally:
            await s.rollback()
            await _cleanup(s)
    await engine.dispose()


@pytest.mark.anyio
async def test_ck_events_status_accepts_all_four_declared_values():
    engine = create_async_engine(_RAW)
    session_factory = async_sessionmaker(engine, expire_on_commit=False)
    async with session_factory() as s:
        await _seed(s)
        try:
            # AC1 — dev DB 실측(2026-08-01, PO): delivered 4,151 · pending 86 · expired 80 ·
            # failed 0. 넷 다 CHECK를 통과해야 한다(failed는 지금 미사용이어도 구조상 허용).
            for status in ("pending", "delivered", "expired", "failed"):
                await s.execute(text(_insert_event_sql(status)))
            await s.commit()

            result = await s.execute(text(f"SELECT status, count(*) FROM events WHERE org_id='{ORG}' GROUP BY status"))
            counts = dict(result.all())
            assert counts == {"pending": 1, "delivered": 1, "expired": 1, "failed": 1}
        finally:
            await _cleanup(s)
    await engine.dispose()
