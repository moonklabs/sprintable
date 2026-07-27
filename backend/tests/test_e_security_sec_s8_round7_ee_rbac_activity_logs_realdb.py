"""까심 QA(#2073 REQUEST_CHANGES) 회귀 테스트: activity_logs의 EE RBAC(S-C4) 블록이
`_auth`→`auth` rename 후 여전히 정상 동작하는지 실증(리네임 당시 line 123의 `_auth.user_id`
참조를 놓쳐 EE 활성 시 NameError→광범위 except가 삼켜 fail-open으로 role 무관 flat org-wide
노출됐던 버그의 회귀가드) + role별(owner 전체/admin agent만/member 본인만) 가시성이 실제
적용됨을 실증.

EE 모듈은 `app.routers.activity_logs`가 import될 때 `settings.is_ee_enabled`을 1회
평가해 `_ee_rbac_filter`를 세팅하는 모듈-레벨 게이트라(테스트 세션 중 재평가 안 됨),
테스트에서는 그 모듈-레벨 전역을 직접 실 함수로 monkeypatch해 EE RBAC 경로를 활성화한다."""
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
    """org+project + agent 3종(owner/admin/member role, project_access.role로 team_members
    뷰에 투영) + ActivityLog 3건(각 agent가 actor, action에 role 이름 박아 추적)."""
    from app.models.activity_log import ActivityLog
    from app.models.member import Member
    from app.models.organization import Organization
    from app.models.project import Project
    from app.models.project_access import ProjectAccess

    org = Organization(id=uuid.uuid4(), name="EE-RBAC Org", slug=f"eerbac-{uuid.uuid4().hex[:8]}")
    session.add(org)
    await session.commit()

    project = Project(id=uuid.uuid4(), org_id=org.id, name="EE-RBAC Project")
    session.add(project)
    await session.commit()

    agent_owner = Member(id=uuid.uuid4(), org_id=org.id, type="agent", name="Agent Owner")
    agent_admin = Member(id=uuid.uuid4(), org_id=org.id, type="agent", name="Agent Admin")
    agent_member = Member(id=uuid.uuid4(), org_id=org.id, type="agent", name="Agent Member")
    # 4번째 별도 agent — "다른 멤버"의 행위(caller=agent_member 관점에서 절대 안 보여야 함)를
    # 표현. agent_member 자신의 행위와 혼동되지 않도록 명시 분리.
    agent_other = Member(id=uuid.uuid4(), org_id=org.id, type="agent", name="Agent Other Member")
    session.add_all([agent_owner, agent_admin, agent_member, agent_other])
    await session.commit()

    session.add_all([
        ProjectAccess(id=uuid.uuid4(), project_id=project.id, member_id=agent_owner.id,
                      permission="granted", role="owner"),
        ProjectAccess(id=uuid.uuid4(), project_id=project.id, member_id=agent_admin.id,
                      permission="granted", role="admin"),
        ProjectAccess(id=uuid.uuid4(), project_id=project.id, member_id=agent_member.id,
                      permission="granted", role="member"),
        ProjectAccess(id=uuid.uuid4(), project_id=project.id, member_id=agent_other.id,
                      permission="granted", role="member"),
    ])
    await session.commit()

    log_admin = ActivityLog(
        id=uuid.uuid4(), org_id=org.id, project_id=project.id,
        actor_id=agent_admin.id, actor_type="agent", action="ADMIN-AGENT-ACTION",
    )
    log_other_member_secret = ActivityLog(
        id=uuid.uuid4(), org_id=org.id, project_id=project.id,
        actor_id=agent_other.id, actor_type="agent", action="OTHER-MEMBER-SECRET-ACTION-XYZ",
    )
    log_human = ActivityLog(
        id=uuid.uuid4(), org_id=org.id, project_id=project.id,
        actor_id=uuid.uuid4(), actor_type="human", action="HUMAN-ACTION",
    )
    session.add_all([log_admin, log_other_member_secret, log_human])
    await session.commit()

    return {
        "org_id": org.id, "project_id": project.id,
        "agent_owner_id": agent_owner.id, "agent_admin_id": agent_admin.id, "agent_member_id": agent_member.id,
    }


def _client_for(app):
    from httpx import AsyncClient, ASGITransport
    return AsyncClient(transport=ASGITransport(app=app), base_url="http://test")


async def _setup_app(app, Session, agent_id, org_id):
    from app.dependencies.auth import AuthContext, get_current_user
    from app.dependencies.database import get_db

    async def _db():
        async with Session() as s:
            yield s

    async def _auth():
        return AuthContext(
            user_id=str(agent_id), email="agent@test",
            claims={"app_metadata": {"org_id": str(org_id), "api_key_id": "test-key"}},
        )

    app.dependency_overrides[get_db] = _db
    app.dependency_overrides[get_current_user] = _auth


@pytest.fixture(autouse=True)
def _force_ee_rbac_enabled(monkeypatch):
    """모듈-레벨 import-time 게이트를 실 필터 함수로 강제 활성화(EE 라이브 재현 조건 시뮬)."""
    import app.routers.activity_logs as activity_logs_module
    from ee.services.audit_rbac import filter_activity_by_role

    monkeypatch.setattr(activity_logs_module, "_ee_rbac_filter", filter_activity_by_role)


@pytest.mark.anyio
async def test_owner_agent_sees_all_activity_logs():
    from app.main import app

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            seeded = await _seed(s)

        await _setup_app(app, Session, seeded["agent_owner_id"], seeded["org_id"])
        client = _client_for(app)
        try:
            resp = await client.get(f"/api/v2/activity-logs?project_id={seeded['project_id']}")
            assert resp.status_code == 200, resp.text
            actions = {item["action"] for item in resp.json()["items"]}
            assert actions == {"ADMIN-AGENT-ACTION", "OTHER-MEMBER-SECRET-ACTION-XYZ", "HUMAN-ACTION"}
        finally:
            await client.aclose()
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()


@pytest.mark.anyio
async def test_admin_agent_sees_only_agent_type_activity_logs():
    from app.main import app

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            seeded = await _seed(s)

        await _setup_app(app, Session, seeded["agent_admin_id"], seeded["org_id"])
        client = _client_for(app)
        try:
            resp = await client.get(f"/api/v2/activity-logs?project_id={seeded['project_id']}")
            assert resp.status_code == 200, resp.text
            actions = {item["action"] for item in resp.json()["items"]}
            assert actions == {"ADMIN-AGENT-ACTION", "OTHER-MEMBER-SECRET-ACTION-XYZ"}
            assert "HUMAN-ACTION" not in actions
        finally:
            await client.aclose()
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()


@pytest.mark.anyio
async def test_member_agent_sees_only_own_activity_logs_not_other_member_secret():
    """까심 라이브 재현 그대로: member 역할 caller는 본인 actor_id 행위만 — 다른 멤버의
    OTHER-MEMBER-SECRET-ACTION-XYZ가 노출되면 안 된다(NameError→fail-open 회귀가드 핵심)."""
    from app.main import app

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            seeded = await _seed(s)

        await _setup_app(app, Session, seeded["agent_member_id"], seeded["org_id"])
        client = _client_for(app)
        try:
            resp = await client.get(f"/api/v2/activity-logs?project_id={seeded['project_id']}")
            assert resp.status_code == 200, resp.text
            actions = {item["action"] for item in resp.json()["items"]}
            assert "OTHER-MEMBER-SECRET-ACTION-XYZ" not in actions
            assert "ADMIN-AGENT-ACTION" not in actions
            assert "HUMAN-ACTION" not in actions
        finally:
            await client.aclose()
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()
