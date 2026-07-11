"""E-SECURITY SEC HIGH baseline paydown round7 — #2050 ratchet _KNOWN_DEBT_ALLOWLIST HIGH
4건 중 activity_logs.list_activity_logs + activity_stream.get_activity_stream 상환
(둘 다 동형 패턴).

근본: project_id 필터(지정 시)에 caller의 project 접근권 검증이 없어 same-org
cross-project 감사 로그/활동 스트림(actor/action/entity/context 전문)이 노출됐다.
project_id는 쿼리파라미터 자체가 조회 대상이라 직접 has_project_access(session, user_id,
project_id, org_id) 검증으로 봉인. actor_id/entity_id/object_id 등은 project로 직접
환원되는 FK가 아니라(result-level 노출 축은 별도 스토리 d3e5ca89) 이 라운드 스코프 밖."""
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
    """org(project_a, project_b) + activity_log_b(project_b, action="TOP-SECRET-B-ACTION") +
    activity_event_b(project_b, verb="top-secret-b-verb") + human_a(project_a에만 명시
    grant, project_b 접근권 없음)."""
    from app.models.activity_event import ActivityEvent
    from app.models.activity_log import ActivityLog
    from app.models.organization import Organization
    from app.models.project import OrgMember, Project
    from app.models.project_access import ProjectAccess
    from app.models.user import User

    org = Organization(id=uuid.uuid4(), name="Org", slug=f"org-{uuid.uuid4().hex[:8]}")
    session.add(org)
    await session.commit()

    project_a = Project(id=uuid.uuid4(), org_id=org.id, name="Project A")
    project_b = Project(id=uuid.uuid4(), org_id=org.id, name="Project B")
    session.add_all([project_a, project_b])
    await session.commit()

    log_b = ActivityLog(
        id=uuid.uuid4(), org_id=org.id, project_id=project_b.id,
        actor_type="agent", action="TOP-SECRET-B-ACTION",
    )
    event_b = ActivityEvent(
        activity_id=uuid.uuid4(), org_id=org.id, project_id=project_b.id,
        verb="top-secret-b-verb", occurred_at=datetime.now(timezone.utc),
        dedup_key=f"dedup-{uuid.uuid4().hex[:8]}",
    )
    session.add_all([log_b, event_b])
    await session.commit()

    human_user_id = uuid.uuid4()
    human_user = User(id=human_user_id, email=f"human-{human_user_id.hex[:8]}@test.com", hashed_password="x")
    session.add(human_user)
    await session.commit()
    human_om = OrgMember(id=uuid.uuid4(), org_id=org.id, user_id=human_user_id, role="member")
    session.add(human_om)
    await session.commit()
    # project_a에만 명시 grant — project_b 접근권 없음(org owner/admin도 아님).
    session.add(ProjectAccess(
        id=uuid.uuid4(), project_id=project_a.id, org_member_id=human_om.id, permission="granted", role="member",
    ))
    await session.commit()

    return {
        "org_id": org.id, "project_a_id": project_a.id, "project_b_id": project_b.id,
        "human_user_id": human_user_id,
    }


def _client_for(app):
    from httpx import AsyncClient, ASGITransport
    return AsyncClient(transport=ASGITransport(app=app), base_url="http://test")


async def _setup_app(app, Session, user_id, org_id):
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
        return AuthContext(user_id=str(user_id), email="caller@test", claims={"app_metadata": {"org_id": str(org_id)}})

    app.dependency_overrides[get_db] = _db
    app.dependency_overrides[get_current_user] = _auth


@pytest.mark.anyio
async def test_project_a_human_can_list_own_project_activity_logs_empty():
    """회귀 0: project_a grant 보유 휴먼은 project_a 감사로그 정상 조회(200, 0건이어도 통과)."""
    from app.main import app

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            seeded = await _seed(s)

        await _setup_app(app, Session, seeded["human_user_id"], seeded["org_id"])
        client = _client_for(app)
        try:
            resp = await client.get(f"/api/v2/activity-logs?project_id={seeded['project_a_id']}")
            assert resp.status_code == 200, resp.text
            assert resp.json()["items"] == []
        finally:
            await client.aclose()
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()


@pytest.mark.anyio
async def test_no_grant_human_cannot_list_other_project_activity_logs():
    """봉인 실증: project_a에만 grant된 휴먼이 project_b 감사로그(action="TOP-SECRET-B-ACTION")
    를 project_id override로 조회 시도 → 404(기존엔 접근권 검증 0이라 200+유출)."""
    from app.main import app

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            seeded = await _seed(s)

        await _setup_app(app, Session, seeded["human_user_id"], seeded["org_id"])
        client = _client_for(app)
        try:
            resp = await client.get(f"/api/v2/activity-logs?project_id={seeded['project_b_id']}")
            assert resp.status_code == 404, resp.text
        finally:
            await client.aclose()
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()


@pytest.mark.anyio
async def test_nonexistent_project_id_returns_404_not_leak_activity_logs():
    """엣지: 존재하지 않는 project_id도 404(존재여부 자체를 흘리지 않음)."""
    from app.main import app

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            seeded = await _seed(s)

        await _setup_app(app, Session, seeded["human_user_id"], seeded["org_id"])
        client = _client_for(app)
        try:
            resp = await client.get(f"/api/v2/activity-logs?project_id={uuid.uuid4()}")
            assert resp.status_code == 404, resp.text
        finally:
            await client.aclose()
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()


@pytest.mark.anyio
async def test_project_a_human_can_get_own_project_activity_stream_empty():
    """회귀 0: project_a grant 보유 휴먼은 project_a 활동스트림 정상 조회(200, 0건이어도 통과)."""
    from app.main import app

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            seeded = await _seed(s)

        await _setup_app(app, Session, seeded["human_user_id"], seeded["org_id"])
        client = _client_for(app)
        try:
            resp = await client.get(f"/api/v2/activity-stream?project_id={seeded['project_a_id']}")
            assert resp.status_code == 200, resp.text
            assert resp.json()["items"] == []
        finally:
            await client.aclose()
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()


@pytest.mark.anyio
async def test_no_grant_human_cannot_get_other_project_activity_stream():
    """봉인 실증: project_a에만 grant된 휴먼이 project_b 활동스트림(verb="top-secret-b-verb")을
    project_id override로 조회 시도 → 404."""
    from app.main import app

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            seeded = await _seed(s)

        await _setup_app(app, Session, seeded["human_user_id"], seeded["org_id"])
        client = _client_for(app)
        try:
            resp = await client.get(f"/api/v2/activity-stream?project_id={seeded['project_b_id']}")
            assert resp.status_code == 404, resp.text
        finally:
            await client.aclose()
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()


@pytest.mark.anyio
async def test_activity_logs_and_stream_without_project_id_still_work_unchanged():
    """회귀 0: project_id 미지정(org-wide) 호출은 두 엔드포인트 모두 무변경 — 여전히 200
    (has_project_access 미적용 경로)."""
    from app.main import app

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            seeded = await _seed(s)

        await _setup_app(app, Session, seeded["human_user_id"], seeded["org_id"])
        client = _client_for(app)
        try:
            resp1 = await client.get("/api/v2/activity-logs")
            assert resp1.status_code == 200, resp1.text
            resp2 = await client.get("/api/v2/activity-stream")
            assert resp2.status_code == 200, resp2.text
        finally:
            await client.aclose()
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()
