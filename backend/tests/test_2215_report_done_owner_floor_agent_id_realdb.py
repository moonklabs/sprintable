"""story #2215(AC6 완주 중 발견·오르테가군 확定): `POST /workflow/report-done`의 agent_id
스푸핑 방지 체크(S20 finding #12 sibling)가 `team_members` VIEW(members ⋈ project_access
**INNER JOIN**)만 조회했다 — org owner/admin은 명시 project_access grant 없이 owner-floor
(`has_project_access`의 admin_branch)로 접근권을 얻으므로 이 뷰에 행이 없다. 결과: **1인
창업자가 자기 스토리를 자기 이름으로 report-done 보고하면 "agent_id not found in this
organization"(400)으로 거절**됐다(#2166과 동형의 OSS 유입 손실).

처방: 뷰는 무접촉(공용 자산·폭발 반경 큼) — 검증 쪽을 `filter_org_member_ids`(member_resolver.py,
TeamMember ∪ OrgMember, story #1994 계열 SSOT — 멘션/포크 cross-org 차단에 기존 사용 중)로
교체. 새 규칙 발명 0.

⛔이 파일은 오르테가군이 명시한 가드 3종을 전부 고정한다 — 양성(owner 통과)만 재고 닫지 않는다:
  ① owner-floor만 가진 owner → 통과(결함이 있던 조건 그대로)
  ② 조직 밖 agent_id → 여전히 400(스푸핑 방어가 안 헐거워졌는가)
  ③ 정상 agent(project grant 有) → 여전히 통과(되던 것이 되는가)
"""
from __future__ import annotations

import os
import uuid

import pytest
from fastapi import HTTPException
from sqlalchemy import text
from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine
from starlette.responses import Response

_RAW = os.environ.get("ALEMBIC_DATABASE_URL") or os.environ.get("PARITY_TEST_DATABASE_URL") or ""
_ASYNC = _RAW.replace("postgresql+psycopg2://", "postgresql+asyncpg://").replace(
    "postgresql://", "postgresql+asyncpg://"
)

pytestmark = pytest.mark.skipif(not _RAW, reason="real-DB URL 미설정 — skip")

ORG = uuid.UUID("d2215000-0000-0000-0000-000000000010")
OTHER_ORG = uuid.UUID("d2215000-0000-0000-0000-0000000000a1")
OWNER_USER = uuid.UUID("d2215000-0000-0000-0000-000000000011")
OUTSIDER_USER = uuid.UUID("d2215000-0000-0000-0000-0000000000a2")
PROJ = uuid.UUID("d2215000-0000-0000-0000-000000000012")
AGENT_PROJ = uuid.UUID("d2215000-0000-0000-0000-000000000013")


@pytest.fixture
def anyio_backend():
    return "asyncio"


def _auth(user_id: uuid.UUID, org_id: uuid.UUID):
    from app.dependencies.auth import AuthContext
    return AuthContext(user_id=str(user_id), email=None, claims={}, org_id=str(org_id))


async def _engine():
    eng = create_async_engine(_ASYNC)
    return eng, async_sessionmaker(eng, expire_on_commit=False)


async def _clean(s):
    for sql in [
        f"DELETE FROM participation WHERE org_id IN ('{ORG}','{OTHER_ORG}')",
        f"DELETE FROM participation_role WHERE org_id IN ('{ORG}','{OTHER_ORG}')",
        f"DELETE FROM stories WHERE org_id IN ('{ORG}','{OTHER_ORG}')",
        f"DELETE FROM team_members WHERE org_id IN ('{ORG}','{OTHER_ORG}')",
        f"DELETE FROM project_access WHERE project_id IN "
        f"(SELECT id FROM projects WHERE org_id IN ('{ORG}','{OTHER_ORG}'))",
        f"DELETE FROM projects WHERE org_id IN ('{ORG}','{OTHER_ORG}')",
        f"DELETE FROM org_members WHERE org_id IN ('{ORG}','{OTHER_ORG}')",
        f"DELETE FROM users WHERE id IN ('{OWNER_USER}','{OUTSIDER_USER}')",
        f"DELETE FROM organizations WHERE id IN ('{ORG}','{OTHER_ORG}')",
    ]:
        await s.execute(text(sql))
    await s.commit()


async def _seed(s) -> tuple[uuid.UUID, uuid.UUID]:
    """ORG(owner-floor만 가진 owner) + OTHER_ORG(무관 사용자, 스푸핑 후보). agent_om_id는
    project grant 있는 정상 agent(③용). owner_om_id 반환."""
    await _clean(s)
    for sql in [
        f"INSERT INTO organizations (id,name,slug,plan) VALUES "
        f"('{ORG}','O','d2215-org','free'),('{OTHER_ORG}','X','d2215-other','free')",
        f"INSERT INTO users (id,email,hashed_password,display_name,is_active,email_verified,"
        f"login_fail_count,totp_enabled,totp_fail_count) VALUES "
        f"('{OWNER_USER}','owner@d2215.test','x','Owner',true,true,0,false,0),"
        f"('{OUTSIDER_USER}','outsider@d2215.test','x','Outsider',true,true,0,false,0)",
        f"INSERT INTO projects (id,org_id,name,slug,violation_level) VALUES "
        f"('{PROJ}','{ORG}','P','d2215-proj','warn'),"
        f"('{AGENT_PROJ}','{ORG}','AP','d2215-agent-proj','warn')",
    ]:
        await s.execute(text(sql))
    owner_row = (await s.execute(text(
        f"INSERT INTO org_members (id,org_id,user_id,role) VALUES "
        f"(gen_random_uuid(),'{ORG}','{OWNER_USER}','owner') RETURNING id"
    ))).one()
    owner_om_id = owner_row[0]
    outsider_row = (await s.execute(text(
        f"INSERT INTO org_members (id,org_id,user_id,role) VALUES "
        f"(gen_random_uuid(),'{OTHER_ORG}','{OUTSIDER_USER}','owner') RETURNING id"
    ))).one()
    outsider_om_id = outsider_row[0]
    # ⚠️owner_om_id는 의도적으로 team_members/project_access 어디에도 안 넣는다(owner-floor만).
    await s.commit()
    return owner_om_id, outsider_om_id


async def _seed_agent_with_grant(s) -> uuid.UUID:
    """③용 — project_access grant 有 정상 agent(team_members 뷰에 자연히 잡힘)."""
    from app.models.team import TeamMember
    agent = TeamMember(
        id=uuid.uuid4(), org_id=ORG, project_id=AGENT_PROJ, type="agent", name="Agent",
        is_active=True,
    )
    s.add(agent)
    await s.flush()
    await s.execute(text(
        f"INSERT INTO project_access (id,project_id,member_id,permission) VALUES "
        f"(gen_random_uuid(),'{AGENT_PROJ}','{agent.id}','granted')"
    ))
    await s.commit()
    return agent.id


async def _seed_story_with_participation(s, member_id: uuid.UUID, project_id: uuid.UUID) -> uuid.UUID:
    from app.models.participation import Participation, ParticipationRole
    story_id = uuid.uuid4()
    await s.execute(text(
        f"INSERT INTO stories (id,org_id,project_id,title,status,story_number,priority) VALUES "
        f"('{story_id}','{ORG}','{project_id}','S','in-progress',"
        f"(SELECT COALESCE(MAX(story_number),0)+1 FROM stories WHERE org_id='{ORG}'),'medium')"
    ))
    role_id = uuid.uuid4()
    s.add(ParticipationRole(id=role_id, org_id=ORG, key="implementation", label="구현", is_default=True))
    await s.flush()
    s.add(Participation(id=uuid.uuid4(), org_id=ORG, story_id=story_id, member_id=member_id, role_id=role_id))
    await s.commit()
    return story_id


@pytest.mark.anyio
async def test_owner_floor_only_owner_can_report_done():
    """① 결함이 있던 조건 그대로 — owner-floor만 가진 owner가 자기 이름으로 report-done 성공."""
    from app.routers.workflow_report import ReportDoneRequest, report_done
    eng, Session = await _engine()
    try:
        async with Session() as s:
            owner_om_id, _ = await _seed(s)
            story_id = await _seed_story_with_participation(s, owner_om_id, PROJ)
        async with Session() as s:
            body = ReportDoneRequest(
                story_id=story_id, stage="merge", agent_id=owner_om_id,
                context={"pr_number": 1, "repo": "x/y", "ci_result": "pass", "pr_result": "pass"},
            )
            resp = await report_done(
                body=body, background_tasks=None, response=Response(),
                session=s, org_id=ORG, auth=_auth(OWNER_USER, ORG),
            )
        # 핵심 단언: agent_id 검증에서 400이 안 났다(=owner-floor가 더 이상 거절되지 않음).
        # h1_merge_gate_enabled 는 이 테스트 프로세스 기본값 False라 gate_decision 자체는
        # None일 수 있음(그 축은 별개 관심사 — #2215가 겨냥한 건 agent_id 스푸핑 체크뿐).
        assert resp.completed_stage == "merge"
    finally:
        await eng.dispose()


@pytest.mark.anyio
async def test_agent_id_outside_org_still_400():
    """② 스푸핑 방어 안 헐거워짐 — 다른 org 소속 member_id를 agent_id로 넣으면 여전히 400."""
    from app.routers.workflow_report import ReportDoneRequest, report_done
    eng, Session = await _engine()
    try:
        async with Session() as s:
            owner_om_id, outsider_om_id = await _seed(s)
            story_id = await _seed_story_with_participation(s, owner_om_id, PROJ)
        async with Session() as s:
            body = ReportDoneRequest(
                story_id=story_id, stage="kickoff", agent_id=outsider_om_id,
            )
            with pytest.raises(HTTPException) as ei:
                await report_done(
                    body=body, background_tasks=None, response=Response(),
                    session=s, org_id=ORG, auth=_auth(OWNER_USER, ORG),
                )
        assert ei.value.status_code == 400
        assert "agent_id not found" in str(ei.value.detail)
    finally:
        await eng.dispose()


@pytest.mark.anyio
async def test_normal_agent_with_grant_still_works():
    """③ 되던 것이 계속 됨 — project_access grant 있는 정상 agent는 회귀 없이 통과."""
    from app.routers.workflow_report import ReportDoneRequest, report_done
    eng, Session = await _engine()
    try:
        async with Session() as s:
            owner_om_id, _ = await _seed(s)
            agent_id = await _seed_agent_with_grant(s)
            story_id = await _seed_story_with_participation(s, agent_id, AGENT_PROJ)
        async with Session() as s:
            body = ReportDoneRequest(story_id=story_id, stage="kickoff", agent_id=agent_id)
            resp = await report_done(
                body=body, background_tasks=None, response=Response(),
                session=s, org_id=ORG, auth=_auth(OWNER_USER, ORG),
            )
        assert resp.completed_stage == "kickoff"
    finally:
        await eng.dispose()
