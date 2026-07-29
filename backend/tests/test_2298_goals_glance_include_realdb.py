"""story #2298(3단 웨이터폴 근절, 오르테가 계약 2026-07-29, 스레드 7256d5cc) —
`GET /api/v2/goals?include=glance` 실PG 검증.

계약 핵심 셋:
  ①`include` 파라미터 없으면 기존 응답과 byte-identical(다른 소비자 안 무거워짐의 보증)
  ②`participant_ids` — 에픽별 고유 assignee 집합, 캡 없음(집합 계산이라 부분 반환 불가)
  ③`focal_story` — gate-pending 우선 선정(오늘 처음 실제로 재료를 갖고 평가되는 분기,
    `GlanceFocalStory` docstring 참조)
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


async def _make_gate(session, org_id, story_id, status="pending", gate_type="human_review"):
    from app.models.gate import Gate
    gate = Gate(
        id=uuid.uuid4(), org_id=org_id, work_item_id=story_id, work_item_type="story",
        gate_type=gate_type, status=status,
    )
    session.add(gate)
    await session.commit()
    return gate


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


# ─── ①옵트인 — 파라미터 없으면 기존과 byte-identical ─────────────────────────


async def test_goals_list_without_include_has_no_glance_fields():
    from app.main import app
    from app.schemas.goal import GoalResponse

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org = await _make_org(s)
            project = await _make_project(s, org.id)
            caller_id, caller_user_id = await _make_human_member(s, org.id, project.id)
            await _make_goal(s, org.id, project.id)

        await _setup_app_human(app, Session, caller_user_id, org.id)
        client = _client_for(app)
        try:
            resp = await client.get("/api/v2/goals", params={"project_id": str(project.id)})
            assert resp.status_code == 200, resp.text
            body = resp.json()
            assert len(body) == 1
            assert "participant_ids" not in body[0], body[0]
            assert "focal_story" not in body[0], body[0]
            # story #2262(C-4) AC9(오르테가 근본처방, 2026-07-29): 손으로 {"reference_token",
            # "next_action_code"}를 더하면 다음 computed_field가 또 이 테스트를 깬다(오늘
            # 두 번째로 같은 병) — pydantic v2가 이미 구분해 추적하는 model_computed_fields를
            # 써서 "computed_field가 늘어도 테스트가 저절로 따라가게" 근본으로 고친다.
            assert set(body[0].keys()) == set(GoalResponse.model_fields) | set(GoalResponse.model_computed_fields)
        finally:
            await client.aclose()
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()


async def test_goals_list_include_glance_adds_the_two_new_fields_only():
    from app.main import app

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org = await _make_org(s)
            project = await _make_project(s, org.id)
            caller_id, caller_user_id = await _make_human_member(s, org.id, project.id)
            await _make_goal(s, org.id, project.id)

        await _setup_app_human(app, Session, caller_user_id, org.id)
        client = _client_for(app)
        try:
            resp = await client.get(
                "/api/v2/goals", params={"project_id": str(project.id), "include": "glance"},
            )
            assert resp.status_code == 200, resp.text
            body = resp.json()
            assert len(body) == 1
            assert body[0]["participant_ids"] == []
            assert body[0]["focal_story"] is None
        finally:
            await client.aclose()
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()


# ─── ②participant_ids — 집합, 캡 없음 ────────────────────────────────────────


async def test_participant_ids_collects_all_assignees_uncapped():
    from app.main import app

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org = await _make_org(s)
            project = await _make_project(s, org.id)
            caller_id, caller_user_id = await _make_human_member(s, org.id, project.id)
            goal = await _make_goal(s, org.id, project.id)
            member_ids = []
            for i in range(6):
                mid, _ = await _make_human_member(s, org.id, project.id, name=f"M{i}")
                member_ids.append(mid)
                await _make_story(s, org.id, project.id, goal.id, assignee_id=mid, title=f"S{i}")
            # 미배정 story — participant_ids에 안 섞이는지(양성대조).
            await _make_story(s, org.id, project.id, goal.id, assignee_id=None, title="Unassigned")

        await _setup_app_human(app, Session, caller_user_id, org.id)
        client = _client_for(app)
        try:
            resp = await client.get(
                "/api/v2/goals", params={"project_id": str(project.id), "include": "glance"},
            )
            assert resp.status_code == 200, resp.text
            body = resp.json()
            got = set(body[0]["participant_ids"])
            assert got == {str(m) for m in member_ids}, got
        finally:
            await client.aclose()
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()


# ─── ③focal_story — gate-pending 우선 ────────────────────────────────────────


async def test_focal_story_prefers_gate_pending_over_more_recently_created():
    """더 최근에 만들어진 in-progress story가 있어도, pending gate가 걸린 «더 오래된»
    story가 focal로 뽑혀야 한다(gate-우선이 tiebreak-순서보다 이긴다)."""
    from app.main import app

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org = await _make_org(s)
            project = await _make_project(s, org.id)
            caller_id, caller_user_id = await _make_human_member(s, org.id, project.id)
            goal = await _make_goal(s, org.id, project.id)
            older_gated = await _make_story(
                s, org.id, project.id, goal.id, assignee_id=caller_id,
                status="in-progress", title="Older, gate-pending",
            )
            await _make_gate(s, org.id, older_gated.id, status="pending")
            # 더 나중에 생성 — created_at DESC tiebreak이면 이게 이겨야 하지만 gate가 없다.
            await _make_story(
                s, org.id, project.id, goal.id, assignee_id=caller_id,
                status="in-progress", title="Newer, no gate",
            )

        await _setup_app_human(app, Session, caller_user_id, org.id)
        client = _client_for(app)
        try:
            resp = await client.get(
                "/api/v2/goals", params={"project_id": str(project.id), "include": "glance"},
            )
            assert resp.status_code == 200, resp.text
            focal = resp.json()[0]["focal_story"]
            assert focal is not None
            assert focal["id"] == str(older_gated.id), focal
            # story #2303: gate_status(str) → gate(object|None). non-null 자체가 "pending 있음".
            assert focal["gate"] == {"gate_type": "human_review", "requires_human": False}, focal
        finally:
            await client.aclose()
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()


async def test_focal_story_falls_back_to_most_recent_in_progress_when_no_gate_pending():
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
                status="in-progress", title="Older",
            )
            newer = await _make_story(
                s, org.id, project.id, goal.id, assignee_id=caller_id,
                status="in-progress", title="Newer",
            )

        await _setup_app_human(app, Session, caller_user_id, org.id)
        client = _client_for(app)
        try:
            resp = await client.get(
                "/api/v2/goals", params={"project_id": str(project.id), "include": "glance"},
            )
            focal = resp.json()[0]["focal_story"]
            assert focal is not None
            assert focal["id"] == str(newer.id), focal
            assert focal["gate"] is None  # story #2303: gate_status(str) → gate(object|None)
        finally:
            await client.aclose()
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()


async def test_focal_story_null_when_no_in_progress_stories():
    from app.main import app

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org = await _make_org(s)
            project = await _make_project(s, org.id)
            caller_id, caller_user_id = await _make_human_member(s, org.id, project.id)
            goal = await _make_goal(s, org.id, project.id)
            await _make_story(s, org.id, project.id, goal.id, status="backlog")

        await _setup_app_human(app, Session, caller_user_id, org.id)
        client = _client_for(app)
        try:
            resp = await client.get(
                "/api/v2/goals", params={"project_id": str(project.id), "include": "glance"},
            )
            assert resp.json()[0]["focal_story"] is None
        finally:
            await client.aclose()
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()


# ─── 헤더 정합 — glance 분기도 X-Total-Count 유지(직접 Response 반환 시 놓치는 함정) ──


async def test_glance_branch_still_carries_x_total_count_header():
    from app.main import app

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org = await _make_org(s)
            project = await _make_project(s, org.id)
            caller_id, caller_user_id = await _make_human_member(s, org.id, project.id)
            await _make_goal(s, org.id, project.id)

        await _setup_app_human(app, Session, caller_user_id, org.id)
        client = _client_for(app)
        try:
            resp = await client.get(
                "/api/v2/goals", params={"project_id": str(project.id), "include": "glance"},
            )
            assert resp.headers.get("X-Total-Count") == "1", dict(resp.headers)
        finally:
            await client.aclose()
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()
