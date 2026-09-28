"""story #4332 AC2 — 게이트 목록(`list_gates`)의 SQL 수가 게이트 수에 비례하지 않는다(보드 첫 로드 요청 모양 그대로).

dev 실측(28건 · 따뜻한 호출 SQL 19 · 55~59ms)에서 SQL 수는 merge 게이트 수와 무관했다 — 게이트마다 부가 조회를 새로 넣으면
(N+1) 이 가드가 RED. 사람 소유자 호출이라 승인 자격(can_approve) 경로까지 돈다.

범위 밖(PR 본문에 기록): 레시피 게이트(external_publish · concept_approval)의 enrich는 work item마다 조회가 붙는다 — 처방은
요청 계측(대기 vs SQL vs 조립) 뒤. 승인 자격 캐시는 (gate_type, project, designated_approver) 조합당 1회라 지정 승인자가
제각각이면 그 조합 수만큼 늘어난다(구성원 수로 묶임) — 이 가드는 같은 조합의 게이트 수를 늘린다.
"""
from __future__ import annotations

import os
import uuid

import pytest
from sqlalchemy import text
from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine

_RAW = os.environ.get("ALEMBIC_DATABASE_URL") or os.environ.get("PARITY_TEST_DATABASE_URL") or ""
_ASYNC = _RAW.replace("postgresql+psycopg2://", "postgresql+asyncpg://").replace("postgresql://", "postgresql+asyncpg://")
pytestmark = pytest.mark.skipif(not _RAW, reason="real-DB URL 미설정 — skip")

ORG = uuid.UUID("43320000-0000-0000-0000-000000000001")
PROJ = uuid.UUID("43320000-0000-0000-0000-0000000000c1")
OWNER = uuid.UUID("43320000-0000-0000-0000-0000000000a1")
OWNER_OM = uuid.UUID("43320000-0000-0000-0000-0000000000b1")


@pytest.fixture
def anyio_backend():
    return "asyncio"


def _auth():
    from app.dependencies.auth import AuthContext

    return AuthContext(user_id=str(OWNER), email=None, claims={}, org_id=str(ORG))


async def _seed(s, n_gates: int) -> None:
    stmts = [
        f"DELETE FROM gate WHERE org_id='{ORG}'",
        f"DELETE FROM org_members WHERE org_id='{ORG}'",
        f"DELETE FROM stories WHERE org_id='{ORG}'",
        f"DELETE FROM projects WHERE org_id='{ORG}'",
        f"DELETE FROM users WHERE id='{OWNER}'",
        f"DELETE FROM organizations WHERE id='{ORG}'",
        f"INSERT INTO organizations (id,name,slug,plan) VALUES ('{ORG}','S4332','s4332-org','free')",
        "INSERT INTO users (id,email,hashed_password,display_name,is_active,email_verified,login_fail_count,totp_enabled,totp_fail_count) "
        f"VALUES ('{OWNER}','owner@s4332.test','x','Owner',true,true,0,false,0)",
        f"INSERT INTO org_members (id,org_id,user_id,role) VALUES ('{OWNER_OM}','{ORG}','{OWNER}','owner')",
        f"INSERT INTO projects (id,org_id,name,slug,violation_level) VALUES ('{PROJ}','{ORG}','P','s4332-proj','warn')",
    ]
    for i in range(n_gates):
        story = uuid.UUID(int=ORG.int + 0x1000 + i)
        stmts.append(
            f"INSERT INTO stories (id,org_id,project_id,title,status,priority) VALUES ('{story}','{ORG}','{PROJ}','S{i}','in-review','medium')"
        )
        stmts.append(
            "INSERT INTO gate (id,org_id,work_item_id,work_item_type,gate_type,status,neutral_facts,created_at) "
            f"VALUES (gen_random_uuid(),'{ORG}','{story}','story','merge','pending','{{}}',now())"
        )
    for sql in stmts:
        await s.execute(text(sql))
    await s.commit()


async def _sql_count_for(n_gates: int) -> tuple[int, int]:
    from app.core.request_db_timing import begin, end, instrument_engine
    from app.routers.gates import list_gates

    eng = create_async_engine(_ASYNC)
    instrument_engine(eng.sync_engine)
    Session = async_sessionmaker(eng, expire_on_commit=False)
    try:
        async with Session() as s:
            await _seed(s, n_gates)
        async with Session() as s:
            # 보드 첫 로드 요청 모양(kanban-board.tsx) — 한 번 데워 SQLAlchemy 컴파일 캐시 영향을 뺀 뒤 센다.
            kwargs = dict(work_item_id=None, work_item_type="story", status="pending", ids=None, gate_type=None, sort=None,
                          assigned_to_me=False, limit=None, offset=0, session=s, org_id=ORG, auth=_auth())
            await list_gates(**kwargs)
            stats, token = begin()
            try:
                out = await list_gates(**kwargs)
            finally:
                end(token)
        return stats.sql_n, len(out)
    finally:
        await eng.dispose()


@pytest.mark.anyio
async def test_list_gates_sql_count_does_not_grow_with_merge_gates():
    few, n_few = await _sql_count_for(2)
    many, n_many = await _sql_count_for(12)
    assert (n_few, n_many) == (2, 12), "시드가 목록에 다 나와야 가드가 헛돌지 않는다"
    assert few > 0
    assert many == few, f"게이트 2건 SQL {few}개 → 12건 {many}개 — 게이트마다 조회가 붙었다(N+1)"
