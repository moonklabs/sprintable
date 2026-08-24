"""story #2982(선생님 실사용 리포트, PO 확定 2026-08-24) — 이미 해소된 게이트에 승인/반려를
시도하면(죽은 버튼 클릭~서버 응답 사이 레이스, #2975 SHA 레이스와 동형 클래스) 서버가
개발자 문구("불법 전이: approved → rejected. pending에서만...")를 그대로 노출하던 것을
machine-readable code(gate_already_resolved)로 거부하도록 처방(gate_head_changed 선례와 동형).

FE가 상태별 버튼을 숨기게 고쳐도(AC1) 클릭~서버 응답 사이 레이스 창은 원리적으로 남으므로,
이 BE 가드가 fail-closed의 실제 경계다 — FE는 이 code를 받으면 사람 문구로 번역+재조회한다."""
from __future__ import annotations

import os
import uuid

import pytest

_REAL_DB_URL = os.getenv("PARITY_TEST_DATABASE_URL") or os.getenv("ALEMBIC_DATABASE_URL")

pytestmark = pytest.mark.destructive_schema

_REAL_DB_SKIP = pytest.mark.skipif(not _REAL_DB_URL, reason="통합 테스트는 실 PG(PARITY/ALEMBIC_DATABASE_URL) 필요")


@pytest.fixture
def anyio_backend():
    return "asyncio"


def _async_url() -> str:
    url = _REAL_DB_URL
    for prefix in ("postgresql+psycopg2://", "postgresql+asyncpg://", "postgresql://"):
        if url.startswith(prefix):
            return "postgresql+asyncpg://" + url[len(prefix):]
    return url


async def _session_factory():
    from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine

    from app.core.database import Base
    import app.models  # noqa: F401
    import app.models.activity_log  # noqa: F401 — transition_gate()가 ActivityLog를 씀.

    engine = create_async_engine(_async_url())
    async with engine.begin() as conn:
        await conn.run_sync(Base.metadata.create_all)
    return engine, async_sessionmaker(engine, expire_on_commit=False)


def _client_for(app):
    from httpx import ASGITransport, AsyncClient
    return AsyncClient(transport=ASGITransport(app=app), base_url="http://test")


async def _setup_app(app, Session, org_id, user_id):
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
        return AuthContext(user_id=str(user_id), email="caller@test", claims={"app_metadata": {}})

    async def _org():
        return org_id

    override_db_and_read(app, _db)
    app.dependency_overrides[get_current_user] = _auth
    app.dependency_overrides[get_verified_org_id] = _org


async def _seed_common(session):
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

    caller = User(id=uuid.uuid4(), email=f"caller-{uuid.uuid4().hex[:8]}@test.com", hashed_password="x")
    session.add(caller)
    await session.commit()
    caller_om = OrgMember(id=uuid.uuid4(), org_id=org.id, user_id=caller.id, role="member")
    session.add(caller_om)
    await session.commit()
    session.add(ProjectAccess(
        id=uuid.uuid4(), project_id=project.id, org_member_id=caller_om.id,
        permission="granted", role="owner",
    ))
    await session.commit()

    return {"org_id": org.id, "project_id": project.id, "caller_id": caller.id, "member_id": caller_om.id}


@_REAL_DB_SKIP
@pytest.mark.anyio
async def test_realdb_reject_after_already_approved_returns_structured_409_not_raw_message():
    """재현: 승인된 게이트에 반려(변경 요청)를 다시 시도 — 선생님이 실제로 겪은 그 시나리오."""
    from app.main import app
    from app.models.gate import Gate
    from app.models.pm import Story

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            seeded = await _seed_common(s)
            story = Story(
                id=uuid.uuid4(), org_id=seeded["org_id"], project_id=seeded["project_id"],
                title="#2982 재현 — 이미 승인된 게이트 재전이 시도",
            )
            s.add(story)
            await s.commit()
            gate = Gate(
                id=uuid.uuid4(), org_id=seeded["org_id"], work_item_id=story.id, work_item_type="story",
                gate_type="merge", status="approved",
                resolver_id=seeded["member_id"],
            )
            s.add(gate)
            await s.commit()
            gate_id = gate.id

        await _setup_app(app, Session, seeded["org_id"], seeded["caller_id"])
        client = _client_for(app)
        try:
            resp = await client.post(
                f"/api/v2/gates/{gate_id}/transition",
                json={"status": "rejected", "note": "변경 요청"},
            )
            assert resp.status_code == 409, resp.text
            error = resp.json()["error"]
            assert error["code"] == "gate_already_resolved", error
            assert error["current_status"] == "approved"
            assert error["resolver_id"] == str(seeded["member_id"])
            # 개발자 문구("불법 전이"·"pending에서만")가 사람에게 노출되면 안 됨(no-fiction 대신
            # 명시적으로 인간 문구가 있어야 함 — AC3의 서버측 계약).
            assert "불법 전이" not in error["message"]

            # gate 상태 자체는 그대로 approved(승인이 파괴/변조되지 않았는지 확認).
            get_resp = await client.get(f"/api/v2/gates/{gate_id}")
            assert get_resp.json()["status"] == "approved"
        finally:
            await client.aclose()
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()


@_REAL_DB_SKIP
@pytest.mark.anyio
async def test_realdb_approve_on_pending_gate_unaffected_by_new_guard():
    """양성대조 — pending 게이트의 정상 승인은 새 가드에 걸리지 않고 그대로 통과한다."""
    from app.main import app
    from app.models.gate import Gate
    from app.models.pm import Story

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            seeded = await _seed_common(s)
            story = Story(
                id=uuid.uuid4(), org_id=seeded["org_id"], project_id=seeded["project_id"],
                title="#2982 양성대조 — 정상 pending 승인",
            )
            s.add(story)
            await s.commit()
            gate = Gate(
                id=uuid.uuid4(), org_id=seeded["org_id"], work_item_id=story.id, work_item_type="story",
                gate_type="merge", status="pending",
            )
            s.add(gate)
            await s.commit()
            gate_id = gate.id

        await _setup_app(app, Session, seeded["org_id"], seeded["caller_id"])
        client = _client_for(app)
        try:
            resp = await client.post(
                f"/api/v2/gates/{gate_id}/transition",
                json={"status": "approved", "note": "정상 승인", "evidence_viewed": True},
            )
            assert resp.status_code == 200, resp.text
            assert resp.json()["status"] == "approved"
        finally:
            await client.aclose()
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()
