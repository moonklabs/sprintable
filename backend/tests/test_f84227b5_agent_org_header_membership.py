"""story f84227b5(2026-09-03, 페드루 PO 실측) — 에이전트 API 키 + X-Org-Id 헤더 조합이
자기 조직에도 403 «해당 조직의 멤버가 아닌» — `_verify_org_membership`(app/dependencies/
auth.py)이 `org_members`(human 전용 테이블, story #2058 AC5②와 동형 구조적 사유)만 봐서다.
에이전트의 `AuthContext.user_id`는 `User.id`가 아니라 `TeamMember.id`라 애초에 다른 id
공간 — org_members 조회가 항상 미스한다(헤더 생략 시엔 이 검증 자체를 안 타 우연히 통과,
그래서 "헤더 붙이면 403·생략하면 200"이라는 비대칭 실사고가 났다).

처방: OrgMember 미스 시 TeamMember(해당 org·active)로 재확인.

회귀 2종(페드루 지시 그대로):
(a) 에이전트 + 자기 org 헤더 → 200
(b) 에이전트 + 타 org 헤더 → 403(회귀 없음 — 크로스-org는 여전히 막혀야 한다)

organizations/{org}/metering-key(story #3354, get_verified_org_id 사용)로 실제 라우트를
그대로 왕복 — 하네스는 test_3354_pageview_counter.py 패턴 재사용."""
from __future__ import annotations

import os
import uuid
from unittest.mock import patch

import pytest

_REAL_DB_URL = os.getenv("PARITY_TEST_DATABASE_URL") or os.getenv("ALEMBIC_DATABASE_URL")

pytestmark = [
    pytest.mark.destructive_schema,
    pytest.mark.skipif(not _REAL_DB_URL, reason="real Postgres 필요"),
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
    from sqlalchemy import text as sa_text
    from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine
    from app.core.database import Base
    import app.models  # noqa: F401

    engine = create_async_engine(_async_url())
    async with engine.begin() as conn:
        await conn.run_sync(Base.metadata.create_all)
        await conn.execute(sa_text(
            "CREATE UNIQUE INDEX IF NOT EXISTS uq_members_org_system_publisher "
            "ON members (org_id) WHERE (runtime_type = 'system-publisher' AND type = 'agent')"
        ))
    return engine, async_sessionmaker(engine, expire_on_commit=False)


async def _seed_org(session, *, slug=None):
    from app.models.organization import Organization
    from app.models.project import Project

    org = Organization(id=uuid.uuid4(), name="Org", slug=slug or f"org-{uuid.uuid4().hex[:8]}")
    session.add(org)
    await session.commit()
    project = Project(id=uuid.uuid4(), org_id=org.id, name="P")
    session.add(project)
    await session.commit()
    return org.id, project.id


async def _seed_agent(session, org_id, project_id, *, name="agent"):
    from app.models.team import TeamMember

    m = TeamMember(id=uuid.uuid4(), org_id=org_id, project_id=project_id, type="agent", name=name, is_active=True)
    session.add(m)
    await session.commit()
    return m.id


def _client_for(app):
    from httpx import AsyncClient, ASGITransport
    return AsyncClient(transport=ASGITransport(app=app), base_url="http://test")


def _setup_agent_auth(app, Session, agent_id, *, jwt_org_id):
    """에이전트 API 키 인증을 흉내낸다 — _resolve_api_key()가 실제로 구성하는 AuthContext와
    동형(user_id=TeamMember.id·api_key_id claim 존재·app_metadata.org_id=키 발급 org).

    ⚠️`_verify_org_membership`은 요청-수명 `Depends(get_db)`가 아니라 `app.dependencies.auth`
    모듈에 직접 import된 `async_session_factory()` 단명 세션을 쓴다(story #2459 §6 봉합①과
    동형 — FakeAsyncSessionCtx 문서 참조) — `override_db_and_read`(FastAPI dependency_overrides)
    로는 이 경로를 못 가로챈다. 이 테스트는 `patch.object(auth_module, "async_session_factory",
    Session)`로 직접 패치해야 실제 X-Org-Id 헤더 검증 경로가 내 테스트 DB를 본다."""
    from app.dependencies.auth import AuthContext, get_current_user

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
            user_id=str(agent_id), email=None,
            claims={"app_metadata": {"api_key_id": "test-agent-key", "org_id": str(jwt_org_id)}},
        )

    from tests.conftest import override_db_and_read
    override_db_and_read(app, _db)
    app.dependency_overrides[get_current_user] = _auth


@pytest.mark.anyio
async def test_agent_with_own_org_header_returns_200():
    from app.main import app

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org_id, project_id = await _seed_org(s)
            agent_id = await _seed_agent(s, org_id, project_id)

        # jwt_org_id는 일부러 agent의 실제 org와 다르게(또는 비워) 둬 — 이 테스트가 정확히
        # "헤더 경로"(_verify_org_membership)를 태우도록 강제한다(jwt fallback으로 우연히
        # 통과하면 이 회귀를 못 잡는다).
        _setup_agent_auth(app, Session, agent_id, jwt_org_id=uuid.uuid4())

        import app.dependencies.auth as auth_module
        with patch.object(auth_module, "async_session_factory", Session):
            async with _client_for(app) as client:
                r = await client.get(
                    f"/api/v2/organizations/{org_id}/metering-key", headers={"X-Org-Id": str(org_id)},
                )
        assert r.status_code == 200, r.text
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()


@pytest.mark.anyio
async def test_agent_with_other_org_header_still_returns_403():
    from app.main import app

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org_a_id, project_a_id = await _seed_org(s, slug="org-a")
            org_b_id, _project_b_id = await _seed_org(s, slug="org-b")
            agent_id = await _seed_agent(s, org_a_id, project_a_id)

        _setup_agent_auth(app, Session, agent_id, jwt_org_id=org_a_id)

        import app.dependencies.auth as auth_module
        with patch.object(auth_module, "async_session_factory", Session):
            async with _client_for(app) as client:
                r = await client.get(
                    f"/api/v2/organizations/{org_b_id}/metering-key", headers={"X-Org-Id": str(org_b_id)},
                )
        assert r.status_code == 403, "타 org 헤더인데 통과했다(크로스-org 회귀)"
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()
