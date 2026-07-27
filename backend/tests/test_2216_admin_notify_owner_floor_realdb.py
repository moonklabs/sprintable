"""story #2216 「전달누락 계열」 — `team_members.py:338`(create_team_member, AP-S2: 에이전트가
에이전트를 생성하면 owner/admin 휴먼에게 "새 에이전트 합류" 알림)이 `TeamMember`(=team_members뷰,
members ⋈ project_access INNER JOIN) 단독 조회로 알림 대상 admin/owner를 골랐다 — owner-floor
admin/owner(명시 project_access grant 없이 has_project_access의 admin_branch로만 접근)는
이 뷰에 행이 없어 admin_ids에서 조용히 빠졌다.

⛔이 결함 클래스는 403 같은 눈에 보이는 실패가 아니라 **아무 일도 안 일어나는 것**이라 —
「안 왔다」와 「애초에 알림 로직이 안 도는 상황」이 구별 안 된다(오르테가군 지적, 2026-07-27).
그래서 이 파일은 반드시 **양성대조**를 먼저 세운다: team_member 기반(project grant 有) admin은
같은 이벤트에서 실제로 알림을 받는다는 것을 먼저 확認한 뒤, owner-floor admin이 못 받는 것을
본다 — 그래야 「누락」이 증명된다(#2206에서 실 댓글 하나 만들어 양성 콘텐츠를 확認한 것과 동형
규율).

처방: admin_ids 쿼리에 org_members(owner/admin role) SSOT를 set 합집합으로 보강. 새 규칙
발명 0 — dispatch_notification 자신이 이미 org_member.id 축 grant-only 휴먼 해소를
지원한다(E-MEMBER-SSOT AC2-2, notification_dispatch.py 기존 주석).
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

ORG = uuid.UUID("d2216e00-0000-0000-0000-000000000010")
PROJ = uuid.UUID("d2216e00-0000-0000-0000-000000000011")
ACTOR_AGENT_USER = uuid.UUID("d2216e00-0000-0000-0000-000000000012")  # placeholder, agent엔 user_id 無
TM_ADMIN_USER = uuid.UUID("d2216e00-0000-0000-0000-000000000013")
OWNER_FLOOR_ADMIN_USER = uuid.UUID("d2216e00-0000-0000-0000-000000000014")


@pytest.fixture
def anyio_backend():
    return "asyncio"


def _actor_auth(actor_member_id: uuid.UUID):
    from app.dependencies.auth import AuthContext
    return AuthContext(
        user_id=str(actor_member_id), email=None,
        claims={"app_metadata": {"org_id": str(ORG), "api_key_id": "test-key"}},
        org_id=str(ORG),
    )


async def _engine():
    eng = create_async_engine(_ASYNC)
    return eng, async_sessionmaker(eng, expire_on_commit=False)


async def _clean(s):
    for sql in [
        f"DELETE FROM notifications WHERE org_id='{ORG}'",
        f"DELETE FROM project_access WHERE project_id IN "
        f"(SELECT id FROM projects WHERE org_id='{ORG}')",
        f"DELETE FROM agent_project_profiles WHERE member_id IN "
        f"(SELECT id FROM members WHERE org_id='{ORG}')",
        f"DELETE FROM members WHERE org_id='{ORG}'",
        f"DELETE FROM projects WHERE org_id='{ORG}'",
        f"DELETE FROM org_members WHERE org_id='{ORG}'",
        f"DELETE FROM users WHERE id IN ('{TM_ADMIN_USER}','{OWNER_FLOOR_ADMIN_USER}')",
        f"DELETE FROM organizations WHERE id='{ORG}'",
    ]:
        await s.execute(text(sql))
    await s.commit()


async def _seed(s, *, include_owner_floor_admin: bool) -> uuid.UUID:
    """ACTOR_AGENT(project admin grant 有, 신규 agent 생성 주체) + TM_ADMIN(project grant 有 —
    양성대조용) + (옵션)OWNER_FLOOR_ADMIN(grant 無 — 결함/수정 검증용). ACTOR_AGENT.id 반환."""
    await _clean(s)
    for sql in [
        f"INSERT INTO organizations (id,name,slug,plan) VALUES ('{ORG}','O','d2216e-org','free')",
        f"INSERT INTO users (id,email,hashed_password,display_name,is_active,email_verified,"
        f"login_fail_count,totp_enabled,totp_fail_count) VALUES "
        f"('{TM_ADMIN_USER}','tmadmin@d2216e.test','x','TMAdmin',true,true,0,false,0),"
        f"('{OWNER_FLOOR_ADMIN_USER}','ownerfloor@d2216e.test','x','OwnerFloor',true,true,0,false,0)",
        f"INSERT INTO projects (id,org_id,name,slug,violation_level) VALUES "
        f"('{PROJ}','{ORG}','P','d2216e-proj','warn')",
    ]:
        await s.execute(text(sql))

    actor_agent_id = uuid.uuid4()
    await s.execute(text(
        f"INSERT INTO members (id,org_id,type,name,is_active) VALUES "
        f"('{actor_agent_id}','{ORG}','agent','Actor',true)"
    ))
    await s.execute(text(
        f"INSERT INTO project_access (id,project_id,member_id,role,permission) VALUES "
        f"(gen_random_uuid(),'{PROJ}','{actor_agent_id}','admin','granted')"
    ))

    tm_admin_member_id = uuid.uuid4()
    await s.execute(text(
        f"INSERT INTO members (id,org_id,user_id,type,name,is_active) VALUES "
        f"('{tm_admin_member_id}','{ORG}','{TM_ADMIN_USER}','human','TMAdmin',true)"
    ))
    await s.execute(text(
        f"INSERT INTO project_access (id,project_id,member_id,role,permission) VALUES "
        f"(gen_random_uuid(),'{PROJ}','{tm_admin_member_id}','admin','granted')"
    ))

    if include_owner_floor_admin:
        await s.execute(text(
            f"INSERT INTO org_members (id,org_id,user_id,role) VALUES "
            f"(gen_random_uuid(),'{ORG}','{OWNER_FLOOR_ADMIN_USER}','admin')"
        ))
        # ⚠️OWNER_FLOOR_ADMIN_USER: members/project_access 어디에도 안 넣음(owner-floor만).

    await s.commit()
    return actor_agent_id


async def _create_agent_and_collect_notified_user_ids(s, actor_agent_id: uuid.UUID) -> set[uuid.UUID]:
    from app.models.notification import Notification
    from app.schemas.team_member import TeamMemberCreate
    from app.routers.team_members import create_team_member

    body = TeamMemberCreate(
        project_id=PROJ, org_id=ORG, type="agent", name=f"NewAgent-{uuid.uuid4().hex[:6]}",
        role="member",
    )
    await create_team_member(body=body, session=s, auth=_actor_auth(actor_agent_id), org_id=ORG)
    await s.commit()
    rows = (await s.execute(
        select(Notification.user_id).where(Notification.org_id == ORG, Notification.type == "agent_joined")
    )).all()
    return {r[0] for r in rows}


@pytest.mark.anyio
async def test_positive_control_team_member_admin_gets_notified():
    """양성대조 — team_member 기반(project grant 有) admin은 실제로 알림을 받는다(먼저 확認)."""
    eng, Session = await _engine()
    try:
        async with Session() as s:
            actor_agent_id = await _seed(s, include_owner_floor_admin=False)
        async with Session() as s:
            notified = await _create_agent_and_collect_notified_user_ids(s, actor_agent_id)
        assert TM_ADMIN_USER in notified, "양성대조 실패 — 정상 admin도 알림을 못 받으면 이 테스트 설계 자체가 무효"
    finally:
        await eng.dispose()


@pytest.mark.anyio
async def test_owner_floor_admin_gets_notified_after_fix():
    """① owner-floor admin이 실제로 알림을 받는다(결함이 있던 조건 그대로 재현 + 수정 확認)."""
    eng, Session = await _engine()
    try:
        async with Session() as s:
            actor_agent_id = await _seed(s, include_owner_floor_admin=True)
        async with Session() as s:
            notified = await _create_agent_and_collect_notified_user_ids(s, actor_agent_id)
        assert TM_ADMIN_USER in notified, "양성대조 축(같은 이벤트의 정상 admin)까지 깨지면 다른 문제"
        assert OWNER_FLOOR_ADMIN_USER in notified, "owner-floor admin이 여전히 알림을 못 받음(전달누락 재발)"
    finally:
        await eng.dispose()
