"""story #3399(AC8, 페드루 PO 확定 2026-09-04) — 채널 연결 목록의 에이전트-가시 축소판.
[플러그인·커넥터] publish_threads_post 제거 스토리 착수 前 확認에서 발견: 에이전트가
채널 포스트 초안(#3374)을 만들려면 connection_id가 필요한데, 기존
`GET .../channel-connections`(#3373)는 human-only(AC6)라 에이전트는 그 id를 알 방법이
없었다. 이 신규 엔드포인트가 그 갭을 닫는다 — 최소 필드(id·channel·account_label·
status)만, 토큰·token_expires_at·last_error·connected_by는 절대 안 싣는다.

기존 human-only 엔드포인트(`GET .../channel-connections`)는 그대로 유지한다 — 이
파일은 그 회귀를 재검증하지 않는다(test_3373_channel_connections.py::
test_agent_gets_403_on_every_endpoint가 이미 pin)."""
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


@pytest.fixture(autouse=True)
def _configure_secrets(monkeypatch):
    import importlib
    from cryptography.fernet import Fernet

    import app.core.config as config_module
    monkeypatch.setattr(config_module.settings, "channel_credential_encryption_key", Fernet.generate_key().decode())

    import app.services.channel_credential_crypto as crypto_module
    importlib.reload(crypto_module)
    yield
    importlib.reload(crypto_module)


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

    org = Organization(id=uuid.uuid4(), name="Agent Visible Conn Test Org", slug=slug or f"org-{uuid.uuid4().hex[:8]}")
    session.add(org)
    await session.commit()
    project = Project(id=uuid.uuid4(), org_id=org.id, name="P")
    session.add(project)
    await session.commit()
    return org.id, project.id


async def _seed_human(session, org_id, *, role="member"):
    from app.models.project import OrgMember
    from app.models.user import User

    user = User(id=uuid.uuid4(), email=f"human-{uuid.uuid4().hex[:8]}@test.dev", hashed_password="x")
    session.add(user)
    await session.commit()
    om = OrgMember(id=uuid.uuid4(), org_id=org_id, user_id=user.id, role=role)
    session.add(om)
    await session.commit()
    return user.id


async def _seed_agent(session, org_id, project_id, *, name="agent"):
    from app.models.team import TeamMember

    m = TeamMember(id=uuid.uuid4(), org_id=org_id, project_id=project_id, type="agent", name=name, is_active=True)
    session.add(m)
    await session.commit()
    return m.id


async def _seed_connection(
    session, org_id, *, channel="threads", status="active", account_id=None, account_label=None,
    token="plain-access-token",
):
    from app.models.channel_connection import ChannelConnection
    from app.services.channel_credential_crypto import encrypt_channel_credential

    conn = ChannelConnection(
        id=uuid.uuid4(), org_id=org_id, channel=channel,
        account_id=account_id or f"acct-{uuid.uuid4().hex[:8]}", account_label=account_label,
        status=status, credential_kind="oauth", refresh_mode="reissue_from_access_token",
        encrypted_access_token=encrypt_channel_credential(token) if status == "active" else None,
    )
    session.add(conn)
    await session.commit()
    return conn.id


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
async def test_agent_can_read_minimal_fields():
    """AC8 핵심 — 에이전트가 이 엔드포인트는 403 없이 부를 수 있고, 최소 필드만 온다."""
    from app.main import app

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org_id, project_id = await _seed_org(s)
            agent_id = await _seed_agent(s, org_id, project_id)
            connection_id = await _seed_connection(
                s, org_id, channel="threads", account_label="@sprintable_ai", status="active",
            )

        _setup_org_scoped_app(app, Session, org_id, user_id=agent_id, agent=True)
        async with _client_for(app) as client:
            r = await client.get(f"/api/v2/organizations/{org_id}/channel-connections/agent-visible")
        assert r.status_code == 200, r.text
        rows = r.json()
        assert len(rows) == 1
        row = rows[0]
        assert row["id"] == str(connection_id)
        assert row["channel"] == "threads"
        assert row["account_label"] == "@sprintable_ai"
        assert row["status"] == "active"
        assert set(row.keys()) == {"id", "channel", "account_label", "status"}, (
            f"필드가 최소 집합을 벗어났다(토큰 인접 필드 유출 위험): {sorted(row.keys())}"
        )
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()


@pytest.mark.anyio
async def test_human_can_also_read_it():
    """휴먼도 이 엔드포인트를 부를 수 있다(제외 대상이 아니라 추가 대상)."""
    from app.main import app

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org_id, project_id = await _seed_org(s)
            human_id = await _seed_human(s, org_id, role="member")
            await _seed_connection(s, org_id, channel="threads")

        _setup_org_scoped_app(app, Session, org_id, user_id=human_id)
        async with _client_for(app) as client:
            r = await client.get(f"/api/v2/organizations/{org_id}/channel-connections/agent-visible")
        assert r.status_code == 200, r.text
        assert len(r.json()) == 1
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()


@pytest.mark.anyio
async def test_no_token_adjacent_fields_ever_in_response_body():
    """토큰 무유출 회귀가드 — 응답 원문 텍스트에 access token·필드명 어느 것도 없어야 한다."""
    from app.main import app

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org_id, project_id = await _seed_org(s)
            agent_id = await _seed_agent(s, org_id, project_id)
            await _seed_connection(s, org_id, channel="threads", token="super-secret-token-abc123")

        _setup_org_scoped_app(app, Session, org_id, user_id=agent_id, agent=True)
        async with _client_for(app) as client:
            r = await client.get(f"/api/v2/organizations/{org_id}/channel-connections/agent-visible")
        assert "super-secret-token-abc123" not in r.text
        for forbidden_field in ("token_expires_at", "last_refreshed_at", "last_error", "connected_by", "credential_kind", "can_auto_refresh"):
            assert forbidden_field not in r.text, f"'{forbidden_field}'가 응답에 실렸다(최소 필드 원칙 위반)"
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()


@pytest.mark.anyio
async def test_existing_human_only_full_endpoint_unaffected():
    """회귀 없음 — 기존 GET .../channel-connections(전체 필드, human-only)는 이 스토리로
    안 바뀌었다. 에이전트는 여전히 403(AC6 그대로), 필드도 그대로 전체."""
    from app.main import app

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org_id, project_id = await _seed_org(s)
            agent_id = await _seed_agent(s, org_id, project_id)
            human_id = await _seed_human(s, org_id, role="member")
            await _seed_connection(s, org_id, channel="threads", account_label="@sprintable_ai")

        _setup_org_scoped_app(app, Session, org_id, user_id=agent_id, agent=True)
        async with _client_for(app) as client:
            r_agent = await client.get(f"/api/v2/organizations/{org_id}/channel-connections")
        assert r_agent.status_code == 403, r_agent.text
        assert r_agent.json()["error"]["code"] == "CHANNEL_CONNECTION_HUMAN_ONLY"

        _setup_org_scoped_app(app, Session, org_id, user_id=human_id)
        async with _client_for(app) as client:
            r_human = await client.get(f"/api/v2/organizations/{org_id}/channel-connections")
        assert r_human.status_code == 200, r_human.text
        row = r_human.json()[0]
        assert "token_expires_at" in row  # 전체 필드는 여전히 실린다(human-only 엔드포인트답게)
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
            r = await client.get(f"/api/v2/organizations/{other_org_id}/channel-connections/agent-visible")
        assert r.status_code == 403, r.text
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()
