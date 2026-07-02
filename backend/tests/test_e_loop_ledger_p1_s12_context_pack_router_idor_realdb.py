"""E-LOOP-LEDGER P1-S12: GET /loops/{id}/context-pack 라우터 와이어링 검증(doc fbe5923e §3).

authz 로직 자체(require_loop_project_access의 cross-project 403)는 이미
test_e_loop_ledger_s3_loop_crud_api.py::test_get_loop_cross_project_forbidden_same_project_ok가
검증한다(get_loop과 동일 함수 재사용) — 여기선 신규 라우트가 그 함수를 실제로 호출하는지(와이어링
자체)와 정상 경로에서 ContextPackResponse가 실제로 조립되는지만 확인한다.
"""
from __future__ import annotations

import os
import uuid
from unittest.mock import patch

import pytest
from fastapi import HTTPException
from sqlalchemy import text
from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine

_RAW = os.environ.get("ALEMBIC_DATABASE_URL") or os.environ.get("PARITY_TEST_DATABASE_URL") or ""
_ASYNC = _RAW.replace("postgresql+psycopg2://", "postgresql+asyncpg://").replace(
    "postgresql://", "postgresql+asyncpg://"
)
pytestmark_db = pytest.mark.skipif(not _RAW, reason="real-DB URL 미설정 — skip")

ORG = uuid.UUID("1c100000-0000-0000-0000-000000000001")
USER = uuid.UUID("1c100000-0000-0000-0000-0000000000a1")
OM = uuid.UUID("1c100000-0000-0000-0000-0000000000b1")
PROJ_A = uuid.UUID("1c100000-0000-0000-0000-0000000000c1")
PROJ_B = uuid.UUID("1c100000-0000-0000-0000-0000000000c2")


@pytest.fixture
def anyio_backend():
    return "asyncio"


def _auth():
    from app.dependencies.auth import AuthContext
    return AuthContext(user_id=str(USER), email=None, claims={}, org_id=str(ORG))


async def _seed(s):
    for sql in [
        f"DELETE FROM loop_runs WHERE org_id='{ORG}'",
        f"DELETE FROM project_access WHERE project_id IN ('{PROJ_A}','{PROJ_B}')",
        f"DELETE FROM org_members WHERE org_id='{ORG}'",
        f"DELETE FROM projects WHERE org_id='{ORG}'",
        f"DELETE FROM users WHERE id='{USER}'",
        f"DELETE FROM organizations WHERE id='{ORG}'",
        f"INSERT INTO organizations (id,name,slug,plan) VALUES ('{ORG}','C1D','c1dorg','free')",
        "INSERT INTO users (id,email,hashed_password,display_name,is_active,email_verified,"
        f"login_fail_count,totp_enabled,totp_fail_count) VALUES ('{USER}','u@c1d.test','x','U',true,true,0,false,0)",
        f"INSERT INTO org_members (id,org_id,user_id,role) VALUES ('{OM}','{ORG}','{USER}','member')",
        f"INSERT INTO projects (id,org_id,name) VALUES ('{PROJ_A}','{ORG}','A')",
        f"INSERT INTO projects (id,org_id,name) VALUES ('{PROJ_B}','{ORG}','B')",
        f"INSERT INTO project_access (id,project_id,org_member_id,permission) "
        f"VALUES (gen_random_uuid(),'{PROJ_A}','{OM}','granted')",
    ]:
        await s.execute(text(sql))
    await s.commit()


async def _engine():
    eng = create_async_engine(_ASYNC)
    return eng, async_sessionmaker(eng, expire_on_commit=False)


@pytestmark_db
@pytest.mark.anyio
async def test_context_pack_cross_project_forbidden_same_project_ok():
    from app.repositories.loop import LoopRunRepository
    from app.routers import loops as r

    eng, Session = await _engine()
    try:
        async with Session() as s:
            await _seed(s)
            repo = LoopRunRepository(s, ORG)
            loop_b = await repo.create(
                project_id=PROJ_B, title="B loop", goal_tags=[], status="draft",
                created_by_member_id=uuid.uuid4(),
            )
            loop_a = await repo.create(
                project_id=PROJ_A, title="A loop", goal_tags=[], status="draft",
                created_by_member_id=uuid.uuid4(),
            )
            await s.commit()
            loop_b_id, loop_a_id = loop_b.id, loop_a.id

        # cross-project(PROJ_B·USER 무접근) → 403(require_loop_project_access 와이어링 확인).
        async with Session() as s:
            with pytest.raises(HTTPException) as ei:
                await r.get_loop_context_pack(loop_id=loop_b_id, session=s, auth=_auth(), org_id=ORG)
            assert ei.value.status_code == 403
            assert ei.value.detail["code"] == "LOOP_PROJECT_ACCESS_DENIED"

        # same-project(PROJ_A·grant) → 통과+ContextPackResponse 조립(embed 불가 → 빈 items).
        async with Session() as s:
            with patch("app.services.embedding_client.embed_text", return_value=None):
                out = await r.get_loop_context_pack(loop_id=loop_a_id, session=s, auth=_auth(), org_id=ORG)
            assert out.items == []
            assert out.embed_available is False
    finally:
        await eng.dispose()
