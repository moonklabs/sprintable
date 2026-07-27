"""E-SECURITY SEC-S8(story 83ea3d6a) F: delete_meeting cross-org 무인증 삭제 봉쇄 실증.

`_get_repo`가 `get_verified_org_id`를 계산만 하고(dead computation) `MeetingRepository`는
project_id만으로 스코핑돼 — Org B agent가 임의 project_id(query param 또는 JWT app_metadata)로
Org A meeting을 무인증 삭제(200·무감사) 가능했음."""
from __future__ import annotations

import os
import uuid

import pytest

_REAL_DB_URL = os.getenv("PARITY_TEST_DATABASE_URL") or os.getenv("ALEMBIC_DATABASE_URL")

pytestmark = [
    pytest.mark.skipif(not _REAL_DB_URL, reason="통합 테스트는 실 PG(PARITY/ALEMBIC_DATABASE_URL) 필요"),
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


async def _seed(session):
    from sqlalchemy import text
    from app.models.member import Member
    from app.models.organization import Organization
    from app.models.project import OrgMember, Project
    from app.models.user import User

    org_a = Organization(id=uuid.uuid4(), name="Org A", slug=f"org-a-{uuid.uuid4().hex[:8]}")
    org_b = Organization(id=uuid.uuid4(), name="Org B", slug=f"org-b-{uuid.uuid4().hex[:8]}")
    session.add_all([org_a, org_b])
    await session.commit()

    project_a = Project(id=uuid.uuid4(), org_id=org_a.id, name="Org A Project")
    session.add(project_a)
    await session.commit()

    # meetings.meeting_type은 실 PG ENUM 컬럼이라 ORM insert(VARCHAR 바인딩)가 캐스트 실패 —
    # raw SQL로 명시 캐스트해 우회(delete_meeting 인가 실증이 목적이라 meeting 생성 경로 자체는
    # 무관).
    meeting_id = uuid.uuid4()
    await session.execute(
        text(
            "INSERT INTO meetings (id, project_id, title, meeting_type, participants, decisions, action_items) "
            "VALUES (:id, :pid, :title, 'general'::meeting_type, '[]'::jsonb, '[]'::jsonb, '[]'::jsonb)"
        ),
        {"id": meeting_id, "pid": project_a.id, "title": "Org A Meeting"},
    )
    await session.commit()

    agent_b = Member(id=uuid.uuid4(), org_id=org_b.id, type="agent", name="Org B Agent", is_active=True)
    session.add(agent_b)
    await session.commit()

    human_user_id = uuid.uuid4()
    human_user = User(id=human_user_id, email=f"human-{human_user_id.hex[:8]}@test.com", hashed_password="x")
    session.add(human_user)
    await session.commit()
    human_om_a = OrgMember(id=uuid.uuid4(), org_id=org_a.id, user_id=human_user_id, role="admin")
    session.add(human_om_a)
    await session.commit()

    return {
        "org_a_id": org_a.id, "org_b_id": org_b.id, "project_a_id": project_a.id,
        "meeting_id": meeting_id, "agent_b_id": agent_b.id,
        "human_user_id": human_user_id, "human_om_a_id": human_om_a.id,
    }


def _client_for(app):
    from httpx import AsyncClient, ASGITransport
    return AsyncClient(transport=ASGITransport(app=app), base_url="http://test")


async def _setup_app(app, Session, user_id, org_id, project_id, *, is_agent: bool):
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
        claims = {"app_metadata": {"org_id": str(org_id), "project_id": str(project_id)}}
        if is_agent:
            claims["app_metadata"]["api_key_id"] = "test-key"
        return AuthContext(user_id=str(user_id), email="caller@test", claims=claims)

    app.dependency_overrides[get_db] = _db
    app.dependency_overrides[get_current_user] = _auth


@pytest.mark.anyio
async def test_cross_org_agent_delete_meeting_blocked():
    """까심 F 재현: Org B agent가 (JWT app_metadata로) Org A meeting을 delete 시도 → 차단."""
    from app.main import app

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            seeded = await _seed(s)

        # Org B agent가 자기 org_id는 Org B로 인증하되, project_id는 Org A project를 지정
        # (cross-org 공격 시나리오 — JWT app_metadata.project_id를 임의로 가리킴).
        await _setup_app(
            app, Session, seeded["agent_b_id"], seeded["org_b_id"], seeded["project_a_id"], is_agent=True,
        )
        client = _client_for(app)
        try:
            resp = await client.delete(f"/api/v2/meetings/{seeded['meeting_id']}")
            assert resp.status_code in (403, 404), resp.text
        finally:
            await client.aclose()

        async with Session() as s:
            from sqlalchemy import select
            from app.models.meeting import Meeting
            meeting = (await s.execute(
                select(Meeting).where(Meeting.id == seeded["meeting_id"])
            )).scalar_one_or_none()
            assert meeting is not None, "cross-org 삭제가 실제로 일어나면 안 됨"
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()


@pytest.mark.anyio
async def test_same_org_human_delete_meeting_succeeds_and_audited():
    """회귀 0: 같은 org 휴먼은 정상 삭제 + 감사 기록."""
    from app.main import app

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            seeded = await _seed(s)

        await _setup_app(
            app, Session, seeded["human_user_id"], seeded["org_a_id"], seeded["project_a_id"], is_agent=False,
        )
        client = _client_for(app)
        try:
            resp = await client.delete(f"/api/v2/meetings/{seeded['meeting_id']}")
            assert resp.status_code == 200, resp.text
        finally:
            await client.aclose()

        async with Session() as s:
            from sqlalchemy import select
            from app.models.meeting import Meeting
            from app.models.deletion_audit import DeletionAuditLog
            meeting = (await s.execute(
                select(Meeting).where(Meeting.id == seeded["meeting_id"])
            )).scalar_one_or_none()
            assert meeting is None
            logs = (await s.execute(
                select(DeletionAuditLog).where(DeletionAuditLog.entity_id == seeded["meeting_id"])
            )).scalars().all()
            assert len(logs) == 1
            assert logs[0].entity_type == "meeting"
            assert logs[0].actor_id == seeded["human_om_a_id"]
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()


@pytest.mark.anyio
async def test_same_org_agent_delete_meeting_forbidden():
    """SEC-S1 패턴 계승: 같은 org 소속이어도 agent는 human-gate로 차단."""
    from app.main import app

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            seeded = await _seed(s)
            from app.models.member import Member
            from app.models.project_access import ProjectAccess
            agent_a = Member(id=uuid.uuid4(), org_id=seeded["org_a_id"], type="agent", name="Org A Agent", is_active=True)
            s.add(agent_a)
            await s.commit()
            agent_a_id = agent_a.id
            # resolve_member의 API키 분기는 team_members(뷰=members⋈project_access)에서 찾으므로
            # grant가 있어야 "Team member not found" 400이 아니라 human-gate 403까지 도달한다.
            s.add(ProjectAccess(
                id=uuid.uuid4(), project_id=seeded["project_a_id"], member_id=agent_a_id,
                permission="granted", role="member",
            ))
            await s.commit()

        await _setup_app(
            app, Session, agent_a_id, seeded["org_a_id"], seeded["project_a_id"], is_agent=True,
        )
        client = _client_for(app)
        try:
            resp = await client.delete(f"/api/v2/meetings/{seeded['meeting_id']}")
            assert resp.status_code == 403, resp.text
        finally:
            await client.aclose()
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()
