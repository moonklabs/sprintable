"""E-UI-DAEGBYEON P0-03(story 23b9bdac·doc trust-pipeline-be-design §5) — 실 PG.

Story.human_owner_member_id(신규 additive 컬럼) write-time human 강제 + agent_delegate_ids
(assignee_ids를 Member.type=="agent"로 필터한 파생 뷰) + 에이전트 교체 후 owner 생존 실증.
"""
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
    """org+project + human(Member type=human+project_access)·agent1/agent2(Member type=agent+
    agent_project_profiles) — team_members VIEW(members⋈project_access/agent_project_profiles)를
    통해 resolve_member_identity/lookup_members_by_ids가 찾도록 실제 backing 테이블에 시드.
    + caller(OrgMember·project grant, 별도 auth 경로)."""
    from app.models.member import AgentProjectProfile, Member
    from app.models.organization import Organization
    from app.models.project import OrgMember, Project
    from app.models.project_access import ProjectAccess
    from app.models.user import User

    org = Organization(id=uuid.uuid4(), name="Org", slug=f"org-{uuid.uuid4().hex[:8]}")
    session.add(org)
    await session.commit()
    project = Project(id=uuid.uuid4(), org_id=org.id, name="A")
    session.add(project)
    await session.commit()

    human_member = Member(id=uuid.uuid4(), org_id=org.id, type="human", name="Human Owner")
    agent1 = Member(id=uuid.uuid4(), org_id=org.id, type="agent", name="Agent One")
    agent2 = Member(id=uuid.uuid4(), org_id=org.id, type="agent", name="Agent Two")
    session.add_all([human_member, agent1, agent2])
    await session.commit()
    session.add(ProjectAccess(
        id=uuid.uuid4(), project_id=project.id, member_id=human_member.id,
        permission="granted", role="member",
    ))
    session.add_all([
        AgentProjectProfile(id=uuid.uuid4(), member_id=agent1.id, project_id=project.id),
        AgentProjectProfile(id=uuid.uuid4(), member_id=agent2.id, project_id=project.id),
    ])
    await session.commit()

    caller_id = uuid.uuid4()
    caller = User(id=caller_id, email=f"caller-{caller_id.hex[:8]}@test.com", hashed_password="x")
    session.add(caller)
    await session.commit()
    om = OrgMember(id=uuid.uuid4(), org_id=org.id, user_id=caller_id, role="member")
    session.add(om)
    await session.commit()
    session.add(ProjectAccess(
        id=uuid.uuid4(), project_id=project.id, org_member_id=om.id, permission="granted", role="member",
    ))
    await session.commit()

    return {
        "org_id": org.id, "project_id": project.id, "caller_id": caller_id,
        "human_id": human_member.id, "agent1_id": agent1.id, "agent2_id": agent2.id,
    }


def _client_for(app):
    from httpx import AsyncClient, ASGITransport
    return AsyncClient(transport=ASGITransport(app=app), base_url="http://test")


async def _setup_app(app, Session, user_id, org_id, project_id):
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
            user_id=str(user_id), email="caller@test",
            claims={"app_metadata": {"org_id": str(org_id), "project_id": str(project_id)}},
        )

    app.dependency_overrides[get_db] = _db
    app.dependency_overrides[get_current_user] = _auth


@pytest.mark.anyio
async def test_create_story_with_human_owner_201():
    from app.main import app

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            seeded = await _seed(s)
        await _setup_app(app, Session, seeded["caller_id"], seeded["org_id"], seeded["project_id"])
        client = _client_for(app)
        try:
            resp = await client.post("/api/v2/stories", json={
                "project_id": str(seeded["project_id"]), "org_id": str(seeded["org_id"]),
                "title": "Story", "human_owner_member_id": str(seeded["human_id"]),
            })
            assert resp.status_code == 201, resp.text
            assert resp.json()["human_owner_member_id"] == str(seeded["human_id"])
        finally:
            await client.aclose()
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()


@pytest.mark.anyio
async def test_create_story_with_agent_owner_400():
    """write-time 강제(AC2) — agent를 human_owner로 지정 시 400·story 자체도 미생성."""
    from app.main import app

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            seeded = await _seed(s)
        await _setup_app(app, Session, seeded["caller_id"], seeded["org_id"], seeded["project_id"])
        client = _client_for(app)
        try:
            resp = await client.post("/api/v2/stories", json={
                "project_id": str(seeded["project_id"]), "org_id": str(seeded["org_id"]),
                "title": "Story", "human_owner_member_id": str(seeded["agent1_id"]),
            })
            assert resp.status_code == 400, resp.text
        finally:
            await client.aclose()
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()


@pytest.mark.anyio
async def test_agent_delegate_ids_derived_from_assignee_ids():
    """agent_delegate_ids = assignee_ids를 Member.type=='agent'로 필터(신규 저장 0). human
    assignee는 delegate에서 제외되고 assignee_ids 자체는 무변경(회귀0)."""
    from app.main import app

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            seeded = await _seed(s)
        await _setup_app(app, Session, seeded["caller_id"], seeded["org_id"], seeded["project_id"])
        client = _client_for(app)
        try:
            resp = await client.post("/api/v2/stories", json={
                "project_id": str(seeded["project_id"]), "org_id": str(seeded["org_id"]),
                "title": "Story",
                "assignee_ids": [str(seeded["human_id"]), str(seeded["agent1_id"]), str(seeded["agent2_id"])],
            })
            assert resp.status_code == 201, resp.text
            body = resp.json()
            assert set(body["assignee_ids"]) == {
                str(seeded["human_id"]), str(seeded["agent1_id"]), str(seeded["agent2_id"]),
            }
            assert set(body["agent_delegate_ids"]) == {str(seeded["agent1_id"]), str(seeded["agent2_id"])}
            assert str(seeded["human_id"]) not in body["agent_delegate_ids"]
        finally:
            await client.aclose()
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()


@pytest.mark.anyio
async def test_human_owner_survives_agent_reassignment():
    """AC 핵심 — "에이전트가 교체되어도 인간 책임과 승인 라인이 사라지지 않음". assignee_ids를
    agent1→agent2로 교체(PATCH)해도 human_owner_member_id는 무변경."""
    from app.main import app

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            seeded = await _seed(s)
        await _setup_app(app, Session, seeded["caller_id"], seeded["org_id"], seeded["project_id"])
        client = _client_for(app)
        try:
            create_resp = await client.post("/api/v2/stories", json={
                "project_id": str(seeded["project_id"]), "org_id": str(seeded["org_id"]),
                "title": "Story",
                "human_owner_member_id": str(seeded["human_id"]),
                "assignee_ids": [str(seeded["agent1_id"])],
            })
            assert create_resp.status_code == 201, create_resp.text
            story_id = create_resp.json()["id"]

            patch_resp = await client.patch(f"/api/v2/stories/{story_id}", json={
                "assignee_ids": [str(seeded["agent2_id"])],
            })
            assert patch_resp.status_code == 200, patch_resp.text
            body = patch_resp.json()
            assert body["human_owner_member_id"] == str(seeded["human_id"])  # 생존
            assert body["assignee_ids"] == [str(seeded["agent2_id"])]
            assert body["agent_delegate_ids"] == [str(seeded["agent2_id"])]
        finally:
            await client.aclose()
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()


@pytest.mark.anyio
async def test_update_story_agent_owner_400_and_original_owner_unchanged():
    """PATCH로 human_owner_member_id를 agent로 바꾸려는 시도 → 400·기존 owner 무변경(부분실패 없음)."""
    from app.main import app

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            seeded = await _seed(s)
        await _setup_app(app, Session, seeded["caller_id"], seeded["org_id"], seeded["project_id"])
        client = _client_for(app)
        try:
            create_resp = await client.post("/api/v2/stories", json={
                "project_id": str(seeded["project_id"]), "org_id": str(seeded["org_id"]),
                "title": "Story", "human_owner_member_id": str(seeded["human_id"]),
            })
            story_id = create_resp.json()["id"]

            patch_resp = await client.patch(f"/api/v2/stories/{story_id}", json={
                "human_owner_member_id": str(seeded["agent1_id"]),
            })
            assert patch_resp.status_code == 400, patch_resp.text

            get_resp = await client.get(f"/api/v2/stories/{story_id}")
            assert get_resp.json()["human_owner_member_id"] == str(seeded["human_id"])
        finally:
            await client.aclose()
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()


@pytest.mark.anyio
async def test_human_owner_omitted_defaults_to_none_no_regression():
    """human_owner_member_id 미지정 → None(기존 story 생성 흐름 회귀 0)."""
    from app.main import app

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            seeded = await _seed(s)
        await _setup_app(app, Session, seeded["caller_id"], seeded["org_id"], seeded["project_id"])
        client = _client_for(app)
        try:
            resp = await client.post("/api/v2/stories", json={
                "project_id": str(seeded["project_id"]), "org_id": str(seeded["org_id"]),
                "title": "Story",
            })
            assert resp.status_code == 201, resp.text
            assert resp.json()["human_owner_member_id"] is None
        finally:
            await client.aclose()
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()
