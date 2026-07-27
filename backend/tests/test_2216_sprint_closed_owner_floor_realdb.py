"""story #2216 「전달누락 계열」 — `sprints.py:424`(close_sprint, E-EVENTBUS P3 S9: sprint_closed
→ 프로젝트 전체 active 멤버 알림)이 `TeamMember`(=team_members뷰, members ⋈ project_access
INNER JOIN) 단독 조회로 알림 대상을 골랐다 — grant-only 휴먼(project_access를 org_member_id
경유로만 가진 멤버)과 owner-floor org owner/admin(명시 project_access grant 없이
has_project_access의 admin_branch org-wide floor로만 이 프로젝트에 접근하는 멤버)이 이 뷰에
행이 없어 조용히 빠졌다.

⛔이 결함 클래스는 403 같은 눈에 보이는 실패가 아니라 **아무 일도 안 일어나는 것**이라 —
「안 왔다」와 「애초에 알림 로직이 안 도는 상황」이 구별 안 된다(오르테가군 지적, 2026-07-27).
그래서 이 파일은 반드시 **양성대조**를 먼저 세운다: team_member 기반(project grant 有) 휴먼은
같은 이벤트에서 실제로 알림을 받는다는 것을 먼저 확認한 뒤, grant-only/owner-floor 휴먼이
못 받는 것을 본다 — 그래야 「누락」이 증명된다(#2206/#2216 team_members.py:338과 동형 규율).

처방: member_ids에 has_project_access의 human_grant/owner-admin-floor 두 분기를 OrgMember.id
로 재현해 set 합집합 — dispatch_notification 자신이 이미 org_member.id 축 grant-only 휴먼
해소를 지원한다(E-MEMBER-SSOT AC2-2).
"""
from __future__ import annotations

import os
import uuid

import pytest
from sqlalchemy import select, text
from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine

_RAW = os.environ.get("ALEMBIC_DATABASE_URL") or os.environ.get("PARITY_TEST_DATABASE_URL") or ""
_ASYNC = _RAW.replace("postgresql+psycopg2://", "postgresql+asyncpg://").replace(
    "postgresql://", "postgresql+asyncpg://"
)

pytestmark = pytest.mark.skipif(not _RAW, reason="real-DB URL 미설정 — skip")

ORG = uuid.UUID("d2216f00-0000-0000-0000-000000000010")
PROJ = uuid.UUID("d2216f00-0000-0000-0000-000000000011")
TM_HUMAN_USER = uuid.UUID("d2216f00-0000-0000-0000-000000000012")
GRANT_ONLY_USER = uuid.UUID("d2216f00-0000-0000-0000-000000000013")
OWNER_FLOOR_ADMIN_USER = uuid.UUID("d2216f00-0000-0000-0000-000000000014")


@pytest.fixture
def anyio_backend():
    return "asyncio"


def _actor_auth():
    """owner-floor admin 본인이 sprint를 마감(actor) — has_project_access의 org-wide floor로
    project 접근이 통과되므로 team_member/project_access grant 없이도 close 호출이 가능."""
    from app.dependencies.auth import AuthContext
    return AuthContext(
        user_id=str(OWNER_FLOOR_ADMIN_USER), email=None,
        claims={"app_metadata": {"org_id": str(ORG)}},
        org_id=str(ORG),
    )


async def _engine():
    eng = create_async_engine(_ASYNC)
    return eng, async_sessionmaker(eng, expire_on_commit=False)


async def _clean(s):
    for sql in [
        f"DELETE FROM notifications WHERE org_id='{ORG}'",
        f"DELETE FROM sprints WHERE project_id='{PROJ}'",
        f"DELETE FROM project_access WHERE project_id='{PROJ}'",
        f"DELETE FROM members WHERE org_id='{ORG}'",
        f"DELETE FROM projects WHERE org_id='{ORG}'",
        f"DELETE FROM org_members WHERE org_id='{ORG}'",
        f"DELETE FROM users WHERE id IN "
        f"('{TM_HUMAN_USER}','{GRANT_ONLY_USER}','{OWNER_FLOOR_ADMIN_USER}')",
        f"DELETE FROM organizations WHERE id='{ORG}'",
    ]:
        await s.execute(text(sql))
    await s.commit()


async def _seed(s, *, include_grant_only: bool) -> uuid.UUID:
    """TM_HUMAN(project grant 有 — 양성대조) + OWNER_FLOOR_ADMIN(grant 無, org-wide floor, actor
    겸용) + (옵션)GRANT_ONLY_HUMAN(project_access를 org_member_id 경유로만 有). sprint.id 반환."""
    await _clean(s)
    for sql in [
        f"INSERT INTO organizations (id,name,slug,plan) VALUES ('{ORG}','O','d2216f-org','free')",
        f"INSERT INTO users (id,email,hashed_password,display_name,is_active,email_verified,"
        f"login_fail_count,totp_enabled,totp_fail_count) VALUES "
        f"('{TM_HUMAN_USER}','tmhuman@d2216f.test','x','TMHuman',true,true,0,false,0),"
        f"('{GRANT_ONLY_USER}','grantonly@d2216f.test','x','GrantOnly',true,true,0,false,0),"
        f"('{OWNER_FLOOR_ADMIN_USER}','ownerfloor@d2216f.test','x','OwnerFloor',true,true,0,false,0)",
        f"INSERT INTO projects (id,org_id,name,slug,violation_level) VALUES "
        f"('{PROJ}','{ORG}','P','d2216f-proj','warn')",
        f"INSERT INTO org_members (id,org_id,user_id,role) VALUES "
        f"(gen_random_uuid(),'{ORG}','{OWNER_FLOOR_ADMIN_USER}','owner')",
        # ⚠️OWNER_FLOOR_ADMIN_USER: members/project_access 어디에도 안 넣음(owner-floor만).
    ]:
        await s.execute(text(sql))

    tm_member_id = uuid.uuid4()
    await s.execute(text(
        f"INSERT INTO members (id,org_id,user_id,type,name,is_active) VALUES "
        f"('{tm_member_id}','{ORG}','{TM_HUMAN_USER}','human','TMHuman',true)"
    ))
    await s.execute(text(
        f"INSERT INTO project_access (id,project_id,member_id,role,permission) VALUES "
        f"(gen_random_uuid(),'{PROJ}','{tm_member_id}','member','granted')"
    ))

    if include_grant_only:
        grant_only_om = (await s.execute(text(
            f"INSERT INTO org_members (id,org_id,user_id,role) VALUES "
            f"(gen_random_uuid(),'{ORG}','{GRANT_ONLY_USER}','member') RETURNING id"
        ))).one()
        await s.execute(text(
            f"INSERT INTO project_access (id,project_id,org_member_id,role,permission) VALUES "
            f"(gen_random_uuid(),'{PROJ}','{grant_only_om[0]}','member','granted')"
        ))
        # ⚠️GRANT_ONLY_USER: members/team_members 어디에도 안 넣음(team_member 행 없음).

    sprint_id = uuid.uuid4()
    await s.execute(text(
        f"INSERT INTO sprints (id,org_id,project_id,title,status,duration) VALUES "
        f"('{sprint_id}','{ORG}','{PROJ}','Sprint 1','active',14)"
    ))
    await s.commit()
    return sprint_id


async def _close_sprint_and_collect_notified_user_ids(s, sprint_id: uuid.UUID) -> set[uuid.UUID]:
    from app.models.notification import Notification
    from app.routers.sprints import close_sprint

    await close_sprint(id=sprint_id, db=s, org_id=ORG, auth=_actor_auth())
    await s.commit()
    rows = (await s.execute(
        select(Notification.user_id).where(Notification.org_id == ORG, Notification.type == "sprint_closed")
    )).all()
    return {r[0] for r in rows}


@pytest.mark.anyio
async def test_positive_control_team_member_human_gets_notified():
    """양성대조 — team_member 기반(project grant 有) 휴먼은 실제로 알림을 받는다(먼저 확認)."""
    eng, Session = await _engine()
    try:
        async with Session() as s:
            sprint_id = await _seed(s, include_grant_only=False)
        async with Session() as s:
            notified = await _close_sprint_and_collect_notified_user_ids(s, sprint_id)
        assert TM_HUMAN_USER in notified, "양성대조 실패 — 정상 team_member도 못 받으면 이 테스트 설계 자체가 무효"
    finally:
        await eng.dispose()


@pytest.mark.anyio
async def test_grant_only_and_owner_floor_get_notified_after_fix():
    """① grant-only 휴먼 + owner-floor admin이 실제로 알림을 받는다(결함이 있던 조건 그대로 재현 + 수정 확認)."""
    eng, Session = await _engine()
    try:
        async with Session() as s:
            sprint_id = await _seed(s, include_grant_only=True)
        async with Session() as s:
            notified = await _close_sprint_and_collect_notified_user_ids(s, sprint_id)
        assert TM_HUMAN_USER in notified, "양성대조 축(같은 이벤트의 정상 team_member)까지 깨지면 다른 문제"
        assert GRANT_ONLY_USER in notified, "grant-only 휴먼이 여전히 알림을 못 받음(전달누락 재발)"
        assert OWNER_FLOOR_ADMIN_USER in notified, "owner-floor admin이 여전히 알림을 못 받음(전달누락 재발)"
    finally:
        await eng.dispose()
