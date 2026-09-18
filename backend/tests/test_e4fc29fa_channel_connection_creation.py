"""story e4fc29fa(Phase1·마케팅운영, 페드루 PO 確定 2026-09-04, 조각⑤) — WordPress·
webhook pasted_secret 연결 생성 API. 페드루 리뷰(2026-09-04 16:22Z) — 이 조각 전까지
"휴먼이 연결 API로 등록"(AC2·AC3)이 실 경로 없이 테스트 픽스처(직접 INSERT)로만
성립했다(만들어졌는데 도는 자리 없음). 이 파일은 그 경로 자체를 잰다."""
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


async def _seed_org(session):
    from app.models.organization import Organization
    from app.models.project import Project

    org = Organization(id=uuid.uuid4(), name="e4fc29fa Connection Creation Test Org", slug=f"org-{uuid.uuid4().hex[:8]}")
    session.add(org)
    await session.commit()
    project = Project(id=uuid.uuid4(), org_id=org.id, name="P")
    session.add(project)
    await session.commit()
    return org.id, project.id


async def _seed_human(session, org_id, *, role="owner"):
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
async def test_owner_creates_wordpress_connection(dns_stub):
    from app.main import app

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org_id, project_id = await _seed_org(s)
            human_id = await _seed_human(s, org_id, role="owner")

        _setup_org_scoped_app(app, Session, org_id, user_id=human_id, agent=False)
        async with _client_for(app) as client:
            r = await client.post(
                f"/api/v2/organizations/{org_id}/channel-connections/wordpress",
                json={"site_url": "https://customer-blog.example.com", "username": "editor", "app_password": "app-pw-1234"},
            )
        assert r.status_code == 201, r.text
        body = r.json()
        assert body["channel"] == "wordpress"
        assert body["account_id"] == "https://customer-blog.example.com"
        assert body["account_label"] == "editor"
        assert body["credential_kind"] == "pasted_secret"
        assert body["status"] == "active"
        # story #3373 AC6과 동형 — 응답에 자격 자체(app_password)가 어떤 필드로도 안 실린다.
        assert "app_password" not in body and "encrypted_access_token" not in body
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()


@pytest.mark.anyio
async def test_admin_creates_webhook_connection(dns_stub):
    from app.main import app

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org_id, project_id = await _seed_org(s)
            human_id = await _seed_human(s, org_id, role="admin")

        _setup_org_scoped_app(app, Session, org_id, user_id=human_id, agent=False)
        async with _client_for(app) as client:
            r = await client.post(
                f"/api/v2/organizations/{org_id}/channel-connections/webhook",
                json={"target_url": "https://customer-target.example.com/hook", "secret": "shared-secret-abc"},
            )
        assert r.status_code == 201, r.text
        body = r.json()
        assert body["channel"] == "webhook"
        assert body["account_id"] == "https://customer-target.example.com/hook"
        assert body["credential_kind"] == "pasted_secret"
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()


@pytest.mark.anyio
async def test_member_forbidden():
    from app.main import app

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org_id, project_id = await _seed_org(s)
            human_id = await _seed_human(s, org_id, role="member")

        _setup_org_scoped_app(app, Session, org_id, user_id=human_id, agent=False)
        async with _client_for(app) as client:
            r = await client.post(
                f"/api/v2/organizations/{org_id}/channel-connections/wordpress",
                json={"site_url": "https://customer-blog.example.com", "username": "editor", "app_password": "pw"},
            )
        assert r.status_code == 403, r.text
        error = r.json().get("error") or r.json()
        assert error["code"] == "CHANNEL_CONNECTION_OWNER_OR_ADMIN_ONLY"
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()


@pytest.mark.anyio
async def test_agent_forbidden():
    """AC6과 동형 — 에이전트는 이 연결 자격을 만들거나 읽을 수 없다."""
    from app.main import app

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org_id, project_id = await _seed_org(s)
            agent_id = await _seed_agent(s, org_id, project_id)

        _setup_org_scoped_app(app, Session, org_id, user_id=agent_id, agent=True)
        async with _client_for(app) as client:
            r = await client.post(
                f"/api/v2/organizations/{org_id}/channel-connections/wordpress",
                json={"site_url": "https://customer-blog.example.com", "username": "editor", "app_password": "pw"},
            )
        assert r.status_code == 403, r.text
        error = r.json().get("error") or r.json()
        assert error["code"] == "CHANNEL_CONNECTION_HUMAN_ONLY"
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()


@pytest.mark.anyio
async def test_wordpress_missing_fields_rejected():
    from app.main import app

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org_id, project_id = await _seed_org(s)
            human_id = await _seed_human(s, org_id, role="owner")

        _setup_org_scoped_app(app, Session, org_id, user_id=human_id, agent=False)
        async with _client_for(app) as client:
            r = await client.post(
                f"/api/v2/organizations/{org_id}/channel-connections/wordpress",
                json={"site_url": "https://customer-blog.example.com"},
            )
        assert r.status_code == 422, r.text
        error = r.json().get("error") or r.json()
        assert error["code"] == "WORDPRESS_FIELDS_REQUIRED"
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()


@pytest.mark.anyio
async def test_webhook_missing_fields_rejected():
    from app.main import app

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org_id, project_id = await _seed_org(s)
            human_id = await _seed_human(s, org_id, role="owner")

        _setup_org_scoped_app(app, Session, org_id, user_id=human_id, agent=False)
        async with _client_for(app) as client:
            r = await client.post(
                f"/api/v2/organizations/{org_id}/channel-connections/webhook",
                json={"target_url": "https://customer-target.example.com/hook"},
            )
        assert r.status_code == 422, r.text
        error = r.json().get("error") or r.json()
        assert error["code"] == "WEBHOOK_FIELDS_REQUIRED"
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()


@pytest.mark.anyio
async def test_non_pasted_secret_channel_rejected():
    """threads는 credential_kind="oauth" — 이 붙여넣기 엔드포인트 대상이 아니다."""
    from app.main import app

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org_id, project_id = await _seed_org(s)
            human_id = await _seed_human(s, org_id, role="owner")

        _setup_org_scoped_app(app, Session, org_id, user_id=human_id, agent=False)
        async with _client_for(app) as client:
            r = await client.post(
                f"/api/v2/organizations/{org_id}/channel-connections/threads",
                json={"site_url": "https://x.example.com", "username": "u", "app_password": "p"},
            )
        assert r.status_code == 404, r.text
        error = r.json().get("error") or r.json()
        assert error["code"] == "CHANNEL_NOT_PASTED_SECRET"
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()


@pytest.mark.anyio
async def test_wordpress_insecure_http_site_url_rejected():
    """조각④의 destination_url_safety.py를 등록 시점에도 친다 — 발행 시점까지 안
    기다리고 저장 자체를 막는다."""
    from app.main import app

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org_id, project_id = await _seed_org(s)
            human_id = await _seed_human(s, org_id, role="owner")

        _setup_org_scoped_app(app, Session, org_id, user_id=human_id, agent=False)
        async with _client_for(app) as client:
            r = await client.post(
                f"/api/v2/organizations/{org_id}/channel-connections/wordpress",
                json={"site_url": "http://insecure-blog.example.com", "username": "editor", "app_password": "pw"},
            )
        assert r.status_code == 422, r.text
        error = r.json().get("error") or r.json()
        assert error["code"] == "CHANNEL_CONNECTION_DESTINATION_INSECURE"
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()


@pytest.mark.anyio
async def test_wordpress_site_url_resolving_to_private_ip_rejected(dns_stub):
    """story e4fc29fa(조각⑤, 페드루 리뷰②) — https://라는 문자열만으론 라우트가
    `assert_destination_url_safe`를 실제로 부르는지(DNS 해석까지 포함) 증명이 안 된다
    — 스킴 거부(위 테스트)는 파싱만으로도 통과할 수 있어서다. 이 테스트는 스킴은
    정상(https)이지만 **해석된 IP가 사설 대역**인 도메인을 등록해, 라우트 층이
    진짜로 해석기를 호출해 그 결과까지 본다는 것을 잰다. 뮤테이션 대상: 라우트가
    `assert_destination_url_safe`를 안 부르고 스킴 문자열만 보면 이 assert가 RED."""
    dns_stub.map("attacker-controlled.example.com", "10.0.0.5")
    from app.main import app

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org_id, project_id = await _seed_org(s)
            human_id = await _seed_human(s, org_id, role="owner")

        _setup_org_scoped_app(app, Session, org_id, user_id=human_id, agent=False)
        async with _client_for(app) as client:
            r = await client.post(
                f"/api/v2/organizations/{org_id}/channel-connections/wordpress",
                json={
                    "site_url": "https://attacker-controlled.example.com", "username": "editor",
                    "app_password": "pw",
                },
            )
        assert r.status_code == 422, r.text
        error = r.json().get("error") or r.json()
        assert error["code"] == "CHANNEL_CONNECTION_DESTINATION_INSECURE"
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()


@pytest.mark.anyio
async def test_reconnect_same_site_url_is_idempotent_upsert(dns_stub):
    """story #3373 AC8 재사용 — 같은 (org, wordpress, site_url) 재호출은 새 행이
    아니라 기존 행 갱신(예: 비밀번호를 바꿔 재등록해도 connection id는 그대로)."""
    from app.main import app

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org_id, project_id = await _seed_org(s)
            human_id = await _seed_human(s, org_id, role="owner")

        _setup_org_scoped_app(app, Session, org_id, user_id=human_id, agent=False)
        async with _client_for(app) as client:
            r1 = await client.post(
                f"/api/v2/organizations/{org_id}/channel-connections/wordpress",
                json={"site_url": "https://customer-blog.example.com", "username": "editor", "app_password": "pw-old"},
            )
            r2 = await client.post(
                f"/api/v2/organizations/{org_id}/channel-connections/wordpress",
                json={"site_url": "https://customer-blog.example.com", "username": "editor2", "app_password": "pw-new"},
            )
        assert r1.status_code == 201, r1.text
        assert r2.status_code == 201, r2.text
        assert r1.json()["id"] == r2.json()["id"]
        assert r2.json()["account_label"] == "editor2"
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()
