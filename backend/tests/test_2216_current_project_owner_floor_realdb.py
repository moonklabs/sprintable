"""story #2216(#2215 AC 항목3 전수 스윕 중 발견·오르테가군 확定): `POST /current-project`
(project 선택 — #2212의 "org-briefing으로 보내 고르게 한다" 처방이 최종적으로 기대는 그
동작)이 owner-floor 휴먼(명시 project_access grant 없이 `has_project_access`의 admin_branch
로만 접근하는 org owner/admin)을 **자기 자신조차 아니라고** 거절했다 — 두 겹의 결함:

  ① `is_caller_member`(member_resolver.py, JWT 휴먼 분기)가 `team_members`뷰(members ⋈
     project_access INNER JOIN)만 조회 — owner-floor는 이 뷰에 행이 없어 self-scope 체크
     자체에서 먼저 403("Cannot act as another member")
  ② ①을 통과해도 `set_current_project`의 project-membership 체크가 동일하게 TeamMember만
     조회 — 403("Project membership not found")

①은 assert_caller_is_member/is_caller_member 공용 함수라 current-project 외에도 광범위
콜사이트가 있다(claim/heartbeat/lock류, 자기 docstring 언급) — 여기서 fix하면 그 축 전체가
같이 풀린다. ②는 current_project.py 국소 — has_project_access(project_auth.py, admin_branch
포함 4-branch SSOT)로 교체. 새 규칙 발명 0.

⛔가드 3종 — 양성만 재고 닫지 않는다:
  ① owner-floor 본인이 project 전환 성공(결함 있던 조건 그대로)
  ② 타인의 member_id를 사칭하면 여전히 403(self-scope 방어 안 헐거워짐)
  ③ 기존 team_member 기반(project-scoped) 휴먼은 여전히 정상 동작(회귀 없음)
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

ORG = uuid.UUID("d2216000-0000-0000-0000-000000000010")
OWNER_USER = uuid.UUID("d2216000-0000-0000-0000-000000000011")
OTHER_MEMBER_USER = uuid.UUID("d2216000-0000-0000-0000-000000000012")
TM_HUMAN_USER = uuid.UUID("d2216000-0000-0000-0000-000000000013")
PROJ = uuid.UUID("d2216000-0000-0000-0000-000000000014")


@pytest.fixture
def anyio_backend():
    return "asyncio"


def _auth(user_id: uuid.UUID):
    from app.dependencies.auth import AuthContext
    return AuthContext(user_id=str(user_id), email=None, claims={}, org_id=str(ORG))


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
        f"DELETE FROM users WHERE id IN ('{OWNER_USER}','{OTHER_MEMBER_USER}','{TM_HUMAN_USER}')",
        f"DELETE FROM organizations WHERE id='{ORG}'",
    ]:
        await s.execute(text(sql))
    await s.commit()


async def _seed(s) -> dict[str, uuid.UUID]:
    """owner-floor owner(①②용) + team_member 기반 정상 휴먼(③용, project grant 有)."""
    await _clean(s)
    for sql in [
        f"INSERT INTO organizations (id,name,slug,plan) VALUES ('{ORG}','O','d2216-org','free')",
        f"INSERT INTO users (id,email,hashed_password,display_name,is_active,email_verified,"
        f"login_fail_count,totp_enabled,totp_fail_count) VALUES "
        f"('{OWNER_USER}','owner@d2216.test','x','Owner',true,true,0,false,0),"
        f"('{OTHER_MEMBER_USER}','other@d2216.test','x','Other',true,true,0,false,0),"
        f"('{TM_HUMAN_USER}','tm@d2216.test','x','TM',true,true,0,false,0)",
        f"INSERT INTO projects (id,org_id,name,slug,violation_level) VALUES "
        f"('{PROJ}','{ORG}','P','d2216-proj','warn')",
    ]:
        await s.execute(text(sql))
    owner_row = (await s.execute(text(
        f"INSERT INTO org_members (id,org_id,user_id,role) VALUES "
        f"(gen_random_uuid(),'{ORG}','{OWNER_USER}','owner') RETURNING id"
    ))).one()
    owner_om_id = owner_row[0]
    other_row = (await s.execute(text(
        f"INSERT INTO org_members (id,org_id,user_id,role) VALUES "
        f"(gen_random_uuid(),'{ORG}','{OTHER_MEMBER_USER}','member') RETURNING id"
    ))).one()
    other_om_id = other_row[0]
    # ③용 — 실 team_member(project grant 有) 휴먼. members + project_access(member_id 경유).
    tm_member_id = uuid.uuid4()
    await s.execute(text(
        f"INSERT INTO members (id,org_id,user_id,type,name,is_active) VALUES "
        f"('{tm_member_id}','{ORG}','{TM_HUMAN_USER}','human','TM',true)"
    ))
    await s.execute(text(
        f"INSERT INTO project_access (id,project_id,member_id,permission) VALUES "
        f"(gen_random_uuid(),'{PROJ}','{tm_member_id}','granted')"
    ))
    # ⚠️owner_om_id/other_om_id는 의도적으로 members/project_access 어디에도 안 넣는다
    # (owner-floor만 — project_access grant 없이 접근).
    await s.commit()
    return {"owner_om": owner_om_id, "other_om": other_om_id, "tm_member": tm_member_id}


@pytest.mark.anyio
async def test_owner_floor_can_switch_to_own_project():
    """① 결함이 있던 조건 그대로 — owner-floor 본인이 project 전환 성공."""
    from app.routers.current_project import set_current_project
    from app.schemas.current_project import SetCurrentProject
    eng, Session = await _engine()
    try:
        async with Session() as s:
            ids = await _seed(s)
        async with Session() as s:
            resp = await set_current_project(
                body=SetCurrentProject(project_id=PROJ),
                member_id=ids["owner_om"], session=s, org_id=ORG, auth=_auth(OWNER_USER),
            )
        assert resp.project_id == PROJ
        assert resp.org_id == ORG
    finally:
        await eng.dispose()


@pytest.mark.anyio
async def test_impersonating_another_members_id_still_403():
    """② self-scope 방어 안 헐거워짐 — 타인의 member_id로 호출하면 여전히 403."""
    from app.routers.current_project import set_current_project
    from app.schemas.current_project import SetCurrentProject
    eng, Session = await _engine()
    try:
        async with Session() as s:
            ids = await _seed(s)
        async with Session() as s:
            with pytest.raises(HTTPException) as ei:
                await set_current_project(
                    body=SetCurrentProject(project_id=PROJ),
                    # OWNER_USER가 other_om(타인)의 member_id를 사칭.
                    member_id=ids["other_om"], session=s, org_id=ORG, auth=_auth(OWNER_USER),
                )
        assert ei.value.status_code == 403
        assert "Cannot act as another member" in str(ei.value.detail)
    finally:
        await eng.dispose()


@pytest.mark.anyio
async def test_team_member_based_human_still_works():
    """③ 되던 것이 계속 됨 — project grant 있는 정상 team_member 휴먼은 회귀 없이 통과."""
    from app.routers.current_project import set_current_project
    from app.schemas.current_project import SetCurrentProject
    eng, Session = await _engine()
    try:
        async with Session() as s:
            ids = await _seed(s)
        async with Session() as s:
            resp = await set_current_project(
                body=SetCurrentProject(project_id=PROJ),
                member_id=ids["tm_member"], session=s, org_id=ORG, auth=_auth(TM_HUMAN_USER),
            )
        assert resp.project_id == PROJ
    finally:
        await eng.dispose()
