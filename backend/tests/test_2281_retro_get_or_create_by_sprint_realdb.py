"""story #2281 AC3ⓐ·AC5 — POST /api/v2/retros/by-sprint(신설) 실PG 왕복 검증.

MCP `get_retro_session`이 부르던 get-or-create-by-sprint 메커니즘이 서버에 아예 없었다
(#2271 발견 — 도구는 등재됐지만 한 번도 정상 실행된 적 없었다). 이 라우트를 새로 만들고,
다음을 실PG로 고정한다: ①없으면 생성 ②있으면 «같은» 세션을 반환(멱등 — 매 호출마다
새로 안 만듦) ③project 접근권 없는 caller는 403 ④존재하지 않는 sprint_id는 404.
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

ORG = uuid.UUID("d2281000-0000-0000-0000-000000000001")
USER_IN = uuid.UUID("d2281000-0000-0000-0000-0000000000a1")   # PROJ 접근 O
USER_OUT = uuid.UUID("d2281000-0000-0000-0000-0000000000a2")  # PROJ 접근 X
OM_IN = uuid.UUID("d2281000-0000-0000-0000-0000000000b1")
OM_OUT = uuid.UUID("d2281000-0000-0000-0000-0000000000b2")
PROJ = uuid.UUID("d2281000-0000-0000-0000-000000000c01")
OTHER_PROJ = uuid.UUID("d2281000-0000-0000-0000-000000000c02")
SPRINT = uuid.UUID("d2281000-0000-0000-0000-000000000d01")


@pytest.fixture
def anyio_backend():
    return "asyncio"


def _auth(user_id: uuid.UUID):
    from app.dependencies.auth import AuthContext
    return AuthContext(user_id=str(user_id), email=None, claims={}, org_id=str(ORG))


async def _engine():
    eng = create_async_engine(_ASYNC)
    return eng, async_sessionmaker(eng, expire_on_commit=False)


async def _seed(s):
    for sql in [
        f"DELETE FROM retro_sessions WHERE org_id='{ORG}'",
        f"DELETE FROM sprints WHERE org_id='{ORG}'",
        f"DELETE FROM project_access WHERE project_id IN ('{PROJ}','{OTHER_PROJ}')",
        f"DELETE FROM org_members WHERE org_id='{ORG}'",
        f"DELETE FROM members WHERE org_id='{ORG}'",
        f"DELETE FROM projects WHERE org_id='{ORG}'",
        f"DELETE FROM users WHERE id IN ('{USER_IN}','{USER_OUT}')",
        f"DELETE FROM organizations WHERE id='{ORG}'",
        f"INSERT INTO organizations (id,name,slug,plan) VALUES ('{ORG}','D2281','d2281-org','free')",
        "INSERT INTO users (id,email,hashed_password,display_name,is_active,email_verified,"
        f"login_fail_count,totp_enabled,totp_fail_count) VALUES "
        f"('{USER_IN}','in@d2281.test','x','In',true,true,0,false,0),"
        f"('{USER_OUT}','out@d2281.test','x','Out',true,true,0,false,0)",
        f"INSERT INTO org_members (id,org_id,user_id,role) VALUES "
        f"('{OM_IN}','{ORG}','{USER_IN}','member'),('{OM_OUT}','{ORG}','{USER_OUT}','member')",
        f"INSERT INTO members (id,org_id,user_id,type,name,is_active) VALUES "
        f"('{OM_IN}','{ORG}','{USER_IN}','human','In',true),"
        f"('{OM_OUT}','{ORG}','{USER_OUT}','human','Out',true)",
        f"INSERT INTO projects (id,org_id,name) VALUES ('{PROJ}','{ORG}','P'),('{OTHER_PROJ}','{ORG}','P2')",
        f"INSERT INTO project_access (id,project_id,org_member_id,permission) "
        f"VALUES (gen_random_uuid(),'{PROJ}','{OM_IN}','granted')",
        f"INSERT INTO sprints (id,org_id,project_id,title,status,duration) VALUES "
        f"('{SPRINT}','{ORG}','{PROJ}','Sprint 1','active',14)",
    ]:
        await s.execute(text(sql))
    await s.commit()


@pytest.mark.anyio
async def test_creates_session_when_none_exists_realdb():
    from app.routers.retros import get_or_create_session_by_sprint
    from app.schemas.retro import GetOrCreateBySprint

    eng, Session = await _engine()
    try:
        async with Session() as s:
            await _seed(s)

        async with Session() as s:
            resp = await get_or_create_session_by_sprint(
                GetOrCreateBySprint(sprint_id=SPRINT), db=s, auth=_auth(USER_IN), org_id=ORG,
            )
        assert resp.sprint_id == SPRINT
        assert resp.project_id == PROJ
        assert resp.title == "Sprint 1 회고"  # 기본 제목 파생 확認
    finally:
        await eng.dispose()


@pytest.mark.anyio
async def test_second_call_returns_same_session_not_a_new_one_realdb():
    """멱등성 — get-or-create의 핵심. 두 번째 호출이 새 세션을 또 만들면 안 된다."""
    from app.routers.retros import get_or_create_session_by_sprint
    from app.schemas.retro import GetOrCreateBySprint

    eng, Session = await _engine()
    try:
        async with Session() as s:
            await _seed(s)

        async with Session() as s:
            first = await get_or_create_session_by_sprint(
                GetOrCreateBySprint(sprint_id=SPRINT), db=s, auth=_auth(USER_IN), org_id=ORG,
            )
            await s.commit()  # get_db()의 실 프로덕션 커밋을 흉내(app/core/database.py:77)
        async with Session() as s:
            second = await get_or_create_session_by_sprint(
                GetOrCreateBySprint(sprint_id=SPRINT), db=s, auth=_auth(USER_IN), org_id=ORG,
            )
            await s.commit()
        assert first.id == second.id

        async with Session() as s:
            count = (await s.execute(
                text(f"SELECT count(*) FROM retro_sessions WHERE sprint_id='{SPRINT}'")
            )).scalar_one()
        assert count == 1, "get-or-create 두 번 불러도 세션이 하나여야 한다"
    finally:
        await eng.dispose()


@pytest.mark.anyio
async def test_custom_title_used_on_create_realdb():
    from app.routers.retros import get_or_create_session_by_sprint
    from app.schemas.retro import GetOrCreateBySprint

    eng, Session = await _engine()
    try:
        async with Session() as s:
            await _seed(s)

        async with Session() as s:
            resp = await get_or_create_session_by_sprint(
                GetOrCreateBySprint(sprint_id=SPRINT, title="커스텀 제목"),
                db=s, auth=_auth(USER_IN), org_id=ORG,
            )
        assert resp.title == "커스텀 제목"
    finally:
        await eng.dispose()


@pytest.mark.anyio
async def test_no_project_access_is_403_realdb():
    from app.routers.retros import get_or_create_session_by_sprint
    from app.schemas.retro import GetOrCreateBySprint

    eng, Session = await _engine()
    try:
        async with Session() as s:
            await _seed(s)

        async with Session() as s:
            with pytest.raises(HTTPException) as ei:
                await get_or_create_session_by_sprint(
                    GetOrCreateBySprint(sprint_id=SPRINT), db=s, auth=_auth(USER_OUT), org_id=ORG,
                )
            assert ei.value.status_code == 403
    finally:
        await eng.dispose()


@pytest.mark.anyio
async def test_nonexistent_sprint_is_404_realdb():
    from app.routers.retros import get_or_create_session_by_sprint
    from app.schemas.retro import GetOrCreateBySprint

    eng, Session = await _engine()
    try:
        async with Session() as s:
            await _seed(s)

        async with Session() as s:
            with pytest.raises(HTTPException) as ei:
                await get_or_create_session_by_sprint(
                    GetOrCreateBySprint(sprint_id=uuid.uuid4()), db=s, auth=_auth(USER_IN), org_id=ORG,
                )
            assert ei.value.status_code == 404
    finally:
        await eng.dispose()
