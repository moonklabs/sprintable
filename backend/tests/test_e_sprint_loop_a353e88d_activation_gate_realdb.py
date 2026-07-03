"""E-SPRINT-LOOP a353e88d: sprint-open 定 게이트 — realdb(생존 상태 필터·라우터 표면 실증).

PO 결(2026-07-03): killed/archived만 링크돼 있으면 "검증 대상 0"인데 활성화되는 semantic
구멍이므로 제외 — proposed/active/measuring/verified/falsified만 "생존 선언"으로 인정.
실 Postgres로 status enum 전수 필터링과, 캐노니컬 라우터(`/transition`)가 422를 올바른
code로 실제 노출하는지까지 검증한다(서비스 유닛 테스트는 mock이라 SQL WHERE 자체를
실측 못 함 — 이 파일이 그 갭을 메운다)."""
from __future__ import annotations

import os
import uuid
from datetime import datetime, timedelta, timezone

import pytest
from fastapi import HTTPException
from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine

_RAW = os.environ.get("ALEMBIC_DATABASE_URL") or os.environ.get("PARITY_TEST_DATABASE_URL") or ""
_ASYNC = _RAW.replace("postgresql+psycopg2://", "postgresql+asyncpg://").replace(
    "postgresql://", "postgresql+asyncpg://"
)

pytestmark = pytest.mark.skipif(not _RAW, reason="real-DB URL 미설정 — skip")

ORG = uuid.UUID("dd000000-0000-0000-0000-000000000001")
PROJ = uuid.UUID("dd000000-0000-0000-0000-0000000000c1")
OWNER = uuid.UUID("dd000000-0000-0000-0000-0000000000b1")
USER = uuid.UUID("dd000000-0000-0000-0000-0000000000a1")
OM = uuid.UUID("dd000000-0000-0000-0000-0000000000b2")


@pytest.fixture
def anyio_backend():
    return "asyncio"


async def _engine():
    eng = create_async_engine(_ASYNC)
    return eng, async_sessionmaker(eng, expire_on_commit=False)


async def _seed_org_project(s):
    from sqlalchemy import text
    for sql in [
        f"DELETE FROM sprints WHERE org_id='{ORG}'",
        f"DELETE FROM hypotheses WHERE org_id='{ORG}'",
        f"DELETE FROM org_members WHERE org_id='{ORG}'",
        f"DELETE FROM projects WHERE org_id='{ORG}'",
        f"DELETE FROM users WHERE id='{USER}'",
        f"DELETE FROM organizations WHERE id='{ORG}'",
        f"INSERT INTO organizations (id,name,slug,plan) VALUES ('{ORG}','DD','dd-org','free')",
        "INSERT INTO users (id,email,hashed_password,display_name,is_active,email_verified,"
        f"login_fail_count,totp_enabled,totp_fail_count) VALUES ('{USER}','u@dd.test','x','U',true,true,0,false,0)",
        f"INSERT INTO org_members (id,org_id,user_id,role) VALUES ('{OM}','{ORG}','{USER}','member')",
        f"INSERT INTO projects (id,org_id,name,violation_level) VALUES ('{PROJ}','{ORG}','P','none')",
    ]:
        await s.execute(text(sql))
    await s.commit()


async def _make_sprint(s, status="planning"):
    from app.models.pm import Sprint
    sprint = Sprint(id=uuid.uuid4(), org_id=ORG, project_id=PROJ, title="sp", status=status, duration=14)
    s.add(sprint)
    await s.flush()
    return sprint


async def _link_hypothesis(s, sprint_id, status):
    from app.models.hypothesis import Hypothesis, HypothesisSprintLink
    hyp = Hypothesis(
        id=uuid.uuid4(), org_id=ORG, project_id=PROJ, owner_member_id=OWNER,
        statement="s", metric_definition={"metric": "x", "source": "manual", "target": 1, "direction": "up"},
        measure_after=datetime.now(timezone.utc) + timedelta(days=14), status=status,
        human_accounting={}, gate_contract={},
    )
    s.add(hyp)
    await s.flush()
    s.add(HypothesisSprintLink(id=uuid.uuid4(), hypothesis_id=hyp.id, sprint_id=sprint_id, link_type="declared"))
    await s.flush()


def _caller():
    from app.services.member_resolver import ResolvedMember
    return ResolvedMember(id=uuid.uuid4(), user_id=uuid.uuid4(), name="h", type="human", role="member", org_id=ORG)


@pytest.mark.anyio
@pytest.mark.parametrize("dead_status", ["killed", "archived"])
async def test_activation_blocked_when_only_dead_status_linked(dead_status):
    from app.services.sprint import SprintTransitionError, transition_sprint

    eng, Session = await _engine()
    try:
        async with Session() as s:
            await _seed_org_project(s)
            sprint = await _make_sprint(s)
            await _link_hypothesis(s, sprint.id, dead_status)
            await s.commit()

        async with Session() as s:
            with pytest.raises(SprintTransitionError) as ei:
                await transition_sprint(s, ORG, _caller(), sprint.id, "active")
            assert ei.value.code == "HYPOTHESIS_REQUIRED_FOR_ACTIVATION"
    finally:
        await eng.dispose()


@pytest.mark.anyio
@pytest.mark.parametrize("alive_status", ["proposed", "active", "measuring", "verified", "falsified"])
async def test_activation_succeeds_with_each_alive_status(alive_status):
    from app.services.sprint import transition_sprint

    eng, Session = await _engine()
    try:
        async with Session() as s:
            await _seed_org_project(s)
            sprint = await _make_sprint(s)
            await _link_hypothesis(s, sprint.id, alive_status)
            await s.commit()

        async with Session() as s:
            result = await transition_sprint(s, ORG, _caller(), sprint.id, "active")
            await s.commit()
        assert result.status == "active"
    finally:
        await eng.dispose()


@pytest.mark.anyio
async def test_activation_blocked_zero_links():
    from app.services.sprint import SprintTransitionError, transition_sprint

    eng, Session = await _engine()
    try:
        async with Session() as s:
            await _seed_org_project(s)
            sprint = await _make_sprint(s)
            await s.commit()

        async with Session() as s:
            with pytest.raises(SprintTransitionError) as ei:
                await transition_sprint(s, ORG, _caller(), sprint.id, "active")
            assert ei.value.code == "HYPOTHESIS_REQUIRED_FOR_ACTIVATION"
    finally:
        await eng.dispose()


@pytest.mark.anyio
async def test_activation_succeeds_when_mix_of_dead_and_alive():
    """죽은 상태 1개 + 생존 상태 1개 혼재 — 생존 1개만 있어도 통과(전부 죽은 상태여야 차단)."""
    from app.services.sprint import transition_sprint

    eng, Session = await _engine()
    try:
        async with Session() as s:
            await _seed_org_project(s)
            sprint = await _make_sprint(s)
            await _link_hypothesis(s, sprint.id, "killed")
            await _link_hypothesis(s, sprint.id, "proposed")
            await s.commit()

        async with Session() as s:
            result = await transition_sprint(s, ORG, _caller(), sprint.id, "active")
        assert result.status == "active"
    finally:
        await eng.dispose()


@pytest.mark.anyio
async def test_canonical_transition_router_surfaces_422():
    """캐노니컬 라우터(`POST /{id}/transition`)가 게이트 실패를 422 + 정확한 code로 노출.
    router 함수를 직접 호출(story 1/2/3과 동형 패턴)."""
    from app.routers.sprints import SprintTransitionRequest, transition_sprint_endpoint
    from app.repositories.sprint import SprintRepository

    eng, Session = await _engine()
    try:
        async with Session() as s:
            await _seed_org_project(s)
            sprint = await _make_sprint(s)
            await s.commit()

        async with Session() as s:
            from app.dependencies.auth import AuthContext
            auth = AuthContext(user_id=str(USER), email=None, claims={}, org_id=str(ORG))
            with pytest.raises(HTTPException) as ei:
                await transition_sprint_endpoint(
                    sprint.id, SprintTransitionRequest(status="active"),
                    session=s, org_id=ORG, auth=auth,
                )
            assert ei.value.status_code == 422
            assert ei.value.detail["code"] == "HYPOTHESIS_REQUIRED_FOR_ACTIVATION"
    finally:
        await eng.dispose()
