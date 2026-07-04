"""E-SPRINT-LOOP·GAP fbf1c14b: sprint-open hypotheses REST 배선 — realdb(라우터 표면 실증).

PO 실측 확定(2026-07-03): FE #1869 선언 + retro sprint-close cockpit이 호출하는
`GET/POST /api/v2/sprints/{id}/hypotheses`가 sprints.py에 아예 없어 dev 라이브 404였다
(모델/repo/service는 a4acc4d0/a353e88d로 이미 존재 — 순수 REST 배선 갭). 이 파일은 그
갭이 봉인됐는지 실 Postgres로 검증한다(서비스 유닛 mock으로는 라우터 표면 자체를 못
잡음 — story 8236bbc3/18eefc31이 정확히 지적한 클래스)."""
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

ORG = uuid.UUID("fb000000-0000-0000-0000-000000000001")
PROJ = uuid.UUID("fb000000-0000-0000-0000-0000000000c1")
OTHER_PROJ = uuid.UUID("fb000000-0000-0000-0000-0000000000c2")
OWNER = uuid.UUID("fb000000-0000-0000-0000-0000000000b1")
USER = uuid.UUID("fb000000-0000-0000-0000-0000000000a1")
OM = uuid.UUID("fb000000-0000-0000-0000-0000000000b2")


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
        f"INSERT INTO organizations (id,name,slug,plan) VALUES ('{ORG}','FB','fb-org','free')",
        "INSERT INTO users (id,email,hashed_password,display_name,is_active,email_verified,"
        f"login_fail_count,totp_enabled,totp_fail_count) VALUES ('{USER}','u@fb.test','x','U',true,true,0,false,0)",
        # role=owner — grant 모델(project_access)이 opt-out이라 owner/admin은 레코드 없이도
        # 전 프로젝트 접근 가능(app/models/project_access.py). 이래야 cross-project 테스트가
        # resolve_member의 project_access 게이트가 아니라 실제 CROSS_PROJECT_LINK_FORBIDDEN
        # (service _assert_targets_same_project)에서 막히는지를 정확히 검증한다.
        f"INSERT INTO org_members (id,org_id,user_id,role) VALUES ('{OM}','{ORG}','{USER}','owner')",
        f"INSERT INTO projects (id,org_id,name,violation_level) VALUES ('{PROJ}','{ORG}','P','none')",
        f"INSERT INTO projects (id,org_id,name,violation_level) VALUES ('{OTHER_PROJ}','{ORG}','P2','none')",
    ]:
        await s.execute(text(sql))
    await s.commit()


async def _make_sprint(s, project_id=PROJ, status="planning"):
    from app.models.pm import Sprint
    sprint = Sprint(id=uuid.uuid4(), org_id=ORG, project_id=project_id, title="sp", status=status, duration=14)
    s.add(sprint)
    await s.flush()
    return sprint


async def _make_hypothesis(s, project_id=PROJ, status="proposed", sprint_id=None):
    from app.models.hypothesis import Hypothesis, HypothesisSprintLink
    hyp = Hypothesis(
        id=uuid.uuid4(), org_id=ORG, project_id=project_id, owner_member_id=OWNER,
        statement="기존 가설", metric_definition={"metric": "x", "source": "manual", "target": 1, "direction": "up"},
        measure_after=datetime.now(timezone.utc) + timedelta(days=14), status=status,
        human_accounting={}, gate_contract={},
    )
    s.add(hyp)
    await s.flush()
    if sprint_id is not None:
        s.add(HypothesisSprintLink(id=uuid.uuid4(), hypothesis_id=hyp.id, sprint_id=sprint_id, link_type="declared"))
        await s.flush()
    return hyp


def _auth():
    from app.dependencies.auth import AuthContext
    return AuthContext(user_id=str(USER), email=None, claims={}, org_id=str(ORG))


@pytest.mark.anyio
async def test_get_returns_linked_hypotheses_flat_shape():
    from app.routers.sprints import list_sprint_hypotheses
    from app.repositories.sprint import SprintRepository

    eng, Session = await _engine()
    try:
        async with Session() as s:
            await _seed_org_project(s)
            sprint = await _make_sprint(s)
            hyp = await _make_hypothesis(s, status="proposed", sprint_id=sprint.id)
            await s.commit()

        async with Session() as s:
            repo = SprintRepository(s, ORG)
            result = await list_sprint_hypotheses(sprint.id, repo=repo, session=s, org_id=ORG)
        assert len(result) == 1
        item = result[0]
        assert item.id == hyp.id
        assert item.statement == "기존 가설"
        assert item.status == "proposed"  # raw status(PO crux — coercion 금지, §4①)
        assert item.metric == "x"
        assert item.target == 1
        assert item.direction == "up"
        assert item.href is None  # PO crux — 상세 페이지 라우트 부재, null 확정
    finally:
        await eng.dispose()


@pytest.mark.anyio
async def test_get_unlinked_hypothesis_not_included():
    """다른 sprint에 링크되지 않은 가설은 목록에 안 나옴(project 내 전체 가설 목록이 아님)."""
    from app.routers.sprints import list_sprint_hypotheses
    from app.repositories.sprint import SprintRepository

    eng, Session = await _engine()
    try:
        async with Session() as s:
            await _seed_org_project(s)
            sprint = await _make_sprint(s)
            await _make_hypothesis(s, status="proposed", sprint_id=None)  # 미링크
            await s.commit()

        async with Session() as s:
            repo = SprintRepository(s, ORG)
            result = await list_sprint_hypotheses(sprint.id, repo=repo, session=s, org_id=ORG)
        assert result == []
    finally:
        await eng.dispose()


@pytest.mark.anyio
async def test_get_sprint_not_found_404():
    from app.routers.sprints import list_sprint_hypotheses
    from app.repositories.sprint import SprintRepository

    eng, Session = await _engine()
    try:
        async with Session() as s:
            await _seed_org_project(s)
            await s.commit()

        async with Session() as s:
            repo = SprintRepository(s, ORG)
            with pytest.raises(HTTPException) as ei:
                await list_sprint_hypotheses(uuid.uuid4(), repo=repo, session=s, org_id=ORG)
        assert ei.value.status_code == 404
        assert ei.value.detail["code"] == "SPRINT_NOT_FOUND"
    finally:
        await eng.dispose()


@pytest.mark.anyio
async def test_post_declares_new_hypothesis_create_and_link():
    from app.routers.sprints import declare_sprint_hypothesis, SprintHypothesisDeclareRequest

    eng, Session = await _engine()
    try:
        async with Session() as s:
            await _seed_org_project(s)
            sprint = await _make_sprint(s)
            await s.commit()

        async with Session() as s:
            body = SprintHypothesisDeclareRequest(
                statement="신규 선언 가설",
                metric_definition={"metric": "activation", "source": "manual", "target": 10, "direction": "up"},
                measure_after=datetime.now(timezone.utc) + timedelta(days=14),
            )
            result = await declare_sprint_hypothesis(sprint.id, body, session=s, auth=_auth(), org_id=ORG)
            await s.commit()
        assert result.statement == "신규 선언 가설"
        assert result.status == "proposed"

        # 활성화 게이트가 이 링크를 즉시 인식하는지(커플링 0 확인 — 게이트 코드 무변경).
        async with Session() as s:
            from app.services.sprint import transition_sprint
            from app.services.member_resolver import ResolvedMember
            caller = ResolvedMember(id=OM, user_id=USER, name="h", type="human", role="member", org_id=ORG)
            gated = await transition_sprint(s, ORG, caller, sprint.id, "active")
        assert gated.status == "active"
    finally:
        await eng.dispose()


@pytest.mark.anyio
async def test_post_links_existing_hypothesis():
    from app.routers.sprints import declare_sprint_hypothesis, SprintHypothesisDeclareRequest

    eng, Session = await _engine()
    try:
        async with Session() as s:
            await _seed_org_project(s)
            sprint = await _make_sprint(s)
            hyp = await _make_hypothesis(s, status="active", sprint_id=None)
            await s.commit()

        async with Session() as s:
            body = SprintHypothesisDeclareRequest(hypothesis_id=hyp.id)
            result = await declare_sprint_hypothesis(sprint.id, body, session=s, auth=_auth(), org_id=ORG)
            await s.commit()
        assert result.id == hyp.id
        assert result.status == "active"
    finally:
        await eng.dispose()


@pytest.mark.anyio
async def test_post_link_cross_project_hypothesis_forbidden():
    """다른 project의 기존 hypothesis_id를 링크 시도 → 403(IDOR 방지)."""
    from app.routers.sprints import declare_sprint_hypothesis, SprintHypothesisDeclareRequest

    eng, Session = await _engine()
    try:
        async with Session() as s:
            await _seed_org_project(s)
            sprint = await _make_sprint(s, project_id=PROJ)
            other_hyp = await _make_hypothesis(s, project_id=OTHER_PROJ, status="proposed")
            await s.commit()

        async with Session() as s:
            body = SprintHypothesisDeclareRequest(hypothesis_id=other_hyp.id)
            with pytest.raises(HTTPException) as ei:
                await declare_sprint_hypothesis(sprint.id, body, session=s, auth=_auth(), org_id=ORG)
        assert ei.value.status_code == 403
        assert ei.value.detail["code"] == "CROSS_PROJECT_LINK_FORBIDDEN"
    finally:
        await eng.dispose()


@pytest.mark.anyio
async def test_post_sprint_not_found_404():
    from app.routers.sprints import declare_sprint_hypothesis, SprintHypothesisDeclareRequest

    eng, Session = await _engine()
    try:
        async with Session() as s:
            await _seed_org_project(s)
            await s.commit()

        async with Session() as s:
            body = SprintHypothesisDeclareRequest(hypothesis_id=uuid.uuid4())
            with pytest.raises(HTTPException) as ei:
                await declare_sprint_hypothesis(uuid.uuid4(), body, session=s, auth=_auth(), org_id=ORG)
        assert ei.value.status_code == 404
        assert ei.value.detail["code"] == "SPRINT_NOT_FOUND"
    finally:
        await eng.dispose()


def test_post_body_neither_shape_422():
    from app.routers.sprints import SprintHypothesisDeclareRequest
    with pytest.raises(Exception):  # pydantic ValidationError
        SprintHypothesisDeclareRequest()


def test_post_body_both_shapes_422():
    from app.routers.sprints import SprintHypothesisDeclareRequest
    with pytest.raises(Exception):
        SprintHypothesisDeclareRequest(
            hypothesis_id=uuid.uuid4(), statement="x",
            metric_definition={"metric": "m"}, measure_after=datetime.now(timezone.utc),
        )


def test_post_body_blank_statement_422():
    from app.routers.sprints import SprintHypothesisDeclareRequest
    with pytest.raises(Exception):
        SprintHypothesisDeclareRequest(
            statement="   ",
            metric_definition={"metric": "m", "source": "manual", "target": 1, "direction": "up"},
            measure_after=datetime.now(timezone.utc),
        )
