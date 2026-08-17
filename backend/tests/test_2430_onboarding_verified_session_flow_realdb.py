"""story #2430 — 그라운딩 재정의(2026-08-17, 페드루 PO 판정): 전제("성공 이벤트가 없다")는
이미 낡았다(BE `agent_gateway.py`의 OB-4 seam이 이미 `"verified"`를 발화한다, agent_verify.py의
동일 ack 신호에서). 실 남은 갭 2건만 처리한다:
  ①`meta.flow`(onboarding vs recruit) 판별자 부재 — FE 4종엔 이미 있는데 BE emit엔 없었다.
  ②`session_id`(funnel 조인 키) 미기입 — 컬럼은 이미 있는데 이 호출부만 안 채웠다.

이 ack 요청은 에이전트 런타임이 보낸다(브라우저 session_id를 모른다) — FE `verify_started`가
이미 같은 agent_id로 session_id+meta.flow를 실어 둔 최신 행을 조회해 그대로 이식한다(새 FE
변경 0·새 request 필드 0, 순수 BE 조회 1회 추가).
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


async def _seed_org_project(session):
    from app.models.organization import Organization
    from app.models.project import Project

    org = Organization(id=uuid.uuid4(), name="Org2430", slug=f"org2430-{uuid.uuid4().hex[:8]}")
    session.add(org)
    await session.commit()
    project = Project(id=uuid.uuid4(), org_id=org.id, name="P")
    session.add(project)
    await session.commit()
    return org.id, project.id


async def _seed_agent(session, org_id, project_id):
    from app.models.member import AgentProjectProfile, Member
    from app.models.project_access import ProjectAccess

    member_id = uuid.uuid4()
    session.add(Member(id=member_id, org_id=org_id, type="agent", name="agent"))
    await session.commit()
    session.add(AgentProjectProfile(id=uuid.uuid4(), member_id=member_id, project_id=project_id))
    await session.commit()
    session.add(ProjectAccess(
        id=uuid.uuid4(), project_id=project_id, member_id=member_id, permission="granted",
    ))
    await session.commit()
    return member_id


def _agent_auth(agent_id):
    from app.dependencies.auth import AuthContext
    return AuthContext(
        user_id=str(agent_id), email=None,
        claims={"app_metadata": {"api_key_id": str(uuid.uuid4())}},
    )


async def _setup_app(app, Session, agent_id):
    from app.dependencies.auth import get_current_user
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
        return _agent_auth(agent_id)

    override_db_and_read(app, _db)
    app.dependency_overrides[get_current_user] = _auth


def _client_for(app):
    from httpx import ASGITransport, AsyncClient
    return AsyncClient(transport=ASGITransport(app=app), base_url="http://test")


@pytest.mark.anyio
async def test_verified_and_ack_received_inherit_session_id_and_flow_from_verify_started():
    """AC — verify_started(FE, session_id+meta.flow='recruit' 보유)가 먼저 있고, 그 뒤 ack가
    완료되면 새로 발화된 verified/ack_received 행이 같은 session_id·meta.flow를 물려받는다."""
    from sqlalchemy import select

    from app.main import app
    from app.models.onboarding_event import OnboardingEvent
    from app.services.agent_verify import start_verification

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org_id, project_id = await _seed_org_project(s)
            agent_id = await _seed_agent(s, org_id, project_id)

            expected_session_id = uuid.uuid4()
            s.add(OnboardingEvent(
                id=uuid.uuid4(), event="verify_started", agent_id=agent_id,
                session_id=expected_session_id, meta={"flow": "recruit"},
            ))
            await s.commit()

            seq = await start_verification(s, agent_id=agent_id, org_id=org_id, project_id=project_id)
            await s.commit()

        await _setup_app(app, Session, agent_id)
        client = _client_for(app)
        try:
            resp = await client.post("/api/v2/agent/events/ack", json={"seq": seq})
            assert resp.status_code == 200, resp.text
        finally:
            await client.aclose()
            app.dependency_overrides.clear()

        async with Session() as s:
            rows = (await s.execute(
                select(OnboardingEvent).where(
                    OnboardingEvent.agent_id == agent_id,
                    OnboardingEvent.event.in_(("ack_received", "verified")),
                )
            )).scalars().all()
            by_event = {r.event: r for r in rows}
            assert set(by_event) == {"ack_received", "verified"}
            for ev in ("ack_received", "verified"):
                assert by_event[ev].session_id == expected_session_id, f"{ev} session_id 미상속"
                assert by_event[ev].meta == {"flow": "recruit"}, f"{ev} meta.flow 미상속"
    finally:
        await engine.dispose()


@pytest.mark.anyio
async def test_verified_gracefully_degrades_when_no_verify_started_row_exists():
    """음성대조 — verify_started 행이 아예 없으면(API 전용 발급 등) session_id/meta 조회가
    None으로 조용히 degrade한다(크래시·422 없음, fail-silent 철학 유지)."""
    from sqlalchemy import select

    from app.main import app
    from app.models.onboarding_event import OnboardingEvent
    from app.services.agent_verify import start_verification

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org_id, project_id = await _seed_org_project(s)
            agent_id = await _seed_agent(s, org_id, project_id)

            seq = await start_verification(s, agent_id=agent_id, org_id=org_id, project_id=project_id)
            await s.commit()

        await _setup_app(app, Session, agent_id)
        client = _client_for(app)
        try:
            resp = await client.post("/api/v2/agent/events/ack", json={"seq": seq})
            assert resp.status_code == 200, resp.text
        finally:
            await client.aclose()
            app.dependency_overrides.clear()

        async with Session() as s:
            rows = (await s.execute(
                select(OnboardingEvent).where(
                    OnboardingEvent.agent_id == agent_id,
                    OnboardingEvent.event == "verified",
                )
            )).scalars().all()
            assert len(rows) == 1
            assert rows[0].session_id is None
            assert rows[0].meta == {}
    finally:
        await engine.dispose()
