"""story #2216(#2215 AC 항목3 전수 스윕 CONFIRMED-SUSPECT): `get_doc`/`get_doc_preview`의
cross-org fallback 분기(#2168 PR-① 이후 org-scope happy path는 이미 has_project_access를
쓰지만, `repo.get(id)`가 None일 때 타는 이 fallback만 TeamMember를 직접 쿼리)가 owner-floor
휴먼(명시 project_access grant 없이 has_project_access의 admin_branch로만 접근하는 org
owner/admin)을 "해당 프로젝트의 멤버가 아닌"으로 오판했다 — #2215/#2216과 동일 병.

처방: fallback도 primary path와 동일한 has_project_access(project_auth.py, admin_branch
포함 4-branch SSOT) 사용 — 새 규칙 발명 0, 같은 함수 안 두 분기가 이제 같은 기준을 쓴다.

가드 3종:
  ① owner-floor 휴먼이 fallback 경로로 정상 조회(결함이 있던 조건 그대로)
  ② 프로젝트 접근권 자체가 없는 outsider는 여전히 403(방어 안 헐거워짐)
  ③ 기존 team_member 기반(project grant 有) 휴먼은 여전히 정상 동작(회귀 없음)
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

ORG = uuid.UUID("d2216b00-0000-0000-0000-000000000010")
OWNER_USER = uuid.UUID("d2216b00-0000-0000-0000-000000000011")
OUTSIDER_USER = uuid.UUID("d2216b00-0000-0000-0000-000000000012")
TM_HUMAN_USER = uuid.UUID("d2216b00-0000-0000-0000-000000000013")
PROJ = uuid.UUID("d2216b00-0000-0000-0000-000000000014")
# repo.get(id)가 None을 반환하도록(fallback 강제) org-scope가 다른 repo를 구성할 때 쓰는
# "존재하지 않는 다른 org" — 실제 org 행은 안 만든다(repo는 raw org_id UUID만 소비).
FAKE_OTHER_ORG = uuid.UUID("d2216b00-0000-0000-0000-0000000000ff")


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
        f"DELETE FROM docs WHERE org_id='{ORG}'",
        f"DELETE FROM project_access WHERE project_id IN "
        f"(SELECT id FROM projects WHERE org_id='{ORG}')",
        f"DELETE FROM members WHERE org_id='{ORG}'",
        f"DELETE FROM projects WHERE org_id='{ORG}'",
        f"DELETE FROM org_members WHERE org_id='{ORG}'",
        f"DELETE FROM users WHERE id IN ('{OWNER_USER}','{OUTSIDER_USER}','{TM_HUMAN_USER}')",
        f"DELETE FROM organizations WHERE id='{ORG}'",
    ]:
        await s.execute(text(sql))
    await s.commit()


async def _seed(s):
    from app.models.doc import Doc
    await _clean(s)
    for sql in [
        f"INSERT INTO organizations (id,name,slug,plan) VALUES ('{ORG}','O','d2216b-org','free')",
        f"INSERT INTO users (id,email,hashed_password,display_name,is_active,email_verified,"
        f"login_fail_count,totp_enabled,totp_fail_count) VALUES "
        f"('{OWNER_USER}','owner@d2216b.test','x','Owner',true,true,0,false,0),"
        f"('{OUTSIDER_USER}','outsider@d2216b.test','x','Outsider',true,true,0,false,0),"
        f"('{TM_HUMAN_USER}','tm@d2216b.test','x','TM',true,true,0,false,0)",
        f"INSERT INTO projects (id,org_id,name,slug,violation_level) VALUES "
        f"('{PROJ}','{ORG}','P','d2216b-proj','warn')",
    ]:
        await s.execute(text(sql))
    for sql in [
        f"INSERT INTO org_members (id,org_id,user_id,role) VALUES "
        f"(gen_random_uuid(),'{ORG}','{OWNER_USER}','owner')",
        f"INSERT INTO org_members (id,org_id,user_id,role) VALUES "
        f"(gen_random_uuid(),'{ORG}','{OUTSIDER_USER}','member')",
    ]:
        await s.execute(text(sql))
    # ③용 — 실 team_member(project grant 有) 휴먼.
    tm_member_id = uuid.uuid4()
    await s.execute(text(
        f"INSERT INTO members (id,org_id,user_id,type,name,is_active) VALUES "
        f"('{tm_member_id}','{ORG}','{TM_HUMAN_USER}','human','TM',true)"
    ))
    await s.execute(text(
        f"INSERT INTO project_access (id,project_id,member_id,permission) VALUES "
        f"(gen_random_uuid(),'{PROJ}','{tm_member_id}','granted')"
    ))
    # ⚠️OWNER_USER/OUTSIDER_USER: members/project_access 어디에도 안 넣음(owner-floor·무권한 각각).
    doc = Doc(id=uuid.uuid4(), org_id=ORG, project_id=PROJ, title="D", slug=f"s-{uuid.uuid4().hex[:8]}", content="")
    s.add(doc)
    await s.commit()
    return doc.id


@pytest.mark.anyio
async def test_get_doc_owner_floor_via_fallback_succeeds():
    """① owner-floor 휴먼이 fallback 경로로 정상 조회(결함이 있던 조건 그대로)."""
    from app.repositories.doc import DocRepository
    from app.routers.docs import get_doc
    eng, Session = await _engine()
    try:
        async with Session() as s:
            doc_id = await _seed(s)
        async with Session() as s:
            # repo.get(id)가 None을 반환하도록 org 다른 repo로 fallback 강제.
            out = await get_doc(id=doc_id, session=s, auth=_auth(OWNER_USER), repo=DocRepository(s, FAKE_OTHER_ORG))
        assert out.id == doc_id
    finally:
        await eng.dispose()


@pytest.mark.anyio
async def test_get_doc_no_project_access_still_404():
    """② 프로젝트 접근권 자체가 없는 outsider는 여전히 404(방어 안 헐거워짐).
    story #2342(2026-07-30): 무권한을 403이 아닌 404로 통일."""
    from app.repositories.doc import DocRepository
    from app.routers.docs import get_doc
    eng, Session = await _engine()
    try:
        async with Session() as s:
            doc_id = await _seed(s)
        async with Session() as s:
            with pytest.raises(HTTPException) as ei:
                await get_doc(id=doc_id, session=s, auth=_auth(OUTSIDER_USER), repo=DocRepository(s, FAKE_OTHER_ORG))
        assert ei.value.status_code == 404
    finally:
        await eng.dispose()


@pytest.mark.anyio
async def test_get_doc_preview_team_member_still_works():
    """③ 되던 것이 계속 됨 — project grant 있는 정상 team_member 휴먼은 fallback 에서도 무회귀."""
    from app.repositories.doc import DocRepository
    from app.routers.docs import get_doc_preview
    eng, Session = await _engine()
    try:
        async with Session() as s:
            doc_id = await _seed(s)
        async with Session() as s:
            out = await get_doc_preview(q=str(doc_id), db=s, auth=_auth(TM_HUMAN_USER), repo=DocRepository(s, FAKE_OTHER_ORG))
        assert out.id == doc_id
    finally:
        await eng.dispose()


@pytest.mark.anyio
async def test_get_doc_rejects_dangling_project_access_outside_org():
    """④ 방어심층(오르테가군 지적, 2026-07-27) — «project_access(org_member_id 경유) 행은
    남았지만 그 org_member 는 doc.org_id 소속이 아닌» 가상 상태를 수동으로 만들어(정상
    앱 플로우로는 org_members.py의 delete_org_member가 project_access를 같이 지워 도달
    불가 — S-MBR-10 AC5) doc.org_id 스코프(human_grant_branch의 org_scope_human_grand=
    OrgMember.org_id==org_id)가 그 상태를 여전히 거부하는지 직접 증명한다.
    ⛔story #2342(2026-07-30): 무권한을 403이 아닌 404로 통일.
    ⛔team_member_branch(members⋈project_access, org 무관)로 새지 않도록 members 행은
    안 만든다 — 오직 org_members/project_access.org_member_id 축만 구성해 human_grant_
    branch 하나만 겨눈다. org_id=None(필터 완전 해제)이었다면 이 caller는 project_access
    존재 + user_id 매치만으로 통과했을 것(어느 org 소속인지 안 봄) — doc.org_id가 그보다
    좁다는 것의 실행 증거."""
    from app.repositories.doc import DocRepository
    from app.routers.docs import get_doc
    eng, Session = await _engine()
    try:
        async with Session() as s:
            doc_id = await _seed(s)
            # OUTSIDER_USER를 FAKE_OTHER_ORG(=doc.org_id인 ORG와 다른 org)의 org_member로
            # 만들고, 그 org_member_id로 doc의 project에 대한 project_access grant를 심는다.
            # organizations 행은 raw UUID만 소비하는 FK-미강제 필드라 FAKE_OTHER_ORG는
            # 실제 organizations 행 없이도 org_members.org_id에 넣을 수 있다.
            dangling_om_row = (await s.execute(text(
                f"INSERT INTO org_members (id,org_id,user_id,role) VALUES "
                f"(gen_random_uuid(),'{FAKE_OTHER_ORG}','{OUTSIDER_USER}','member') RETURNING id"
            ))).one()
            dangling_om_id = dangling_om_row[0]
            await s.execute(text(
                f"INSERT INTO project_access (id,project_id,org_member_id,permission) VALUES "
                f"(gen_random_uuid(),'{PROJ}','{dangling_om_id}','granted')"
            ))
            await s.commit()
        async with Session() as s:
            with pytest.raises(HTTPException) as ei:
                await get_doc(id=doc_id, session=s, auth=_auth(OUTSIDER_USER), repo=DocRepository(s, FAKE_OTHER_ORG))
        assert ei.value.status_code == 404
    finally:
        await eng.dispose()
