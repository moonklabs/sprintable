"""story #2216(#2215 AC 항목3 전수 스윕 CONFIRMED-SUSPECT): `ws_chat.py`의 `_authenticate`
(WS `/ws/chat/{agent_id}` JWT 휴먼 분기)가 `TeamMember`(=team_members뷰, members ⋈
project_access INNER JOIN) 단독 조회로 caller 신원을 해소했다 — owner-floor 휴먼(명시
project_access grant 없이 has_project_access의 admin_branch로만 접근하는 org owner/admin)
은 이 뷰에 행이 없어 `_authenticate`가 `None`을 반환 → WS 연결 자체가 Unauthorized(4001)로
거부됐다.

처방: TeamMember 조회가 빈 채로 오면 org_members SSOT(filter_org_member_ids와 동일 축)로
폴백 — 이 라우터가 caller에서 실제로 쓰는 필드(.id/.org_id)만 담는 최소 dataclass로 반환.
새 규칙 발명 0.

가드 3종:
  ① owner-floor 휴먼이 _authenticate로 정상 신원 해소(결함이 있던 조건 그대로)
  ② 유효하지 않은/미소속 사용자는 여전히 None(방어 안 헐거워짐)
  ③ 기존 team_member 기반(project grant 有) 휴먼은 여전히 정상 동작(회귀 없음)
"""
from __future__ import annotations

import os
import uuid

import pytest
from sqlalchemy import text
from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine

_RAW = os.environ.get("ALEMBIC_DATABASE_URL") or os.environ.get("PARITY_TEST_DATABASE_URL") or ""
_ASYNC = _RAW.replace("postgresql+psycopg2://", "postgresql+asyncpg://").replace(
    "postgresql://", "postgresql+asyncpg://"
)

pytestmark = pytest.mark.skipif(not _RAW, reason="real-DB URL 미설정 — skip")


@pytest.fixture
def anyio_backend():
    return "asyncio"

ORG = uuid.UUID("d2216c00-0000-0000-0000-000000000010")
OWNER_USER = uuid.UUID("d2216c00-0000-0000-0000-000000000011")
TM_HUMAN_USER = uuid.UUID("d2216c00-0000-0000-0000-000000000012")
UNKNOWN_USER = uuid.UUID("d2216c00-0000-0000-0000-000000000013")
PROJ = uuid.UUID("d2216c00-0000-0000-0000-000000000014")


async def _engine():
    eng = create_async_engine(_ASYNC)
    return eng, async_sessionmaker(eng, expire_on_commit=False)


async def _clean(s):
    for sql in [
        f"DELETE FROM project_access WHERE project_id IN "
        f"(SELECT id FROM projects WHERE org_id='{ORG}')",
        f"DELETE FROM members WHERE org_id='{ORG}'",
        f"DELETE FROM projects WHERE org_id='{ORG}'",
        f"DELETE FROM org_members WHERE org_id='{ORG}'",
        f"DELETE FROM users WHERE id IN ('{OWNER_USER}','{TM_HUMAN_USER}')",
        f"DELETE FROM organizations WHERE id='{ORG}'",
    ]:
        await s.execute(text(sql))
    await s.commit()


async def _seed(s) -> uuid.UUID:
    await _clean(s)
    for sql in [
        f"INSERT INTO organizations (id,name,slug,plan) VALUES ('{ORG}','O','d2216c-org','free')",
        f"INSERT INTO users (id,email,hashed_password,display_name,is_active,email_verified,"
        f"login_fail_count,totp_enabled,totp_fail_count) VALUES "
        f"('{OWNER_USER}','owner@d2216c.test','x','Owner',true,true,0,false,0),"
        f"('{TM_HUMAN_USER}','tm@d2216c.test','x','TM',true,true,0,false,0)",
        f"INSERT INTO projects (id,org_id,name,slug,violation_level) VALUES "
        f"('{PROJ}','{ORG}','P','d2216c-proj','warn')",
    ]:
        await s.execute(text(sql))
    owner_row = (await s.execute(text(
        f"INSERT INTO org_members (id,org_id,user_id,role) VALUES "
        f"(gen_random_uuid(),'{ORG}','{OWNER_USER}','owner') RETURNING id"
    ))).one()
    owner_om_id = owner_row[0]
    tm_member_id = uuid.uuid4()
    await s.execute(text(
        f"INSERT INTO members (id,org_id,user_id,type,name,is_active) VALUES "
        f"('{tm_member_id}','{ORG}','{TM_HUMAN_USER}','human','TM',true)"
    ))
    await s.execute(text(
        f"INSERT INTO project_access (id,project_id,member_id,permission) VALUES "
        f"(gen_random_uuid(),'{PROJ}','{tm_member_id}','granted')"
    ))
    # ⚠️OWNER_USER: members/project_access 어디에도 안 넣음(owner-floor만).
    await s.commit()
    return owner_om_id


@pytest.mark.anyio
async def test_authenticate_owner_floor_resolves_identity():
    """① owner-floor 휴먼이 _authenticate로 정상 신원 해소(결함이 있던 조건 그대로)."""
    from app.core.security import create_access_token
    from app.routers.ws_chat import _authenticate

    eng, Session = await _engine()
    try:
        async with Session() as s:
            owner_om_id = await _seed(s)
        token = create_access_token(user_id=str(OWNER_USER))
        # _authenticate는 app.core.database.async_session_factory(모듈-레벨 전역 engine)를
        # 직접 쓴다 — pytest-anyio는 테스트마다 새 event loop를 돌려 전역 engine과 루프가
        # 어긋난다("attached to a different loop"). 이 테스트 자신의 loop에 바인딩된
        # Session으로 패치(test_2139_presence_recipient_source_realdb.py 선례와 동일 관례).
        import contextlib
        import unittest.mock

        @contextlib.asynccontextmanager
        async def _factory():
            async with Session() as s2:
                yield s2

        with unittest.mock.patch("app.routers.ws_chat.async_session_factory", _factory):
            caller = await _authenticate(api_key=None, token=token)
        assert caller is not None
        assert caller.id == owner_om_id
        assert caller.org_id == ORG
    finally:
        await eng.dispose()


@pytest.mark.anyio
async def test_authenticate_unknown_user_still_none():
    """② org에 없는 사용자는 여전히 인증 실패(방어 안 헐거워짐)."""
    from app.core.security import create_access_token
    from app.routers.ws_chat import _authenticate

    eng, Session = await _engine()
    try:
        async with Session() as s:
            await _seed(s)
        token = create_access_token(user_id=str(UNKNOWN_USER))
        import contextlib
        import unittest.mock

        @contextlib.asynccontextmanager
        async def _factory():
            async with Session() as s2:
                yield s2

        with unittest.mock.patch("app.routers.ws_chat.async_session_factory", _factory):
            caller = await _authenticate(api_key=None, token=token)
        assert caller is None
    finally:
        await eng.dispose()


@pytest.mark.anyio
async def test_authenticate_team_member_still_works():
    """③ 되던 것이 계속 됨 — project grant 있는 정상 team_member 휴먼은 무회귀."""
    from app.core.security import create_access_token
    from app.routers.ws_chat import _authenticate

    eng, Session = await _engine()
    try:
        async with Session() as s:
            await _seed(s)
        token = create_access_token(user_id=str(TM_HUMAN_USER))
        import contextlib
        import unittest.mock

        @contextlib.asynccontextmanager
        async def _factory():
            async with Session() as s2:
                yield s2

        with unittest.mock.patch("app.routers.ws_chat.async_session_factory", _factory):
            caller = await _authenticate(api_key=None, token=token)
        assert caller is not None
        assert caller.org_id == ORG
    finally:
        await eng.dispose()
