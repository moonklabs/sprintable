"""story #3687(3680 클래스, PO CHANGES 2026-09-07) — GET /api/v2/members가 project_id
없이도(org-level 대화의 @멘션 등) 응답한다.

PO 지적 — 처음 시도(FE를 /api/team-members로 전환)는 회귀였다: /api/v2/members는
canonical SSOT(휴먼: org_members+project_access grant, 에이전트: team_members
type=agent — BFF route.ts 주석: "team_members 뷰 기반 /api/v2/team-members와 달리
grant 휴먼·owner/admin 누락이 없다")라 team-members로 바꾸면 project_id 있는 대화에서도
grant 휴먼이 사라진다. 정정 — FE는 /api/members 그대로 두고, BE에 project_id 선택
분기(없으면 org 스코프 — grant 판정 불요)를 additive로 얹는다.

이 테스트의 핵심 양성대조(PO 지정) — team_members 행이 **없는**(project_access 자체가
없는) org owner 휴먼 1명이 project_id 없이도 응답에 뜬다(team_members 뷰 기반이었다면
못 뜬다 — 이 표본이 없으면 "team-members로 다시 바꿔도 통과"라 구별이 안 된다). 에이전트도
1명 이상(다른 프로젝트에 grant된) 응답에 뜬다.
"""
from __future__ import annotations

import os
import uuid

import pytest

from tests.test_2266_story_backlinks_realdb import (
    _client_for,
    _make_org,
    _make_project,
    _session_factory,
    _setup_app_human,
)

_REAL_DB_URL = os.getenv("PARITY_TEST_DATABASE_URL") or os.getenv("ALEMBIC_DATABASE_URL")

pytestmark = [
    pytest.mark.skipif(not _REAL_DB_URL, reason="통합 테스트는 실 PG(PARITY/ALEMBIC_DATABASE_URL) 필요"),
    pytest.mark.anyio,
]


@pytest.fixture
def anyio_backend():
    return "asyncio"


@pytest.fixture(autouse=True)
async def _dispose_global_engine_after_test():
    yield
    from app.core.database import engine as _global_engine
    await _global_engine.dispose()


async def _make_org_owner_without_team_member_row(session, org_id):
    """PO 지정 양성대조 표본 — org_members(role=owner)만 있고 members/project_access(=
    team_members 뷰의 원천)가 전혀 없는 휴먼. team_members 뷰 기반 조회였다면 이 사람은
    절대 안 뜬다(뷰가 project_access.member_id로 join하는데 애초에 project_access 행이
    없다) — org_members SSOT 직접 해소(list_org_human_members)만이 이 사람을 잡는다."""
    from app.models.project import OrgMember
    from app.models.user import User

    user = User(id=uuid.uuid4(), email=f"owner-{uuid.uuid4().hex[:8]}@test.local", hashed_password="x")
    session.add(user)
    await session.flush()
    om = OrgMember(id=uuid.uuid4(), org_id=org_id, user_id=user.id, role="owner")
    session.add(om)
    await session.commit()
    return om.id, user.id


async def _make_agent_with_project_grant(session, org_id, project_id, name="Agent"):
    from app.models.member import Member
    from app.models.project_access import ProjectAccess

    agent = Member(id=uuid.uuid4(), org_id=org_id, type="agent", name=name)
    session.add(agent)
    await session.flush()
    session.add(ProjectAccess(
        id=uuid.uuid4(), project_id=project_id, member_id=agent.id, permission="granted", role="member",
    ))
    await session.commit()
    return agent.id


@pytest.mark.anyio
async def test_no_project_id_returns_org_owner_without_team_member_row_and_agent():
    from app.main import app

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org = await _make_org(s)
            project = await _make_project(s, org.id)
            owner_member_id, owner_user_id = await _make_org_owner_without_team_member_row(s, org.id)
            agent_id = await _make_agent_with_project_grant(s, org.id, project.id, name="Agent Alpha")

        await _setup_app_human(app, Session, owner_user_id, org.id)
        client = _client_for(app)
        try:
            resp = await client.get("/api/v2/members")
            assert resp.status_code == 200, resp.text
            body = resp.json()
        finally:
            await client.aclose()
            app.dependency_overrides.clear()

        ids = {row["id"] for row in body}
        # team_members 뷰 기반이었다면 owner_member_id는 여기 없다(project_access 자체가 0건).
        assert str(owner_member_id) in ids, "team_members 행이 없는 org owner가 org 스코프에서 빠졌다"
        assert str(agent_id) in ids, "org의 에이전트가 org 스코프에서 빠졌다"
        owner_row = next(row for row in body if row["id"] == str(owner_member_id))
        assert owner_row["role"] == "owner"
        assert owner_row["type"] == "human"
        agent_row = next(row for row in body if row["id"] == str(agent_id))
        assert agent_row["type"] == "agent"
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()


@pytest.mark.anyio
async def test_project_id_scope_unchanged_grant_human_still_required():
    """회귀 방지 — project_id **있는** 호출은 여전히 grant 모델 그대로(org owner가 아닌
    일반 org member는 그 프로젝트에 grant가 없으면 안 뜬다). 이 테스트가 없으면 org-스코프
    분기 추가가 project-스코프 분기까지 실수로 느슨하게 만들었는지 구별이 안 된다."""
    from app.main import app
    from app.models.project import OrgMember
    from app.models.user import User

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org = await _make_org(s)
            project_a = await _make_project(s, org.id, name="A")
            project_b = await _make_project(s, org.id, name="B")
            owner_member_id, owner_user_id = await _make_org_owner_without_team_member_row(s, org.id)
            # project_b에만 grant된 일반 member(비-owner) — project_a 쿼리에는 안 뜨는 게 맞다.
            user = User(id=uuid.uuid4(), email=f"m-{uuid.uuid4().hex[:8]}@test.local", hashed_password="x")
            s.add(user)
            await s.flush()
            om = OrgMember(id=uuid.uuid4(), org_id=org.id, user_id=user.id, role="member")
            s.add(om)
            await s.commit()

        await _setup_app_human(app, Session, owner_user_id, org.id)
        client = _client_for(app)
        try:
            resp = await client.get(f"/api/v2/members?project_id={project_a.id}")
            assert resp.status_code == 200, resp.text
            ids = {row["id"] for row in resp.json()}
        finally:
            await client.aclose()
            app.dependency_overrides.clear()

        # owner는 grant 없이도 항상 포함(S-MBR-03) — project 스코프에서도 여전히 성립.
        assert str(owner_member_id) in ids
        # project_b에만 grant된 member는 project_a 쿼리에 없다(grant 모델 무회귀).
        assert str(om.id) not in ids
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()
