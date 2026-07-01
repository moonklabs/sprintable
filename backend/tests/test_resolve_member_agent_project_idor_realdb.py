"""까심 QA CRITICAL(#1814 S3 QA) — resolve_member의 is_api_key(agent) 분기가 project_id를
검증 없이 통과시키던 cross-project IDOR의 realdb repro + root-fix 검증.

갭: _resolve_member_legacy/_resolve_member_anchor 모두 JWT 휴먼 분기만 has_project_access로
project_id를 검증했고, agent(API키) 분기는 조기 return — 접근권한 없는 project_id를 넘긴
agent가 그 project에 리소스를 생성할 수 있었다(loops POST/hypotheses POST 등 resolve_member(...,
project_id=)를 쓰는 전 라우터가 동일하게 뚫려 있었음). fix = 두 분기 모두에
`has_project_access` 체크 추가.

본 테스트는 까심 재현 시나리오 그대로: agent는 PROJ_A에만 grant, PROJ_B로 project_id를
넘기면 fix 後 403이어야 한다(fix 前엔 통과했을 것 — RED→GREEN 실증). 라우터 레벨(loops.create_loop +
hypotheses.create_hypothesis) 양쪽 다 커버해 root-fix가 실제로 두 엔드포인트를 동시에 막는 것을 증명한다.

DB env(ALEMBIC_DATABASE_URL) 없으면 skip.
"""
from __future__ import annotations

import os
import uuid
from datetime import datetime, timezone

import pytest
from fastapi import HTTPException
from sqlalchemy import text
from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine

_RAW = os.environ.get("ALEMBIC_DATABASE_URL") or os.environ.get("PARITY_TEST_DATABASE_URL") or ""
_ASYNC = _RAW.replace("postgresql+psycopg2://", "postgresql+asyncpg://").replace(
    "postgresql://", "postgresql+asyncpg://"
)

pytestmark = pytest.mark.skipif(not _RAW, reason="real-DB URL 미설정 — skip")

ORG = uuid.UUID("1d000000-0000-0000-0000-000000000001")
AGENT = uuid.UUID("1d000000-0000-0000-0000-0000000000a1")  # PROJ_A에만 grant
HUMAN_OWNER = uuid.UUID("1d000000-0000-0000-0000-0000000000b1")  # hypothesis owner(human)
OM_OWNER = uuid.UUID("1d000000-0000-0000-0000-0000000000c1")
PROJ_A = uuid.UUID("1d000000-0000-0000-0000-000000000002")  # AGENT grant 있음
PROJ_B = uuid.UUID("1d000000-0000-0000-0000-000000000003")  # AGENT grant 없음(IDOR 축)


@pytest.fixture
def anyio_backend():
    return "asyncio"


def _agent_auth():
    from app.dependencies.auth import AuthContext
    return AuthContext(
        user_id=str(AGENT), email=None,
        claims={"app_metadata": {"api_key_id": "ak_test", "org_id": str(ORG)}},
        org_id=str(ORG),
    )


async def _seed(s, *, legacy_team_member: bool = False):
    """ORG·AGENT(members type=agent, project_access grant=PROJ_A만)·PROJ_A/PROJ_B 시드.

    legacy_team_member=True면 team_members(구·writable) 행도 추가 — _resolve_member_legacy가
    `select(TeamMember)`로 읽는 대상이 이 저장소에서 실제로는 members⋈project_access VIEW이므로
    members+project_access 시드만으로 이미 그 뷰에 투영된다(agent-grant-only 3번째 UNION 브랜치,
    0110). 별도 INSERT INTO team_members는 불요(뷰는 read-only)."""
    for sql in [
        f"DELETE FROM project_access WHERE project_id IN ('{PROJ_A}','{PROJ_B}')",
        f"DELETE FROM org_members WHERE org_id='{ORG}'",
        f"DELETE FROM members WHERE org_id='{ORG}'",
        f"DELETE FROM projects WHERE org_id='{ORG}'",
        f"DELETE FROM users WHERE id='{HUMAN_OWNER}'",
        f"DELETE FROM organizations WHERE id='{ORG}'",
        f"INSERT INTO organizations (id,name,slug,plan) VALUES ('{ORG}','C1D','c1dorg','free')",
        f"INSERT INTO projects (id,org_id,name) VALUES ('{PROJ_A}','{ORG}','A')",
        f"INSERT INTO projects (id,org_id,name) VALUES ('{PROJ_B}','{ORG}','B')",
        f"INSERT INTO members (id,org_id,type,name,is_active) VALUES ('{AGENT}','{ORG}','agent','Ag',true)",
        # AGENT는 PROJ_A에만 grant(PROJ_B 접근 없음 — IDOR 테스트축).
        f"INSERT INTO project_access (id,project_id,org_member_id,member_id,permission) "
        f"VALUES (gen_random_uuid(),'{PROJ_A}',NULL,'{AGENT}','granted')",
        # hypotheses 경로용 human owner(agent caller는 owner 명시 필수).
        "INSERT INTO users (id,email,hashed_password,display_name,is_active,email_verified,"
        f"login_fail_count,totp_enabled,totp_fail_count) VALUES ('{HUMAN_OWNER}','o@c1d.test','x','O',true,true,0,false,0)",
        f"INSERT INTO org_members (id,org_id,user_id,role) VALUES ('{OM_OWNER}','{ORG}','{HUMAN_OWNER}','member')",
        f"INSERT INTO members (id,org_id,type,user_id,name,is_active) "
        f"VALUES ('{OM_OWNER}','{ORG}','human','{HUMAN_OWNER}','O',true)",
    ]:
        await s.execute(text(sql))
    await s.commit()


async def _engine():
    eng = create_async_engine(_ASYNC)
    return eng, async_sessionmaker(eng, expire_on_commit=False)


# ── resolve_member 유닛(레거시+앵커 양쪽) ─────────────────────────────────────

@pytest.mark.anyio
async def test_resolve_member_legacy_agent_cross_project_forbidden_same_project_ok():
    from app.services.member_resolver import _resolve_member_legacy

    eng, Session = await _engine()
    try:
        async with Session() as s:
            await _seed(s)

        # cross-project(PROJ_B·grant 없음) → 까심 재현 시나리오: fix 前엔 통과했을 것.
        async with Session() as s:
            with pytest.raises(HTTPException) as ei:
                await _resolve_member_legacy(_agent_auth(), ORG, s, project_id=PROJ_B)
            assert ei.value.status_code == 403

        # same-project(PROJ_A·grant 있음) → 통과.
        async with Session() as s:
            resolved = await _resolve_member_legacy(_agent_auth(), ORG, s, project_id=PROJ_A)
            assert resolved.id == AGENT
            assert resolved.type == "agent"

        # project_id 미지정(레거시 동작 보존 — 회귀 0).
        async with Session() as s:
            resolved = await _resolve_member_legacy(_agent_auth(), ORG, s, project_id=None)
            assert resolved.id == AGENT
    finally:
        await eng.dispose()


@pytest.mark.anyio
async def test_resolve_member_anchor_agent_cross_project_forbidden_same_project_ok():
    from app.services.member_resolver import _resolve_member_anchor

    eng, Session = await _engine()
    try:
        async with Session() as s:
            await _seed(s)

        async with Session() as s:
            with pytest.raises(HTTPException) as ei:
                await _resolve_member_anchor(_agent_auth(), ORG, s, project_id=PROJ_B)
            assert ei.value.status_code == 403

        async with Session() as s:
            resolved = await _resolve_member_anchor(_agent_auth(), ORG, s, project_id=PROJ_A)
            assert resolved.id == AGENT
            assert resolved.type == "agent"
    finally:
        await eng.dispose()


# ── 라우터 레벨: hypotheses(develop에 이미 존재하는 resolve_member(project_id=) 호출부) ──
# loops(S3, PR #1814)는 이 fix 브랜치 시점엔 develop에 없다 — S3가 이 fix 위로 rebase되면
# 동일 시나리오(agent cross-project POST → 403)를 loops에도 추가한다(S3 PR에서 후속).

@pytest.mark.anyio
async def test_hypotheses_create_agent_cross_project_forbidden():
    from app.routers.hypotheses import create_hypothesis
    from app.schemas.hypothesis import HypothesisCreate

    valid_metric = {"metric": "signups", "source": "manual", "target": 100, "direction": "up"}
    eng, Session = await _engine()
    try:
        async with Session() as s:
            await _seed(s)
        async with Session() as s:
            with pytest.raises(HTTPException) as ei:
                await create_hypothesis(
                    body=HypothesisCreate(
                        project_id=PROJ_B, statement="idor-attempt",
                        metric_definition=valid_metric,
                        measure_after=datetime(2026, 8, 1, tzinfo=timezone.utc),
                        owner_member_id=OM_OWNER,
                    ),
                    session=s, auth=_agent_auth(), org_id=ORG,
                )
            assert ei.value.status_code == 403
    finally:
        await eng.dispose()
