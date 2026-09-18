"""story #3727 — agent_runs 시각 3필드(emit_event의 started_at·finished_at, update_run_status의
started_at)가 자연 경로에서 조용히 버려지던 것, 실 PG.

3707·3719와 같은 클래스의 4·5·6번째 인스턴스 — 3724 가드①을 실제로 짜다 발견됐다. 2161은
UpdateAgentRun.finished_at 한쪽만 닫았다(그 회귀는 별도 유지·이 파일에서도 무변 확認).
"""
from __future__ import annotations

import os
import uuid
from datetime import datetime, timezone

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
    from app.models.member import Member
    from app.models.organization import Organization
    from app.models.project import OrgMember, Project
    from app.models.project_access import ProjectAccess
    from app.models.user import User

    org = Organization(id=uuid.uuid4(), name="Org", slug=f"org-{uuid.uuid4().hex[:8]}")
    session.add(org)
    await session.commit()
    project = Project(id=uuid.uuid4(), org_id=org.id, name="Project")
    session.add(project)
    await session.commit()

    agent = Member(id=uuid.uuid4(), org_id=org.id, type="agent", name="Agent A")
    session.add(agent)
    await session.commit()
    session.add(ProjectAccess(
        id=uuid.uuid4(), project_id=project.id, member_id=agent.id, permission="granted", role="member",
    ))
    await session.commit()

    caller_id = uuid.uuid4()
    caller = User(id=caller_id, email=f"caller-{caller_id.hex[:8]}@test.com", hashed_password="x")
    session.add(caller)
    await session.commit()
    caller_om = OrgMember(id=uuid.uuid4(), org_id=org.id, user_id=caller_id, role="member")
    session.add(caller_om)
    await session.commit()
    session.add(ProjectAccess(
        id=uuid.uuid4(), project_id=project.id, org_member_id=caller_om.id, permission="granted", role="member",
    ))
    await session.commit()

    return {"org_id": org.id, "project_id": project.id, "agent_id": agent.id, "caller_id": caller_id}


def _client_for(app):
    from httpx import ASGITransport, AsyncClient
    return AsyncClient(transport=ASGITransport(app=app), base_url="http://test")


async def _setup_app(app, Session, user_id, org_id):
    from app.dependencies.auth import AuthContext, get_current_user, get_verified_org_id
    from tests.conftest import override_db_and_read

    async def _db():
        async with Session() as s:
            try:
                yield s
                await s.commit()
            except Exception:
                await s.rollback()
                raise

    async def _auth():
        return AuthContext(user_id=str(user_id), email="caller@test", claims={"app_metadata": {"org_id": str(org_id)}})

    async def _org():
        return org_id

    override_db_and_read(app, _db)
    app.dependency_overrides[get_current_user] = _auth
    app.dependency_overrides[get_verified_org_id] = _org


@pytest.mark.anyio
async def test_create_with_started_at_and_finished_at_persists_and_readable():
    """AC 핵심 — POST(emit_event 경로)가 보내는 started_at/finished_at이 DB에 실제로 닿고
    GET 응답에 실리는지. 스키마에서 도로 빼면(mutation-kill) 이 테스트가 정확히 이 자리서
    RED(POST 바디가 조용히 버려짐 → 서버 기본값/NULL로 대체)."""
    from app.main import app
    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            seeded = await _seed(s)
        await _setup_app(app, Session, seeded["caller_id"], seeded["org_id"])
        client = _client_for(app)
        try:
            reported_started = datetime(2026, 9, 1, 3, 0, 0, tzinfo=timezone.utc)
            reported_finished = datetime(2026, 9, 1, 3, 5, 0, tzinfo=timezone.utc)
            resp = await client.post(
                "/api/v2/agent-runs",
                json={
                    "agent_id": str(seeded["agent_id"]),
                    "project_id": str(seeded["project_id"]),
                    "status": "completed",
                    "started_at": reported_started.isoformat(),
                    "finished_at": reported_finished.isoformat(),
                },
            )
            assert resp.status_code == 201, resp.text
            body = resp.json()
            assert body["started_at"].startswith("2026-09-01T03:00:00"), f"started_at 안 실림(회귀): {body}"
            assert body["finished_at"].startswith("2026-09-01T03:05:00"), f"finished_at 안 실림(회귀): {body}"
            # duration_ms(GENERATED, started/finished_at 파생) — 값이 실제로 반영됐는지 회귀.
            assert body["duration_ms"] == 300_000, f"duration_ms가 보고된 시각으로 계산 안 됨: {body}"

            get_resp = await client.get(f"/api/v2/agent-runs/{body['id']}")
            assert get_resp.status_code == 200, get_resp.text
            assert get_resp.json()["started_at"].startswith("2026-09-01T03:00:00")
        finally:
            await client.aclose()
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()


@pytest.mark.anyio
async def test_create_without_started_at_keeps_server_default_not_null():
    """미제공 시 서버 기본값(now())을 명시 None으로 덮어쓰지 않아야 한다 — 「생략」과 「명시
    null」을 create 경로에서도 가른다(UpdateAgentRun exclude_unset과 동형 원칙)."""
    from app.main import app
    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            seeded = await _seed(s)
        await _setup_app(app, Session, seeded["caller_id"], seeded["org_id"])
        client = _client_for(app)
        try:
            resp = await client.post(
                "/api/v2/agent-runs",
                json={"agent_id": str(seeded["agent_id"]), "project_id": str(seeded["project_id"])},
            )
            assert resp.status_code == 201, resp.text
            body = resp.json()
            assert body["started_at"] is not None, "started_at 미제공 시 서버 기본값이 안 채워짐(회귀)"
        finally:
            await client.aclose()
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()


@pytest.mark.anyio
async def test_update_started_at_persists_and_readable():
    """AC 핵심 — PATCH(update_run_status 경로)가 보내는 started_at이 DB에 닿고 GET 응답에
    실리는지."""
    from app.main import app
    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            seeded = await _seed(s)
        await _setup_app(app, Session, seeded["caller_id"], seeded["org_id"])
        client = _client_for(app)
        try:
            create_resp = await client.post(
                "/api/v2/agent-runs",
                json={"agent_id": str(seeded["agent_id"]), "project_id": str(seeded["project_id"])},
            )
            assert create_resp.status_code == 201, create_resp.text
            run_id = create_resp.json()["id"]

            corrected_started = datetime(2026, 9, 1, 2, 0, 0, tzinfo=timezone.utc)
            patch_resp = await client.patch(
                f"/api/v2/agent-runs/{run_id}",
                json={"status": "running", "started_at": corrected_started.isoformat()},
            )
            assert patch_resp.status_code == 200, patch_resp.text
            assert patch_resp.json()["started_at"].startswith("2026-09-01T02:00:00"), (
                f"PATCH 응답에 started_at이 안 실림(회귀): {patch_resp.json()}"
            )

            get_resp = await client.get(f"/api/v2/agent-runs/{run_id}")
            assert get_resp.status_code == 200, get_resp.text
            assert get_resp.json()["started_at"].startswith("2026-09-01T02:00:00")
        finally:
            await client.aclose()
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()


@pytest.mark.anyio
async def test_update_finished_at_no_regression_story_2161():
    """story #2161 회귀 감시 — UpdateAgentRun.finished_at 경로는 이번 변경 전에도 이미
    됐었다. started_at을 추가하며 그 경로를 안 깼는지."""
    from app.main import app
    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            seeded = await _seed(s)
        await _setup_app(app, Session, seeded["caller_id"], seeded["org_id"])
        client = _client_for(app)
        try:
            create_resp = await client.post(
                "/api/v2/agent-runs",
                json={"agent_id": str(seeded["agent_id"]), "project_id": str(seeded["project_id"])},
            )
            assert create_resp.status_code == 201, create_resp.text
            run_id = create_resp.json()["id"]

            finished = datetime(2026, 9, 1, 4, 0, 0, tzinfo=timezone.utc)
            patch_resp = await client.patch(
                f"/api/v2/agent-runs/{run_id}",
                json={"status": "completed", "finished_at": finished.isoformat()},
            )
            assert patch_resp.status_code == 200, patch_resp.text
            assert patch_resp.json()["finished_at"].startswith("2026-09-01T04:00:00")
        finally:
            await client.aclose()
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()
