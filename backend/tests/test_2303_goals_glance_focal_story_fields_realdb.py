"""story #2303(E-POLISH, 오르테가+미르코 판정 2026-07-29, 스레드 7256d5cc) —
`GET /api/v2/goals?include=glance`의 `focal_story` 9필드 확장 실PG 검증.

#2298이 처음 낸 4필드(id·title·status·assignee_id·gate_status)로 `/api/glance/hero?
story_id=`를 대체하려 했더니 화면이 실제로 읽는 것 중 둘(assignee_ids·gate.requires_human)이
빠져 있었다 — 미르코가 `glance-hero.tsx` + 호출체인(splitParticipants·heroProofState·
buildEvidence·buildTrustSeal·synthesizeGateAction)을 끝까지 추적해 뽑은 9필드:
  assignee_ids · proof_count · auto_verify · gate.gate_type · gate.requires_human ·
  trust.self_reported · trust.human_verified · trust.human_verified_by.name ·
  trust.human_verified_at
판정 기준: 화면이 그리는 것 중 하나도 안 줄어드는가(AC3) + 서버가 합성하지 않는가(AC4,
원자료만 싣고 조립은 화면이 한다) + «있는 만큼만 단다»(넣지 않는 것 10건은 실제로 없어야 함).
"""
from __future__ import annotations

import os
import uuid

import pytest

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


def _async_url() -> str:
    url = _REAL_DB_URL
    for prefix in ("postgresql+psycopg2://", "postgresql+asyncpg://", "postgresql://"):
        if url.startswith(prefix):
            return "postgresql+asyncpg://" + url[len(prefix):]
    return url


async def _session_factory():
    from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine
    engine = create_async_engine(_async_url())
    return engine, async_sessionmaker(engine, expire_on_commit=False)


async def _make_org(session, name="Org"):
    from app.models.organization import Organization
    org = Organization(id=uuid.uuid4(), name=name, slug=f"org-{uuid.uuid4().hex[:8]}")
    session.add(org)
    await session.commit()
    return org


async def _make_project(session, org_id, name="P"):
    from app.models.project import Project
    project = Project(id=uuid.uuid4(), org_id=org_id, name=name)
    session.add(project)
    await session.commit()
    return project


async def _make_human_member(session, org_id, project_id, name="Human"):
    from app.models.user import User
    from app.models.project import OrgMember
    from app.models.project_access import ProjectAccess
    from app.models.member import Member

    user = User(id=uuid.uuid4(), email=f"u-{uuid.uuid4().hex[:8]}@test.local", hashed_password="x")
    session.add(user)
    await session.flush()
    om = OrgMember(id=uuid.uuid4(), org_id=org_id, user_id=user.id, role="member")
    session.add(om)
    await session.flush()
    m = Member(id=om.id, org_id=org_id, type="human", user_id=user.id, name=name)
    session.add(m)
    await session.flush()
    session.add(ProjectAccess(project_id=project_id, org_member_id=om.id, member_id=m.id, role="member"))
    await session.commit()
    return m.id, user.id


async def _make_goal(session, org_id, project_id, title="Goal"):
    from app.models.pm import Goal
    goal = Goal(id=uuid.uuid4(), org_id=org_id, project_id=project_id, title=title, status="active")
    session.add(goal)
    await session.commit()
    return goal


async def _make_story(session, org_id, project_id, epic_id, assignee_id=None, status="backlog", title="Story"):
    from app.models.pm import Story
    story = Story(
        id=uuid.uuid4(), org_id=org_id, project_id=project_id, epic_id=epic_id,
        title=title, status=status, assignee_id=assignee_id,
    )
    session.add(story)
    await session.commit()
    return story


async def _make_gate(
    session, org_id, story_id, status="pending", gate_type="human_review",
    requires_human=False, evidence_status=None,
):
    from app.models.gate import Gate
    gate = Gate(
        id=uuid.uuid4(), org_id=org_id, work_item_id=story_id, work_item_type="story",
        gate_type=gate_type, status=status, requires_human=requires_human,
        evidence_status=evidence_status,
    )
    session.add(gate)
    await session.commit()
    return gate


async def _make_evidence(session, org_id, story_id, created_by, type="url", ref="https://x"):
    from app.models.evidence import Evidence
    evidence = Evidence(
        id=uuid.uuid4(), org_id=org_id, work_item_id=story_id, work_item_type="story",
        type=type, ref=ref, created_by=created_by,
    )
    session.add(evidence)
    await session.commit()
    return evidence


async def _make_story_assignee(session, org_id, story_id, member_id):
    from app.models.story_assignee import StoryAssignee
    sa = StoryAssignee(id=uuid.uuid4(), org_id=org_id, story_id=story_id, member_id=member_id)
    session.add(sa)
    await session.commit()
    return sa


def _client_for(app):
    from httpx import AsyncClient, ASGITransport
    return AsyncClient(transport=ASGITransport(app=app), base_url="http://test")


async def _setup_app_human(app, Session, user_id, org_id):
    from app.dependencies.auth import AuthContext, get_current_user
    from app.dependencies.database import get_db

    async def _db():
        async with Session() as s:
            try:
                yield s
                await s.commit()
            except Exception:
                await s.rollback()
                raise

    async def _auth():
        return AuthContext(
            user_id=str(user_id), email="human@test",
            claims={"app_metadata": {"org_id": str(org_id)}},
        )

    app.dependency_overrides[get_db] = _db
    app.dependency_overrides[get_current_user] = _auth


async def _fetch_focal(app, Session, caller_user_id, org_id, project_id):
    await _setup_app_human(app, Session, caller_user_id, org_id)
    client = _client_for(app)
    try:
        resp = await client.get(
            "/api/v2/goals", params={"project_id": str(project_id), "include": "glance"},
        )
        assert resp.status_code == 200, resp.text
        return resp.json()[0]["focal_story"]
    finally:
        await client.aclose()
        app.dependency_overrides.clear()


# ─── 9필드 전부 재료 없을 때 안전 기본값(크래시 없이 null/0/false/빈배열) ──────────


async def test_focal_story_defaults_when_no_evidence_no_gate_no_extra_assignees():
    from app.main import app

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org = await _make_org(s)
            project = await _make_project(s, org.id)
            caller_id, caller_user_id = await _make_human_member(s, org.id, project.id)
            goal = await _make_goal(s, org.id, project.id)
            await _make_story(
                s, org.id, project.id, goal.id, assignee_id=caller_id,
                status="in-progress", title="Bare",
            )

        focal = await _fetch_focal(app, Session, caller_user_id, org.id, project.id)
        assert focal is not None
        assert focal["assignee_ids"] == []
        assert focal["proof_count"] == 0
        assert focal["auto_verify"] is None
        assert focal["gate"] is None
        assert focal["trust"] == {
            "self_reported": False, "human_verified": False,
            "human_verified_by": None, "human_verified_at": None,
        }
    finally:
        await engine.dispose()


# ─── assignee_ids — 다중배정, StoryAssignee join ────────────────────────────


async def test_focal_story_assignee_ids_reflects_all_story_assignees():
    from app.main import app

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org = await _make_org(s)
            project = await _make_project(s, org.id)
            caller_id, caller_user_id = await _make_human_member(s, org.id, project.id, name="Caller")
            second_id, _ = await _make_human_member(s, org.id, project.id, name="Second")
            goal = await _make_goal(s, org.id, project.id)
            story = await _make_story(
                s, org.id, project.id, goal.id, assignee_id=caller_id,
                status="in-progress", title="Multi-assigned",
            )
            await _make_story_assignee(s, org.id, story.id, caller_id)
            await _make_story_assignee(s, org.id, story.id, second_id)

        focal = await _fetch_focal(app, Session, caller_user_id, org.id, project.id)
        assert focal is not None
        assert set(focal["assignee_ids"]) == {str(caller_id), str(second_id)}, focal
    finally:
        await engine.dispose()


# ─── proof_count / trust.self_reported — Evidence row 개수 ──────────────────


async def test_focal_story_proof_count_and_self_reported_from_evidence_rows():
    from app.main import app

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org = await _make_org(s)
            project = await _make_project(s, org.id)
            caller_id, caller_user_id = await _make_human_member(s, org.id, project.id)
            goal = await _make_goal(s, org.id, project.id)
            story = await _make_story(
                s, org.id, project.id, goal.id, assignee_id=caller_id,
                status="in-progress", title="Proven",
            )
            await _make_evidence(s, org.id, story.id, created_by=caller_id, type="url", ref="https://a")
            await _make_evidence(s, org.id, story.id, created_by=caller_id, type="pr", ref="https://b")

        focal = await _fetch_focal(app, Session, caller_user_id, org.id, project.id)
        assert focal is not None
        assert focal["proof_count"] == 2, focal
        assert focal["trust"]["self_reported"] is True
    finally:
        await engine.dispose()


# ─── auto_verify — merge gate evidence_status → AUTO_VERIFY_MAP 매핑 ────────


@pytest.mark.parametrize(
    "evidence_status,expected",
    [("sufficient", "passed"), ("blocked", "failed")],
)
async def test_focal_story_auto_verify_maps_merge_gate_evidence_status(evidence_status, expected):
    from app.main import app

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org = await _make_org(s)
            project = await _make_project(s, org.id)
            caller_id, caller_user_id = await _make_human_member(s, org.id, project.id)
            goal = await _make_goal(s, org.id, project.id)
            story = await _make_story(
                s, org.id, project.id, goal.id, assignee_id=caller_id,
                status="in-progress", title="Merge-evaluated",
            )
            # merge gate 자체는 status="approved"(resolved) — pending 아니어도 auto_verify는
            # evidence_status 원자료 그대로다(gate 필드=pending 전용, auto_verify=merge 전용, 별축).
            await _make_gate(
                s, org.id, story.id, status="approved", gate_type="merge",
                evidence_status=evidence_status,
            )

        focal = await _fetch_focal(app, Session, caller_user_id, org.id, project.id)
        assert focal is not None
        assert focal["auto_verify"] == expected, focal
    finally:
        await engine.dispose()


# ─── gate — pending gate의 gate_type/requires_human(status는 안 싣는다) ─────


async def test_focal_story_gate_carries_type_and_requires_human_not_status():
    from app.main import app

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org = await _make_org(s)
            project = await _make_project(s, org.id)
            caller_id, caller_user_id = await _make_human_member(s, org.id, project.id)
            goal = await _make_goal(s, org.id, project.id)
            story = await _make_story(
                s, org.id, project.id, goal.id, assignee_id=caller_id,
                status="in-progress", title="Gated",
            )
            await _make_gate(
                s, org.id, story.id, status="pending", gate_type="merge",
                requires_human=True,
            )

        focal = await _fetch_focal(app, Session, caller_user_id, org.id, project.id)
        assert focal is not None
        assert focal["gate"] == {"gate_type": "merge", "requires_human": True}, focal
        assert "status" not in focal["gate"], focal  # AC4: gate.status는 중복이라 안 싣는다
    finally:
        await engine.dispose()


# ─── trust.human_verified* — 최신 gate_approval Evidence, name만 ────────────


async def test_focal_story_human_verified_by_resolves_name_from_latest_gate_approval():
    from app.main import app

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org = await _make_org(s)
            project = await _make_project(s, org.id)
            caller_id, caller_user_id = await _make_human_member(s, org.id, project.id, name="Caller")
            verifier_id, _ = await _make_human_member(s, org.id, project.id, name="Verifier Name")
            goal = await _make_goal(s, org.id, project.id)
            story = await _make_story(
                s, org.id, project.id, goal.id, assignee_id=caller_id,
                status="in-progress", title="Verified",
            )
            await _make_evidence(
                s, org.id, story.id, created_by=verifier_id, type="gate_approval", ref="approved",
            )

        focal = await _fetch_focal(app, Session, caller_user_id, org.id, project.id)
        assert focal is not None
        assert focal["trust"]["human_verified"] is True
        assert focal["trust"]["human_verified_by"] == {"name": "Verifier Name"}, focal
        assert focal["trust"]["human_verified_at"] is not None
        # AC4: member_id/role은 화면이 안 읽어서 뺀다 — name만.
        assert set(focal["trust"]["human_verified_by"].keys()) == {"name"}
    finally:
        await engine.dispose()


# ─── AC4 — 있는 만큼만 단다: 뺀 필드가 실제로 없어야 한다 ────────────────────


async def test_focal_story_excludes_fields_the_screen_does_not_read():
    from app.main import app

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org = await _make_org(s)
            project = await _make_project(s, org.id)
            caller_id, caller_user_id = await _make_human_member(s, org.id, project.id)
            goal = await _make_goal(s, org.id, project.id)
            story = await _make_story(
                s, org.id, project.id, goal.id, assignee_id=caller_id,
                status="in-progress", title="Lean",
            )
            await _make_gate(
                s, org.id, story.id, status="pending", gate_type="human_review",
                requires_human=True,
            )
            await _make_evidence(
                s, org.id, story.id, created_by=caller_id, type="gate_approval", ref="approved",
            )

        focal = await _fetch_focal(app, Session, caller_user_id, org.id, project.id)
        assert focal is not None
        assert set(focal.keys()) == {
            "id", "title", "status", "assignee_id", "assignee_ids", "proof_count",
            "auto_verify", "gate", "trust",
        }, focal
        assert set(focal["gate"].keys()) == {"gate_type", "requires_human"}, focal
        assert set(focal["trust"].keys()) == {
            "self_reported", "human_verified", "human_verified_by", "human_verified_at",
        }, focal
    finally:
        await engine.dispose()
