"""까심 QA(#1880 embed-switch 中 실 Postgres 재현) — create_session의 sprint↔project 정합 가드.

`POST /api/v2/retros`가 body.sprint_id를 body.project_id 소속인지 검증 없이 신뢰해(FK/CHECK도
부재) 실제로는 다른 project 소속인 sprint를 링크할 수 있었다 — retro-session embed
hypotheses[](session.project_id로 스코프)와 별도 /sprints/{id}/hypotheses(sprint의 실제
project_id로 스코프) 응답이 갈라져 FE엔 "가설이 사라진" 것처럼 보였다.

`_require_item_in_session`(같은 라우터, item_id가 부모 session 소속 아니면 404)과 동일
컨벤션 — 존재하나 이 스코프엔 없는 리소스는 404. 부수효과로 존재하지 않는 sprint_id도
같은 조회 1발로 404 흡수됨을 함께 가드한다.
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

ORG = uuid.UUID("db100000-0000-0000-0000-000000000001")
USER = uuid.UUID("db100000-0000-0000-0000-0000000000a1")
OM = uuid.UUID("db100000-0000-0000-0000-0000000000b1")
PROJ_A = uuid.UUID("db100000-0000-0000-0000-0000000000c1")
PROJ_B = uuid.UUID("db100000-0000-0000-0000-0000000000c2")
SPRINT_A = uuid.UUID("db100000-0000-0000-0000-0000000000d1")  # PROJ_A 소속(정상 케이스)
SPRINT_B = uuid.UUID("db100000-0000-0000-0000-0000000000d2")  # PROJ_B 소속(mismatch 케이스)


@pytest.fixture
def anyio_backend():
    return "asyncio"


def _auth():
    from app.dependencies.auth import AuthContext
    return AuthContext(user_id=str(USER), email=None, claims={}, org_id=str(ORG))


async def _seed(s):
    for sql in [
        f"DELETE FROM retro_sessions WHERE org_id='{ORG}'",
        f"DELETE FROM sprints WHERE id IN ('{SPRINT_A}','{SPRINT_B}')",
        f"DELETE FROM project_access WHERE project_id IN ('{PROJ_A}','{PROJ_B}')",
        f"DELETE FROM org_members WHERE org_id='{ORG}'",
        f"DELETE FROM projects WHERE org_id='{ORG}'",
        f"DELETE FROM users WHERE id='{USER}'",
        f"DELETE FROM organizations WHERE id='{ORG}'",
        f"INSERT INTO organizations (id,name,slug,plan) VALUES ('{ORG}','XVAL','xval-org','free')",
        "INSERT INTO users (id,email,hashed_password,display_name,is_active,email_verified,"
        f"login_fail_count,totp_enabled,totp_fail_count) VALUES ('{USER}','u@xval.test','x','U',true,true,0,false,0)",
        # owner — PROJ_A/PROJ_B 둘 다 org-wide 접근(create_session의 body.project_id 게이트를
        # 항상 통과시켜, 아래 sprint↔project 정합 체크 자체만 정확히 표적 검증한다).
        f"INSERT INTO org_members (id,org_id,user_id,role) VALUES ('{OM}','{ORG}','{USER}','owner')",
        f"INSERT INTO projects (id,org_id,name,violation_level) VALUES ('{PROJ_A}','{ORG}','A','none')",
        f"INSERT INTO projects (id,org_id,name,violation_level) VALUES ('{PROJ_B}','{ORG}','B','none')",
        f"INSERT INTO sprints (id,org_id,project_id,title,status,duration) VALUES "
        f"('{SPRINT_A}','{ORG}','{PROJ_A}','sprint-a','planning',14)",
        f"INSERT INTO sprints (id,org_id,project_id,title,status,duration) VALUES "
        f"('{SPRINT_B}','{ORG}','{PROJ_B}','sprint-b','planning',14)",
    ]:
        await s.execute(text(sql))
    await s.commit()


async def _engine():
    eng = create_async_engine(_ASYNC)
    return eng, async_sessionmaker(eng, expire_on_commit=False)


@pytest.mark.anyio
async def test_cross_project_sprint_link_rejected_404():
    from app.routers.retros import create_session
    from app.schemas.retro import CreateSession

    eng, Session = await _engine()
    try:
        async with Session() as s:
            await _seed(s)
        async with Session() as s:
            body = CreateSession(
                project_id=PROJ_A, org_id=ORG, title="mismatch", sprint_id=SPRINT_B,
            )
            with pytest.raises(HTTPException) as ei:
                await create_session(body, db=s, auth=_auth(), org_id=ORG)
            assert ei.value.status_code == 404

            # 미생성 확인 — 실패한 mutation이 부분 커밋으로 새지 않았는지.
            cnt = (await s.execute(
                text("SELECT count(*) FROM retro_sessions WHERE org_id=:o AND title='mismatch'"),
                {"o": ORG},
            )).scalar_one()
            assert cnt == 0
    finally:
        await eng.dispose()


@pytest.mark.anyio
async def test_same_project_sprint_link_succeeds_201():
    from app.routers.retros import create_session
    from app.schemas.retro import CreateSession

    eng, Session = await _engine()
    try:
        async with Session() as s:
            await _seed(s)
        async with Session() as s:
            body = CreateSession(
                project_id=PROJ_A, org_id=ORG, title="legit", sprint_id=SPRINT_A,
            )
            resp = await create_session(body, db=s, auth=_auth(), org_id=ORG)
            assert resp.sprint_id == SPRINT_A
            assert resp.project_id == PROJ_A
    finally:
        async with Session() as s:
            await s.execute(text("DELETE FROM retro_sessions WHERE org_id=:o"), {"o": ORG})
            await s.commit()
        await eng.dispose()


@pytest.mark.anyio
async def test_nonexistent_sprint_id_rejected_404_not_500():
    """존재 자체가 없는 sprint_id — FK violation(500)이 아니라 동일 조회 1발로 404 흡수."""
    from app.routers.retros import create_session
    from app.schemas.retro import CreateSession

    eng, Session = await _engine()
    try:
        async with Session() as s:
            await _seed(s)
        async with Session() as s:
            body = CreateSession(
                project_id=PROJ_A, org_id=ORG, title="ghost-sprint", sprint_id=uuid.uuid4(),
            )
            with pytest.raises(HTTPException) as ei:
                await create_session(body, db=s, auth=_auth(), org_id=ORG)
            assert ei.value.status_code == 404
    finally:
        await eng.dispose()
