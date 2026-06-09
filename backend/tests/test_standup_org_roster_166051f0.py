"""S:166051f0 real-DB: org-level 스탠드업 멤버 표시를 org_members 직접 해소.

상용 뭉클랩 제로고 데모-당일 버그 재현 + 픽스 입증. team_members 뷰(0088 = members ⋈
project_access)는 휴먼을 `pa.member_id = m.id` 로 join 하는데, 실 grant 플로우는 member_id 를
NULL 로 둔다(grant-only) → grant-only/owner/무-access 휴먼이 뷰에서 탈락 → org-level 스탠드업
로스터서 휴먼 0. 픽스: org-level team-members 휴먼을 **org_members SSOT 직접** 해소(뷰 비의존).

⚠️ SSOT 노선(선생님 2026-06-09): project_access/team_members 링크 의존·새 프로젝트 멤버 행
생성·member_id 백필 일절 금지. 곱연산(휴먼×프로젝트=N행) 박멸. → 본 테스트는 (1) 뷰가 휴먼을
탈락시킴(버그) (2) 픽스가 org_members 직접으로 전원 표시 (3) read 가 어떤 write 도 안 함
(member_id 백필 0·새 행 0·곱연산 0) 를 함께 검증한다.

DB env(PARITY_TEST_DATABASE_URL/ALEMBIC_DATABASE_URL) 없으면 skip — CI alembic-fresh-db 잡에서 실행.
"""
from __future__ import annotations

import os
import uuid
from unittest.mock import MagicMock

import pytest

_RAW_URL = os.environ.get("PARITY_TEST_DATABASE_URL") or os.environ.get("ALEMBIC_DATABASE_URL") or ""
_ASYNC_URL = _RAW_URL.replace("postgresql+psycopg2://", "postgresql+asyncpg://").replace(
    "postgresql://", "postgresql+asyncpg://"
)

pytestmark = pytest.mark.skipif(not _ASYNC_URL, reason="real-DB URL 미설정 — skip")


@pytest.fixture
def anyio_backend():
    return "asyncio"


ORG = uuid.UUID("d1660000-0000-0000-0000-000000000001")
P1 = uuid.UUID("d1660000-0000-0000-0000-0000000000a1")
# 휴먼 3종: owner(PA 없음)·grant-only(PA member_id NULL)·무-access(org 멤버만)
U_OWNER = uuid.UUID("d1660000-0000-0000-0000-0000000000b1")
U_GRANT = uuid.UUID("d1660000-0000-0000-0000-0000000000b2")
U_NOACC = uuid.UUID("d1660000-0000-0000-0000-0000000000b3")
OM_OWNER = uuid.UUID("d1660000-0000-0000-0000-0000000000c1")
OM_GRANT = uuid.UUID("d1660000-0000-0000-0000-0000000000c2")
OM_NOACC = uuid.UUID("d1660000-0000-0000-0000-0000000000c3")
AG1 = uuid.UUID("d1660000-0000-0000-0000-0000000000e1")  # 뷰에 보이는 에이전트(대조군)


async def _seed(session):
    from sqlalchemy import text

    stmts = [
        # 재실행 정리(의존 역순)
        f"DELETE FROM agent_project_profiles WHERE member_id = '{AG1}'",
        f"DELETE FROM project_access WHERE project_id = '{P1}'",
        f"DELETE FROM members WHERE org_id = '{ORG}'",
        f"DELETE FROM projects WHERE org_id = '{ORG}'",
        f"DELETE FROM org_members WHERE org_id = '{ORG}'",
        f"DELETE FROM users WHERE id IN ('{U_OWNER}','{U_GRANT}','{U_NOACC}')",
        f"DELETE FROM organizations WHERE id = '{ORG}'",
        # 시드
        f"INSERT INTO organizations (id,name,slug,plan) VALUES ('{ORG}','D166','d166org','free')",
        "INSERT INTO users (id,email,hashed_password,display_name,is_active,email_verified,login_fail_count,totp_enabled,totp_fail_count) VALUES "
        f"('{U_OWNER}','owner@d166.test','x','Owner Park',true,true,0,false,0),"
        f"('{U_GRANT}','grant@d166.test','x','Grant Kim',true,true,0,false,0),"
        f"('{U_NOACC}','noacc@d166.test','x',NULL,true,true,0,false,0)",
        "INSERT INTO org_members (id,org_id,user_id,role) VALUES "
        f"('{OM_OWNER}','{ORG}','{U_OWNER}','owner'),"
        f"('{OM_GRANT}','{ORG}','{U_GRANT}','member'),"
        f"('{OM_NOACC}','{ORG}','{U_NOACC}','member')",
        f"INSERT INTO projects (id,org_id,name,violation_level) VALUES ('{P1}','{ORG}','P1',0)",
        # anchor members: 휴먼 id=org_member.id. U_NOACC 는 name 컬럼이 NULL→픽스의 users 폴백(display_name/email) 검증용으로 members 미생성.
        "INSERT INTO members (id,org_id,type,user_id,name,org_role,is_active) VALUES "
        f"('{OM_OWNER}','{ORG}','human','{U_OWNER}','Owner Park','owner',true),"
        f"('{OM_GRANT}','{ORG}','human','{U_GRANT}','Grant Kim','member',true),"
        f"('{AG1}','{ORG}','agent',NULL,'BuildBot',NULL,true)",
        # 에이전트 런타임 미러 → 뷰 agent 분기 출현
        f"INSERT INTO agent_project_profiles (id,member_id,project_id,agent_role,fakechat_port) VALUES "
        f"(gen_random_uuid(),'{AG1}','{P1}','dev',9301)",
        # 실 grant 플로우 모사: grant-only 휴먼은 org_member_id 만, member_id NULL → 뷰 휴먼 분기서 탈락.
        # owner/무-access 휴먼은 project_access 자체가 없음. (곱연산 박멸 = 휴먼당 PA 다행 안 만듦.)
        "INSERT INTO project_access (id,project_id,org_member_id,member_id,permission,role,access_source) VALUES "
        f"(gen_random_uuid(),'{P1}','{OM_GRANT}',NULL,'granted','member','direct')",
    ]
    for s in stmts:
        await session.execute(text(s))
    await session.commit()


def _auth():
    c = MagicMock()
    c.user_id = str(U_OWNER)
    c.claims = {"app_metadata": {"org_id": str(ORG)}}
    return c


@pytest.mark.anyio
async def test_org_level_human_roster_from_org_members_not_view():
    """⚠️ 핵심: 뷰는 휴먼 0(버그 재현), org-level 엔드포인트는 org_members 직접으로 휴먼 전원 표시(픽스)."""
    from sqlalchemy import text
    from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine

    engine = create_async_engine(_ASYNC_URL)
    Session = async_sessionmaker(engine, expire_on_commit=False)
    try:
        async with Session() as s:
            await _seed(s)

        # (1) 버그 재현: team_members 뷰 org-level 휴먼 = 0, 에이전트 = 1
        async with Session() as s:
            view_humans = (await s.execute(text(
                "SELECT count(*) FROM team_members WHERE org_id=:o AND type='human'"), {"o": str(ORG)})).scalar_one()
            view_agents = (await s.execute(text(
                "SELECT count(*) FROM team_members WHERE org_id=:o AND type='agent'"), {"o": str(ORG)})).scalar_one()
        assert view_humans == 0, f"뷰가 휴먼을 노출(버그 전제 깨짐): {view_humans}"
        assert view_agents == 1, f"뷰 에이전트 출현 실패: {view_agents}"

        # (2) repo 직접: org_members SSOT 해소 — 휴먼 3인 전원, id=org_member.id, name 폴백 동작
        from app.repositories.team_member import TeamMemberRepository
        async with Session() as s:
            rows = await TeamMemberRepository(s, ORG).list_org_human_members()
        by_id = {r["id"]: r for r in rows}
        assert set(by_id) == {OM_OWNER, OM_GRANT, OM_NOACC}, f"org_members 직접 해소 휴먼 불일치: {set(by_id)}"
        assert by_id[OM_OWNER]["name"] == "Owner Park"          # members.name 우선
        assert by_id[OM_GRANT]["name"] == "Grant Kim"
        assert by_id[OM_NOACC]["name"] == "noacc@d166.test"     # members 부재 → users.email 폴백
        # 곱연산 0: 휴먼당 정확히 1행
        assert len(rows) == 3, f"곱연산 의심(휴먼당 1행 위반): {len(rows)}"

        # (3) 엔드포인트 org-level(project_id 없음): 휴먼 3 + 에이전트 1, 자기 신원 canonical 매칭
        from httpx import ASGITransport, AsyncClient
        from app.main import app
        from app.dependencies.auth import get_current_user
        from app.dependencies.database import get_db

        async def override_db():
            async with Session() as s:
                yield s

        app.dependency_overrides[get_db] = override_db
        app.dependency_overrides[get_current_user] = lambda: _auth()
        try:
            async with AsyncClient(transport=ASGITransport(app=app), base_url="http://t") as c:
                resp = await c.get("/api/v2/team-members")
            assert resp.status_code == 200, resp.text
            body = resp.json()
            humans = [m for m in body if m["type"] == "human"]
            agents = [m for m in body if m["type"] == "agent"]
            assert {uuid.UUID(m["id"]) for m in humans} == {OM_OWNER, OM_GRANT, OM_NOACC}, f"엔드포인트 휴먼 누락: {humans}"
            assert len(humans) == 3 and len(agents) == 1
            # 자기 카드 편집/제출 매칭의 근거: 휴먼 id = org_member.id (= /api/me·standup author canonical)
            owner = next(m for m in humans if uuid.UUID(m["id"]) == OM_OWNER)
            assert uuid.UUID(owner["user_id"]) == U_OWNER and owner["role"] == "owner"
        finally:
            app.dependency_overrides.clear()

        # (4) anti-backfill / anti-곱연산: read 가 어떤 write 도 안 함
        async with Session() as s:
            pa_cnt = (await s.execute(text(
                "SELECT count(*) FROM project_access WHERE project_id=:p"), {"p": str(P1)})).scalar_one()
            grant_member_id = (await s.execute(text(
                "SELECT member_id FROM project_access WHERE project_id=:p AND org_member_id=:m"),
                {"p": str(P1), "m": str(OM_GRANT)})).scalar_one()
            om_cnt = (await s.execute(text(
                "SELECT count(*) FROM org_members WHERE org_id=:o"), {"o": str(ORG)})).scalar_one()
            members_cnt = (await s.execute(text(
                "SELECT count(*) FROM members WHERE org_id=:o"), {"o": str(ORG)})).scalar_one()
        assert pa_cnt == 1, f"project_access 행 증가(새 멤버 행 생성 금지 위반): {pa_cnt}"
        assert grant_member_id is None, "grant-only 휴먼 member_id 백필됨(금지 위반)"
        assert om_cnt == 3, f"org_members 변동: {om_cnt}"
        assert members_cnt == 3, f"members 변동(백필 의심): {members_cnt}"
    finally:
        await engine.dispose()
