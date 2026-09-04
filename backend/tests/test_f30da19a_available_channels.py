"""story f30da19a(AC1, 페드루 PO 확定 2026-09-04) — `GET .../channel-connections/
available-channels`가 `CHANNEL_ADAPTERS` 레지스트리를 그대로 파생 노출한다. FE가
「연결 만들기」 버튼을 하드코딩/env 분기 없이 이 목록만으로 그리게(story 본문 §경계) —
sandbox는 `SANDBOX_CHANNEL_ENABLED`일 때만 레지스트리 자체에 항목이 있어(channel_adapters.py
상단 조건부 등재, 이 엔드포인트에 별도 필터링 로직 0) prod에서 자동으로 빠진다.
목록(agent-visible, story #3399)과 동형: org 멤버면 에이전트도 조회 가능(`_require_human`
안 부름) — 이 응답엔 토큰 인접 필드가 아예 없어 AC6 human-only 근거가 적용되지 않는다."""
from __future__ import annotations

import os
import uuid

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
    from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine
    from app.core.database import Base
    import app.models  # noqa: F401

    engine = create_async_engine(_async_url())
    async with engine.begin() as conn:
        await conn.run_sync(Base.metadata.create_all)
    return engine, async_sessionmaker(engine, expire_on_commit=False)


async def _seed_org(session, *, slug=None):
    from app.models.organization import Organization
    from app.models.project import Project

    org = Organization(id=uuid.uuid4(), name="f30da19a Test Org", slug=slug or f"org-{uuid.uuid4().hex[:8]}")
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


def _setup_org_scoped_app(app, Session, org_id, *, user_id, agent: bool = False):
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
        claims = {"app_metadata": {"org_id": str(org_id)}}
        if agent:
            claims["app_metadata"]["api_key_id"] = "test-agent-key"
        return AuthContext(user_id=str(user_id), email="caller@test", claims=claims)

    from tests.conftest import override_db_and_read
    override_db_and_read(app, _db)
    app.dependency_overrides[get_current_user] = _auth


@pytest.mark.anyio
async def test_sandbox_absent_when_flag_off():
    """플래그 off 갈래(AC1) — SANDBOX_CHANNEL_ENABLED 미설정이면 레지스트리 자체에 sandbox가
    없어(channel_adapters.py 조건부 등재) 응답에도 없다. threads는 항상 있다."""
    from app.main import app

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org_id, project_id = await _seed_org(s)
            agent_id = await _seed_agent(s, org_id, project_id)

        _setup_org_scoped_app(app, Session, org_id, user_id=agent_id, agent=True)
        async with _client_for(app) as client:
            r = await client.get(f"/api/v2/organizations/{org_id}/channel-connections/available-channels")
        assert r.status_code == 200, r.text
        rows = r.json()
        channels = {row["channel"] for row in rows}
        assert "sandbox" not in channels
        assert "threads" in channels
        threads_row = next(row for row in rows if row["channel"] == "threads")
        assert threads_row["display_name"] == "Threads"
        assert threads_row["credential_kind"] == "oauth"
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()


@pytest.mark.anyio
async def test_sandbox_present_when_flag_on():
    """플래그 on 갈래(AC1) — 실 env 파싱(SANDBOX_CHANNEL_ENABLED 문자열 처리)이 아니라
    story 5b27b32f 선례(test_5b27b32f_sandbox_channel.py::_enable_sandbox_adapter) 그대로
    레지스트리 dict에 직접 주입해 "플래그가 켜졌을 때 레지스트리에 sandbox가 있으면 이
    엔드포인트가 그걸 그대로 노출하는지"만 검증한다(env 파싱 자체는 그 파일이 이미 커버)."""
    from unittest.mock import patch

    from app.main import app
    import app.services.channel_adapters as adapters_mod

    sandbox_config = adapters_mod.ChannelAdapterConfig(
        authorize_url="", token_url="", scope="sandbox_publish,sandbox_delete",
        refresh_mode="manual", credential_kind="none", display_name="Sandbox",
    )

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org_id, project_id = await _seed_org(s)
            agent_id = await _seed_agent(s, org_id, project_id)

        _setup_org_scoped_app(app, Session, org_id, user_id=agent_id, agent=True)
        with patch.dict(adapters_mod.CHANNEL_ADAPTERS, {"sandbox": sandbox_config}):
            async with _client_for(app) as client:
                r = await client.get(f"/api/v2/organizations/{org_id}/channel-connections/available-channels")
        assert r.status_code == 200, r.text
        rows = r.json()
        sandbox_row = next(row for row in rows if row["channel"] == "sandbox")
        assert sandbox_row["display_name"] == "Sandbox"
        assert sandbox_row["credential_kind"] == "none", "sandbox는 credential_kind='none' — OAuth 시작 버튼이 아니라 BFF POST 분기로 가야 한다"
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()


@pytest.mark.anyio
async def test_agent_gets_200_not_403():
    """AC1 — 에이전트도 읽기 가능(_require_human 안 부름). 목록(agent-visible, #3399)과
    동일 근거: 응답에 토큰 인접 필드가 없다."""
    from app.main import app

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org_id, project_id = await _seed_org(s)
            agent_id = await _seed_agent(s, org_id, project_id)

        _setup_org_scoped_app(app, Session, org_id, user_id=agent_id, agent=True)
        async with _client_for(app) as client:
            r = await client.get(f"/api/v2/organizations/{org_id}/channel-connections/available-channels")
        assert r.status_code == 200, r.text
        assert set(r.json()[0].keys()) == {"channel", "display_name", "credential_kind"}
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()


@pytest.mark.anyio
async def test_org_id_mismatch_still_403():
    from app.main import app

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org_id, project_id = await _seed_org(s)
            other_org_id, _ = await _seed_org(s)
            agent_id = await _seed_agent(s, org_id, project_id)

        _setup_org_scoped_app(app, Session, org_id, user_id=agent_id, agent=True)
        async with _client_for(app) as client:
            r = await client.get(f"/api/v2/organizations/{other_org_id}/channel-connections/available-channels")
        assert r.status_code == 403, r.text
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()
