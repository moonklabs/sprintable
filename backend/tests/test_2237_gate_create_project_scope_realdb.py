"""#2237(WRITE②) — POST /api/v2/gates(create_gate_endpoint) project-scope IDOR, 실 PG.

갭: create_gate_endpoint 는 resolve_work_item_project_id() 로 project_id 를 조회만 할 뿐(gate_service.py),
caller 가 그 project 에 접근권이 있는지는 전혀 검증하지 않았다 — 형제 get_gate_endpoint(GET /{id})는
동일 project_id 에 has_project_access 를 강제하는데(story #1970) create 경로만 빠져 있었다(#2200 A급
전수 적출). 同org 비-project 멤버가 접근권 없는 project 의 story/doc/task 를 work_item 으로 임의
gate_type(doc_approval 제외) 게이트를 생성할 수 있었다.

처방: 형제(get_gate_endpoint)가 쓰는 것과 동일한 has_project_access, 동일 404 관례("Project not found").
"""
from __future__ import annotations

import os
import uuid

import pytest
from fastapi import HTTPException
from sqlalchemy import text
from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine

_RAW = os.environ.get("ALEMBIC_DATABASE_URL") or os.environ.get("PARITY_TEST_DATABASE_URL") or ""
_ASYNC = _RAW.replace("postgresql+psycopg2://", "postgresql+asyncpg://").replace(
    "postgresql://", "postgresql+asyncpg://"
)

pytestmark = pytest.mark.skipif(not _RAW, reason="real-DB URL 미설정 — skip")

ORG = uuid.UUID("d2237000-0000-0000-0000-000000000001")
CALLER_USER = uuid.UUID("d2237000-0000-0000-0000-0000000000a1")  # project_access: PROJ_A 만
CALLER_OM = uuid.UUID("d2237000-0000-0000-0000-0000000000b1")
PROJ_A = uuid.UUID("d2237000-0000-0000-0000-0000000000c1")  # caller 접근권 有
PROJ_B = uuid.UUID("d2237000-0000-0000-0000-0000000000c2")  # caller 접근권 無
STORY_A = uuid.UUID("d2237000-0000-0000-0000-0000000000d1")
STORY_B = uuid.UUID("d2237000-0000-0000-0000-0000000000d2")


@pytest.fixture
def anyio_backend():
    return "asyncio"


def _auth():
    from app.dependencies.auth import AuthContext
    return AuthContext(user_id=str(CALLER_USER), email=None, claims={}, org_id=str(ORG))


async def _seed(s):
    """ORG · PROJ_A(caller grant)·PROJ_B(caller 무접근) · 각 project 에 story 1건."""
    for sql in [
        f"DELETE FROM gate WHERE org_id='{ORG}'",
        f"DELETE FROM project_access WHERE project_id IN ('{PROJ_A}','{PROJ_B}')",
        f"DELETE FROM org_members WHERE org_id='{ORG}'",
        f"DELETE FROM stories WHERE org_id='{ORG}'",
        f"DELETE FROM projects WHERE org_id='{ORG}'",
        f"DELETE FROM users WHERE id='{CALLER_USER}'",
        f"DELETE FROM organizations WHERE id='{ORG}'",
        f"INSERT INTO organizations (id,name,slug,plan) VALUES ('{ORG}','D2237','d2237-org','free')",
        "INSERT INTO users (id,email,hashed_password,display_name,is_active,email_verified,"
        f"login_fail_count,totp_enabled,totp_fail_count) VALUES "
        f"('{CALLER_USER}','caller@d2237.test','x','Caller',true,true,0,false,0)",
        f"INSERT INTO org_members (id,org_id,user_id,role) VALUES ('{CALLER_OM}','{ORG}','{CALLER_USER}','member')",
        f"INSERT INTO projects (id,org_id,name,slug) VALUES "
        f"('{PROJ_A}','{ORG}','A','proj-a-2237'),('{PROJ_B}','{ORG}','B','proj-b-2237')",
        # caller는 PROJ_A에만 grant — PROJ_B에는 project_access 행 자체가 없다.
        f"INSERT INTO project_access (id,project_id,org_member_id,permission,role) VALUES "
        f"(gen_random_uuid(),'{PROJ_A}','{CALLER_OM}','granted','member')",
        f"INSERT INTO stories (id,org_id,project_id,title,status) VALUES "
        f"('{STORY_A}','{ORG}','{PROJ_A}','Story A','backlog'),"
        f"('{STORY_B}','{ORG}','{PROJ_B}','Story B','backlog')",
    ]:
        await s.execute(text(sql))
    await s.commit()


async def _engine():
    eng = create_async_engine(_ASYNC)
    return eng, async_sessionmaker(eng, expire_on_commit=False)


async def _gate_count(Session, work_item_id):
    async with Session() as s:
        return (await s.execute(
            text("SELECT count(*) FROM gate WHERE work_item_id = :w"), {"w": work_item_id}
        )).scalar_one()


@pytest.mark.anyio
async def test_create_gate_own_project_200():
    """회귀0: PROJ_A grant caller가 PROJ_A story를 work_item으로 qa 게이트 생성 → 성공."""
    from app.routers.gates import GateCreateRequest, create_gate_endpoint
    eng, Session = await _engine()
    try:
        async with Session() as s:
            await _seed(s)
        async with Session() as s:
            resp = await create_gate_endpoint(
                body=GateCreateRequest(
                    work_item_id=STORY_A, work_item_type="story", gate_type="qa",
                    member_id=uuid.uuid4(), role_id=uuid.uuid4(),
                ),
                session=s, org_id=ORG, _auth=_auth(),
            )
        assert resp.work_item_id == STORY_A
        assert await _gate_count(Session, STORY_A) == 1
    finally:
        await eng.dispose()


@pytest.mark.anyio
async def test_create_gate_cross_project_blocked_404_not_created():
    """봉인: 접근권 없는 PROJ_B story를 work_item으로 게이트 생성 시도 → 404 + **생성 0건**
    (직전 재조회로 뮤테이션 실증). 수정 前엔 project_id 조회만 하고 접근권 검증이 없어 201로 통과했다."""
    from app.routers.gates import GateCreateRequest, create_gate_endpoint
    eng, Session = await _engine()
    try:
        async with Session() as s:
            await _seed(s)
        async with Session() as s:
            with pytest.raises(HTTPException) as ei:
                await create_gate_endpoint(
                    body=GateCreateRequest(
                        work_item_id=STORY_B, work_item_type="story", gate_type="qa",
                        member_id=uuid.uuid4(), role_id=uuid.uuid4(),
                    ),
                    session=s, org_id=ORG, _auth=_auth(),
                )
            assert ei.value.status_code == 404
        assert await _gate_count(Session, STORY_B) == 0, "cross-project 게이트가 생성됨(IDOR)"
    finally:
        await eng.dispose()
