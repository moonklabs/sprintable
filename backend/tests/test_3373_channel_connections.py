"""story #3373(Phase1·마케팅운영, 선생님 확定 2026-09-03) — 채널 연결 서비스 골격.

AC 매핑:
- AC1: owner가 「Threads 연결」 시작 → state(+PKCE) 발급 → Meta OAuth 리다이렉트 → 콜백 후
  연결 행 생성, 계정명·연결자·시각이 목록에 보인다.
- AC2: 콜백에서 받은 토큰은 응답·로그·DB 어디에도 평문으로 없다(암호문만).
- AC3: state 위조·만료는 콜백에서 명시 거부, 연결 행 생성 안 됨.
- AC4: cron이 만료 임박 연결을 자동 갱신·실패 시 status=expired.
- AC5: owner 연결 해제 → 즉시 status=revoked·토큰 파기.
- AC6: 에이전트 키는 목록·시작·콜백·해제 어느 것을 불러도 403.
- AC7: owner가 목록에서 상태·연결자·시각 확인.
- AC8: 같은 (org, channel, account_id) 재연결은 upsert.

QA 관점(story 명시) — 토큰 평문이 응답·로그·DB 어디에도 없음을 grep으로 잰다.
뮤테이션 1건 — 콜백의 state 검증을 제거하면 «위조 state 거부» 테스트가 RED."""
from __future__ import annotations

import os
import uuid
from datetime import datetime, timedelta, timezone
from unittest.mock import AsyncMock, patch

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
    """crypto·state 시크릿을 매 테스트 새로 구성(격리) — billing_key_crypto 테스트와 동형 패턴."""
    import importlib
    from cryptography.fernet import Fernet

    import app.core.config as config_module
    monkeypatch.setattr(config_module.settings, "channel_credential_encryption_key", Fernet.generate_key().decode())
    monkeypatch.setattr(config_module.settings, "channel_oauth_state_secret", "test-channel-oauth-state-secret")

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


async def _seed_platform_settings(session, *, threads_app_id="platform-fallback-app-id", threads_app_secret="platform-fallback-secret"):
    """platform_settings 싱글턴 행 시드 — 실 마이그(0255)가 항상 이 행을 시드하므로 테스트
    DB도 실제 배포 상태를 그대로 반영한다(빈 테이블은 실제로 일어나지 않는 상태).
    threads_app_id/secret=None이면 미설정 상태(공용 앱 fallback도 없음)를 재현한다."""
    from app.models.platform_setting import PlatformSetting
    from app.services.channel_credential_crypto import encrypt_channel_credential

    row = PlatformSetting(
        id=uuid.uuid4(),
        threads_platform_app_id=threads_app_id,
        threads_platform_encrypted_app_secret=(
            encrypt_channel_credential(threads_app_secret) if threads_app_secret is not None else None
        ),
    )
    session.add(row)
    await session.commit()
    return row


async def _seed_org(
    session, *, slug=None, platform_threads_app_id="platform-fallback-app-id",
    platform_threads_app_secret="platform-fallback-secret",
):
    from app.models.organization import Organization
    from app.models.project import Project

    await _seed_platform_settings(
        session, threads_app_id=platform_threads_app_id, threads_app_secret=platform_threads_app_secret,
    )
    org = Organization(id=uuid.uuid4(), name="Channel Test Org", slug=slug or f"org-{uuid.uuid4().hex[:8]}")
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


# ─── crypto ─────────────────────────────────────────────────────────────────

def test_channel_credential_crypto_roundtrip():
    from app.services.channel_credential_crypto import decrypt_channel_credential, encrypt_channel_credential

    token = encrypt_channel_credential("super-secret-access-token")
    assert token != "super-secret-access-token"
    assert decrypt_channel_credential(token) == "super-secret-access-token"


# ─── OAuth state ────────────────────────────────────────────────────────────

def test_channel_oauth_state_roundtrip_and_pkce_challenge_derivation():
    import base64
    import hashlib

    from app.services.channel_oauth_state import (
        generate_pkce_pair, sign_channel_oauth_state, verify_channel_oauth_state,
    )

    verifier, challenge = generate_pkce_pair()
    expected_challenge = base64.urlsafe_b64encode(hashlib.sha256(verifier.encode()).digest()).decode().rstrip("=")
    assert challenge == expected_challenge

    org_id, member_id = uuid.uuid4(), uuid.uuid4()
    state = sign_channel_oauth_state(
        org_id=org_id, requester_member_id=member_id, channel="threads", code_verifier=verifier,
    )
    parsed = verify_channel_oauth_state(state, expected_channel="threads")
    assert parsed is not None
    assert parsed.org_id == org_id
    assert parsed.requester_member_id == member_id
    assert parsed.code_verifier == verifier


def test_channel_oauth_state_forged_signature_rejected():
    from app.services.channel_oauth_state import verify_channel_oauth_state

    forged = "eyJhbGciOiJub25lIn0.eyJvcmdfaWQiOiJ4In0."
    assert verify_channel_oauth_state(forged, expected_channel="threads") is None


def test_channel_oauth_state_wrong_channel_rejected():
    from app.services.channel_oauth_state import sign_channel_oauth_state, verify_channel_oauth_state

    state = sign_channel_oauth_state(
        org_id=uuid.uuid4(), requester_member_id=uuid.uuid4(), channel="threads", code_verifier="v",
    )
    assert verify_channel_oauth_state(state, expected_channel="instagram") is None


def test_channel_oauth_state_expired_but_correctly_signed_rejected():
    """카디르 QA 갭(2026-09-03 09:03Z) — 기존 위조 테스트는 malformed 문자열만 썼다. 정상
    형태 JWT(모든 필드 채워짐)·정서명(config_module의 실제 시크릿)·다만 exp가 과거인 케이스를
    실제로 만들어 거부되는지 잰다(뮤테이션 대상 — verify_exp를 끄면 이 테스트가 RED)."""
    import time
    from jose import jwt as jose_jwt

    import app.core.config as config_module
    from app.services.channel_oauth_state import verify_channel_oauth_state

    now = int(time.time())
    claims = {
        "org_id": str(uuid.uuid4()), "requester_member_id": str(uuid.uuid4()),
        "channel": "threads", "code_verifier": "v", "connection_id": None,
        "jti": uuid.uuid4().hex, "iat": now - 1000, "exp": now - 1, "aud": "channel-oauth",
    }
    token = jose_jwt.encode(claims, config_module.settings.channel_oauth_state_secret, algorithm="HS256")
    assert verify_channel_oauth_state(token, expected_channel="threads") is None


def test_channel_oauth_state_wrong_signature_but_well_formed_rejected():
    """카디르 QA 갭(2026-09-03 09:03Z) — 정상 형태(모든 필드·exp 유효) + 다른 키로 서명한
    토큰이 거부되는지 잰다(뮤테이션 대상 — verify_signature를 끄면 이 테스트가 RED)."""
    import time
    from jose import jwt as jose_jwt

    from app.services.channel_oauth_state import verify_channel_oauth_state

    now = int(time.time())
    claims = {
        "org_id": str(uuid.uuid4()), "requester_member_id": str(uuid.uuid4()),
        "channel": "threads", "code_verifier": "v", "connection_id": None,
        "jti": uuid.uuid4().hex, "iat": now, "exp": now + 600, "aud": "channel-oauth",
    }
    token = jose_jwt.encode(claims, "a-completely-different-wrong-secret-xyz", algorithm="HS256")
    assert verify_channel_oauth_state(token, expected_channel="threads") is None


# ─── router: agent 403 (AC6) ───────────────────────────────────────────────

@pytest.mark.anyio
async def test_agent_gets_403_on_every_endpoint():
    from app.main import app

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org_id, project_id = await _seed_org(s)
            agent_id = await _seed_agent(s, org_id, project_id)
        _setup_org_scoped_app(app, Session, org_id, user_id=agent_id, agent=True)

        async with _client_for(app) as client:
            r_list = await client.get(f"/api/v2/organizations/{org_id}/channel-connections")
            r_auth = await client.post(f"/api/v2/organizations/{org_id}/channel-connections/threads/authorize")
            r_cb = await client.post(
                f"/api/v2/organizations/{org_id}/channel-connections/threads/callback",
                json={"code": "x", "state": "y"},
            )
            r_test = await client.post(
                f"/api/v2/organizations/{org_id}/channel-connections/{uuid.uuid4()}/test",
            )
            r_disc = await client.post(
                f"/api/v2/organizations/{org_id}/channel-connections/{uuid.uuid4()}/disconnect",
            )
        for r in (r_list, r_auth, r_cb, r_test, r_disc):
            assert r.status_code == 403, r.text
            assert r.json()["error"]["code"] == "CHANNEL_CONNECTION_HUMAN_ONLY", r.text
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()


@pytest.mark.anyio
async def test_member_role_cannot_authorize_or_disconnect_only_owner_can():
    from app.main import app

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org_id, project_id = await _seed_org(s)
            member_id = await _seed_human(s, org_id, role="member")
        _setup_org_scoped_app(app, Session, org_id, user_id=member_id)

        async with _client_for(app) as client:
            r_auth = await client.post(f"/api/v2/organizations/{org_id}/channel-connections/threads/authorize")
        assert r_auth.status_code == 403, r_auth.text
        assert r_auth.json()["error"]["code"] == "CHANNEL_CONNECTION_OWNER_ONLY", r_auth.text

        # 목록 열람은 member로 충분해야 한다(AC7·유나 §8⑤).
        async with _client_for(app) as client:
            r_list = await client.get(f"/api/v2/organizations/{org_id}/channel-connections")
        assert r_list.status_code == 200, r_list.text
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()


# ─── authorize → callback happy path ───────────────────────────────────────

@pytest.mark.anyio
async def test_owner_authorize_then_callback_creates_connection_with_encrypted_token():
    from app.main import app
    import app.services.threads_oauth as ccr

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org_id, project_id = await _seed_org(s)
            owner_id = await _seed_human(s, org_id, role="owner")
        _setup_org_scoped_app(app, Session, org_id, user_id=owner_id)

        async with _client_for(app) as client:
            r_auth = await client.post(f"/api/v2/organizations/{org_id}/channel-connections/threads/authorize")
        assert r_auth.status_code == 200, r_auth.text
        state = r_auth.json()["state"]
        assert "code_challenge" in r_auth.json()["url"]

        plaintext_token = "th_plaintext_super_secret_token_zzz"
        with patch.object(
            ccr, "exchange_code_for_short_lived_token", AsyncMock(return_value=("short_lived_xyz", "ext-account-1")),
        ), patch.object(
            ccr, "exchange_for_long_lived_token", AsyncMock(return_value=(plaintext_token, 5184000)),
        ), patch.object(
            ccr, "test_connection", AsyncMock(return_value={"id": "ext-account-1", "username": "sprintable_demo"}),
        ):
            async with _client_for(app) as client:
                r_cb = await client.post(
                    f"/api/v2/organizations/{org_id}/channel-connections/threads/callback",
                    json={"code": "auth-code-abc", "state": state},
                )
        assert r_cb.status_code == 200, r_cb.text
        payload = r_cb.json()
        assert payload["channel"] == "threads"
        assert payload["account_label"] == "sprintable_demo"
        assert payload["status"] == "active"
        assert payload["can_auto_refresh"] is True
        # AC2 — 토큰이 응답 어디에도 없다.
        assert plaintext_token not in str(payload)

        async with Session() as s:
            from app.models.channel_connection import ChannelConnection
            from sqlalchemy import select
            row = (await s.execute(
                select(ChannelConnection).where(ChannelConnection.org_id == org_id)
            )).scalar_one()
        assert row.encrypted_access_token is not None
        assert row.encrypted_access_token != plaintext_token, "토큰이 평문 그대로 저장됐다(AC2 회귀)"
        # connected_by는 member-id 공간(resolve_member().id == org_members.id)이라 owner_id
        # (User.id)와 다른 값이 정상이다(feedback_member_bound_resource_resolve_member_axis
        # 관례 — resolve_member 축 값을 저장) — "누가 연결했는지 기록된다"만 확인한다.
        assert row.connected_by is not None
        assert row.credential_kind == "oauth"
        assert row.refresh_mode == "reissue_from_access_token"

        # 목록 API — 연결자·상태·시각(AC1·AC7), 토큰 필드는 응답 스키마에 아예 없다.
        async with _client_for(app) as client:
            r_list = await client.get(f"/api/v2/organizations/{org_id}/channel-connections")
        assert r_list.status_code == 200, r_list.text
        item = r_list.json()[0]
        assert "encrypted_access_token" not in item
        assert "access_token" not in item
        assert item["status"] == "active"
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()


@pytest.mark.anyio
async def test_reconnect_same_org_channel_account_upserts_not_duplicates():
    from app.main import app
    import app.services.threads_oauth as ccr

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org_id, project_id = await _seed_org(s)
            owner_id = await _seed_human(s, org_id, role="owner")
        _setup_org_scoped_app(app, Session, org_id, user_id=owner_id)

        async def _do_authorize_and_callback(username: str):
            async with _client_for(app) as client:
                r_auth = await client.post(f"/api/v2/organizations/{org_id}/channel-connections/threads/authorize")
            state = r_auth.json()["state"]
            with patch.object(
                ccr, "exchange_code_for_short_lived_token", AsyncMock(return_value=("sl", "ext-account-1")),
            ), patch.object(
                ccr, "exchange_for_long_lived_token", AsyncMock(return_value=("ll-token", 5184000)),
            ), patch.object(
                ccr, "test_connection", AsyncMock(return_value={"id": "ext-account-1", "username": username}),
            ):
                async with _client_for(app) as client:
                    return await client.post(
                        f"/api/v2/organizations/{org_id}/channel-connections/threads/callback",
                        json={"code": "c", "state": state},
                    )

        r1 = await _do_authorize_and_callback("first_name")
        r2 = await _do_authorize_and_callback("renamed_handle")
        assert r1.status_code == 200 and r2.status_code == 200
        assert r1.json()["id"] == r2.json()["id"], "같은 (org,channel,account_id) 재연결인데 새 행이 생겼다(AC8 회귀)"

        async with Session() as s:
            from app.models.channel_connection import ChannelConnection
            from sqlalchemy import func, select
            count = (await s.execute(
                select(func.count()).select_from(ChannelConnection).where(ChannelConnection.org_id == org_id)
            )).scalar_one()
        assert count == 1
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()


@pytest.mark.anyio
async def test_callback_with_forged_state_rejected_and_creates_no_row():
    """뮤테이션 대상 — verify_channel_oauth_state를 no-op(항상 통과)로 만들면 이 테스트가
    RED로 반드시 실패해야 한다."""
    from app.main import app

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org_id, project_id = await _seed_org(s)
            owner_id = await _seed_human(s, org_id, role="owner")
        _setup_org_scoped_app(app, Session, org_id, user_id=owner_id)

        async with _client_for(app) as client:
            r_cb = await client.post(
                f"/api/v2/organizations/{org_id}/channel-connections/threads/callback",
                json={"code": "auth-code", "state": "forged.invalid.state"},
            )
        assert r_cb.status_code == 400, r_cb.text
        assert r_cb.json()["error"]["code"] == "CHANNEL_OAUTH_STATE_INVALID", r_cb.text

        async with Session() as s:
            from app.models.channel_connection import ChannelConnection
            from sqlalchemy import func, select
            count = (await s.execute(select(func.count()).select_from(ChannelConnection))).scalar_one()
        assert count == 0
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()


@pytest.mark.anyio
async def test_callback_with_state_from_other_org_rejected():
    """다른 org 소유의 state를 이 org 콜백에 재사용 — org_id 불일치로 거부."""
    from app.main import app
    from app.services.channel_oauth_state import generate_pkce_pair, sign_channel_oauth_state

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org_a_id, _ = await _seed_org(s, slug="org-a")
            org_b_id, _ = await _seed_org(s, slug="org-b")
            owner_b_id = await _seed_human(s, org_b_id, role="owner")
        _setup_org_scoped_app(app, Session, org_b_id, user_id=owner_b_id)

        verifier, _ = generate_pkce_pair()
        state_for_org_a = sign_channel_oauth_state(
            org_id=org_a_id, requester_member_id=uuid.uuid4(), channel="threads", code_verifier=verifier,
        )
        async with _client_for(app) as client:
            r_cb = await client.post(
                f"/api/v2/organizations/{org_b_id}/channel-connections/threads/callback",
                json={"code": "c", "state": state_for_org_a},
            )
        assert r_cb.status_code == 400, r_cb.text
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()


# ─── disconnect (AC5) ───────────────────────────────────────────────────────

@pytest.mark.anyio
async def test_owner_disconnect_revokes_and_wipes_tokens():
    from app.main import app
    from app.models.channel_connection import ChannelConnection

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org_id, project_id = await _seed_org(s)
            owner_id = await _seed_human(s, org_id, role="owner")
            from app.services.channel_credential_crypto import encrypt_channel_credential
            row = ChannelConnection(
                id=uuid.uuid4(), org_id=org_id, channel="threads", account_id="acc-1",
                account_label="demo", credential_kind="oauth",
                encrypted_access_token=encrypt_channel_credential("plain-token"),
                refresh_mode="reissue_from_access_token", status="active", connected_by=owner_id,
            )
            s.add(row)
            await s.commit()
            connection_id = row.id
        _setup_org_scoped_app(app, Session, org_id, user_id=owner_id)

        async with _client_for(app) as client:
            r = await client.post(f"/api/v2/organizations/{org_id}/channel-connections/{connection_id}/disconnect")
        assert r.status_code == 200, r.text
        assert r.json()["status"] == "revoked"

        async with Session() as s:
            from sqlalchemy import select
            fresh = (await s.execute(select(ChannelConnection).where(ChannelConnection.id == connection_id))).scalar_one()
        assert fresh.status == "revoked"
        assert fresh.encrypted_access_token is None
        assert fresh.encrypted_refresh_token is None
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()


# ─── cron refresh (AC4) ─────────────────────────────────────────────────────

@pytest.mark.anyio
async def test_cron_refreshes_expiring_connection_and_updates_expiry():
    from app.models.channel_connection import ChannelConnection
    from app.services.channel_credential_crypto import encrypt_channel_credential
    from app.services.channel_connection import apply_refresh_result, list_connections_due_for_refresh

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org_id, project_id = await _seed_org(s)
            owner_id = await _seed_human(s, org_id, role="owner")
            row = ChannelConnection(
                id=uuid.uuid4(), org_id=org_id, channel="threads", account_id="acc-1", account_label="demo",
                credential_kind="oauth", encrypted_access_token=encrypt_channel_credential("old-token"),
                token_expires_at=datetime.now(timezone.utc) + timedelta(hours=1),  # 임박(48h 임계값 이내)
                refresh_mode="reissue_from_access_token", status="active", connected_by=owner_id,
            )
            s.add(row)
            await s.commit()

            due = await list_connections_due_for_refresh(s, now=datetime.now(timezone.utc))
            assert len(due) == 1
            target = due[0]

            await apply_refresh_result(s, connection=target, new_access_token="new-token", expires_in_seconds=5184000)

        async with Session() as s:
            from sqlalchemy import select
            fresh = (await s.execute(select(ChannelConnection).where(ChannelConnection.id == row.id))).scalar_one()
        assert fresh.status == "active"
        assert fresh.last_refreshed_at is not None
        assert fresh.token_expires_at > datetime.now(timezone.utc) + timedelta(days=50)
        assert fresh.encrypted_access_token != "new-token", "갱신된 토큰이 평문으로 저장됐다"
    finally:
        await engine.dispose()


@pytest.mark.anyio
async def test_cron_refresh_failure_sets_expired_status_with_provider_error():
    from app.models.channel_connection import ChannelConnection
    from app.services.channel_credential_crypto import encrypt_channel_credential
    from app.services.channel_connection import apply_refresh_failure

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org_id, project_id = await _seed_org(s)
            owner_id = await _seed_human(s, org_id, role="owner")
            row = ChannelConnection(
                id=uuid.uuid4(), org_id=org_id, channel="threads", account_id="acc-1", account_label="demo",
                credential_kind="oauth", encrypted_access_token=encrypt_channel_credential("old-token"),
                token_expires_at=datetime.now(timezone.utc) - timedelta(hours=1),  # 이미 만료
                refresh_mode="reissue_from_access_token", status="active", connected_by=owner_id,
            )
            s.add(row)
            await s.commit()

            await apply_refresh_failure(s, connection=row, error_message="(#100) token has been invalidated")

        async with Session() as s:
            from sqlalchemy import select
            fresh = (await s.execute(select(ChannelConnection).where(ChannelConnection.id == row.id))).scalar_one()
        assert fresh.status == "expired"
        assert fresh.last_error == "(#100) token has been invalidated"
    finally:
        await engine.dispose()


# ─── 평문 노출 grep(story 명시 QA 관점) ─────────────────────────────────────

@pytest.mark.anyio
async def test_plaintext_token_never_appears_in_any_json_response():
    from app.main import app
    import app.services.threads_oauth as ccr

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org_id, project_id = await _seed_org(s)
            owner_id = await _seed_human(s, org_id, role="owner")
        _setup_org_scoped_app(app, Session, org_id, user_id=owner_id)

        secret = "th_UNIQUELY_IDENTIFIABLE_PLAINTEXT_TOKEN_998877"
        async with _client_for(app) as client:
            r_auth = await client.post(f"/api/v2/organizations/{org_id}/channel-connections/threads/authorize")
        state = r_auth.json()["state"]

        with patch.object(
            ccr, "exchange_code_for_short_lived_token", AsyncMock(return_value=("sl", "acc-1")),
        ), patch.object(
            ccr, "exchange_for_long_lived_token", AsyncMock(return_value=(secret, 5184000)),
        ), patch.object(
            ccr, "test_connection", AsyncMock(return_value={"id": "acc-1", "username": "demo"}),
        ):
            async with _client_for(app) as client:
                r_cb = await client.post(
                    f"/api/v2/organizations/{org_id}/channel-connections/threads/callback",
                    json={"code": "c", "state": state},
                )
        async with _client_for(app) as client:
            r_list = await client.get(f"/api/v2/organizations/{org_id}/channel-connections")

        assert secret not in r_cb.text
        assert secret not in r_list.text
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()


# ─── 조직별 채널 앱 자격(선생님 지적·페드루 PO 정정 2026-09-03 08:29Z) ───────────────
# «Threads 앱 id/secret은 Sprintable 공용 시크릿 하나»였던 이전 설계는 틀린 전제 — Meta
# 앱은 조직마다 자기 것을 등록해 쓴다.

@pytest.mark.anyio
async def test_owner_can_set_app_credentials_response_has_no_secret():
    from app.main import app

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org_id, project_id = await _seed_org(s)
            owner_id = await _seed_human(s, org_id, role="owner")
        _setup_org_scoped_app(app, Session, org_id, user_id=owner_id)

        secret = "meta-app-secret-UNIQUELY-IDENTIFIABLE-123"
        async with _client_for(app) as client:
            r = await client.put(
                f"/api/v2/organizations/{org_id}/channel-connections/threads/app-credentials",
                json={"app_id": "org-meta-app-id", "app_secret": secret},
            )
        assert r.status_code == 200, r.text
        body = r.json()
        assert body["configured"] is True
        assert body["app_id"] == "org-meta-app-id"
        assert "app_secret" not in body
        assert secret not in r.text
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()


@pytest.mark.anyio
async def test_agent_gets_403_setting_app_credentials():
    from app.main import app

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org_id, project_id = await _seed_org(s)
            agent_id = await _seed_agent(s, org_id, project_id)
        _setup_org_scoped_app(app, Session, org_id, user_id=agent_id, agent=True)

        async with _client_for(app) as client:
            r = await client.put(
                f"/api/v2/organizations/{org_id}/channel-connections/threads/app-credentials",
                json={"app_id": "x", "app_secret": "y"},
            )
        assert r.status_code == 403, r.text
        assert r.json()["error"]["code"] == "CHANNEL_CONNECTION_HUMAN_ONLY", r.text
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()


@pytest.mark.anyio
async def test_member_role_gets_403_setting_app_credentials_only_owner_can():
    from app.main import app

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org_id, project_id = await _seed_org(s)
            member_id = await _seed_human(s, org_id, role="member")
        _setup_org_scoped_app(app, Session, org_id, user_id=member_id)

        async with _client_for(app) as client:
            r = await client.put(
                f"/api/v2/organizations/{org_id}/channel-connections/threads/app-credentials",
                json={"app_id": "x", "app_secret": "y"},
            )
        assert r.status_code == 403, r.text
        assert r.json()["error"]["code"] == "CHANNEL_CONNECTION_OWNER_ONLY", r.text
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()


# ─── 3단 우선순위(페드루 PO 확定 2026-09-03 08:40Z, 블루프린트 §8) — 조직 등록 →
# 플랫폼 공용 앱(platform_settings) → 없음(409) ─────────────────────────────────

@pytest.mark.anyio
async def test_authorize_without_org_credentials_or_platform_fallback_returns_409():
    """3단 中 ③ — 조직 자격도 플랫폼 공용 앱도 둘 다 없으면 409(Meta 호출 0건)."""
    from app.main import app

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org_id, project_id = await _seed_org(
                s, platform_threads_app_id=None, platform_threads_app_secret=None,
            )
            owner_id = await _seed_human(s, org_id, role="owner")
        _setup_org_scoped_app(app, Session, org_id, user_id=owner_id)

        async with _client_for(app) as client:
            r = await client.post(f"/api/v2/organizations/{org_id}/channel-connections/threads/authorize")
        assert r.status_code == 409, r.text
        assert r.json()["error"]["code"] == "CHANNEL_APP_CREDENTIALS_MISSING", r.text
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()


@pytest.mark.anyio
async def test_authorize_uses_platform_wide_app_when_org_has_no_credentials():
    """3단 中 ② — 조직 자격이 없으면 platform_settings의 공용 앱(SaaS 기본)을 쓴다."""
    from app.main import app

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org_id, project_id = await _seed_org(
                s, platform_threads_app_id="platform-wide-app-id", platform_threads_app_secret="platform-secret",
            )
            owner_id = await _seed_human(s, org_id, role="owner")
        _setup_org_scoped_app(app, Session, org_id, user_id=owner_id)

        async with _client_for(app) as client:
            r_auth = await client.post(f"/api/v2/organizations/{org_id}/channel-connections/threads/authorize")
        assert r_auth.status_code == 200, r_auth.text
        assert "client_id=platform-wide-app-id" in r_auth.json()["url"]
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()


@pytest.mark.anyio
async def test_authorize_after_setting_org_credentials_uses_org_app_id_not_platform_fallback():
    """3단 中 ① — 조직 자격이 있으면 platform_settings 공용 앱이 있어도(_seed_org 기본
    seed) 조직 값이 우선한다(페드루 PO 지시 — 설정 뒤 authorize URL에 그 app_id)."""
    from app.main import app

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org_id, project_id = await _seed_org(s)  # 플랫폼 기본값도 함께 시드됨(기본 인자)
            owner_id = await _seed_human(s, org_id, role="owner")
        _setup_org_scoped_app(app, Session, org_id, user_id=owner_id)

        async with _client_for(app) as client:
            r_put = await client.put(
                f"/api/v2/organizations/{org_id}/channel-connections/threads/app-credentials",
                json={"app_id": "org-registered-app-id-999", "app_secret": "org-secret"},
            )
        assert r_put.status_code == 200, r_put.text

        async with _client_for(app) as client:
            r_auth = await client.post(f"/api/v2/organizations/{org_id}/channel-connections/threads/authorize")
        assert r_auth.status_code == 200, r_auth.text
        assert "client_id=org-registered-app-id-999" in r_auth.json()["url"]
        assert "platform-fallback-app-id" not in r_auth.json()["url"]
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()


@pytest.mark.anyio
async def test_app_secret_stored_encrypted_not_plaintext_and_status_endpoint_shows_suffix_only():
    from app.main import app
    from app.models.channel_app_credential import ChannelAppCredentials
    from sqlalchemy import select

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org_id, project_id = await _seed_org(s)
            owner_id = await _seed_human(s, org_id, role="owner")
        _setup_org_scoped_app(app, Session, org_id, user_id=owner_id)

        secret = "meta-app-secret-UNIQUELY-IDENTIFIABLE-456"
        async with _client_for(app) as client:
            r_put = await client.put(
                f"/api/v2/organizations/{org_id}/channel-connections/threads/app-credentials",
                json={"app_id": "org-app-id-suffix-WXYZ", "app_secret": secret},
            )
        assert r_put.status_code == 200, r_put.text

        async with Session() as s:
            row = (await s.execute(
                select(ChannelAppCredentials).where(ChannelAppCredentials.org_id == org_id)
            )).scalar_one()
        assert row.encrypted_app_secret != secret
        assert secret not in row.encrypted_app_secret

        async with _client_for(app) as client:
            r_get = await client.get(f"/api/v2/organizations/{org_id}/channel-connections/threads/app-credentials")
        assert r_get.status_code == 200, r_get.text
        body = r_get.json()
        assert body["configured"] is True
        assert body["app_id_suffix"] == "WXYZ"
        assert secret not in r_get.text
        assert "org-app-id-suffix-WXYZ" not in r_get.text  # 끝4자리만, 전체 app_id는 아님
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()


@pytest.mark.anyio
async def test_get_app_credentials_status_configured_false_when_unset():
    """이 테스트만 platform_threads_app_id/secret도 비운다 — 순수 «둘 다 없음» 상태
    (effective_source='none')를 재현. _seed_org 기본값(platform-fallback-*)을 그대로 두면
    configured=false여도 effective_source='platform'이 나온다(그건 아래 별도 테스트)."""
    from app.main import app

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org_id, project_id = await _seed_org(
                s, platform_threads_app_id=None, platform_threads_app_secret=None,
            )
            member_id = await _seed_human(s, org_id, role="member")
        _setup_org_scoped_app(app, Session, org_id, user_id=member_id)

        async with _client_for(app) as client:
            r = await client.get(f"/api/v2/organizations/{org_id}/channel-connections/threads/app-credentials")
        assert r.status_code == 200, r.text
        assert r.json() == {
            "configured": False, "app_id_suffix": None, "updated_by": None, "updated_at": None,
            "effective_source": "none",
        }
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()


# ─── effective_source(페드루 PO 2026-09-03 11:19Z, 유나 화면설계 실측 — GET 상태 응답에
# «어디서 왔나» 신호 추가) ────────────────────────────────────────────────────────

@pytest.mark.anyio
async def test_get_app_credentials_status_effective_source_org_when_org_registered():
    from app.main import app

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org_id, project_id = await _seed_org(s)  # 플랫폼 기본값도 함께 시드됨(기본 인자)
            owner_id = await _seed_human(s, org_id, role="owner")
        _setup_org_scoped_app(app, Session, org_id, user_id=owner_id)

        async with _client_for(app) as client:
            r_put = await client.put(
                f"/api/v2/organizations/{org_id}/channel-connections/threads/app-credentials",
                json={"app_id": "org-app-id", "app_secret": "org-secret"},
            )
        assert r_put.status_code == 200, r_put.text

        async with _client_for(app) as client:
            r_get = await client.get(f"/api/v2/organizations/{org_id}/channel-connections/threads/app-credentials")
        assert r_get.status_code == 200, r_get.text
        assert r_get.json()["configured"] is True
        assert r_get.json()["effective_source"] == "org", (
            "조직이 직접 등록했으면 플랫폼 공용 앱이 있어도 org가 우선(3단 우선순위 그대로)"
        )
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()


@pytest.mark.anyio
async def test_get_app_credentials_status_effective_source_platform_when_org_unregistered():
    from app.main import app

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org_id, project_id = await _seed_org(
                s, platform_threads_app_id="platform-wide-app-id", platform_threads_app_secret="platform-secret",
            )
            member_id = await _seed_human(s, org_id, role="member")
        _setup_org_scoped_app(app, Session, org_id, user_id=member_id)

        async with _client_for(app) as client:
            r_get = await client.get(f"/api/v2/organizations/{org_id}/channel-connections/threads/app-credentials")
        assert r_get.status_code == 200, r_get.text
        assert r_get.json()["configured"] is False, "조직 등록은 없다 — 플랫폼 fallback뿐"
        assert r_get.json()["effective_source"] == "platform"
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()


@pytest.mark.anyio
async def test_get_app_credentials_status_effective_source_none_when_neither():
    from app.main import app

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org_id, project_id = await _seed_org(
                s, platform_threads_app_id=None, platform_threads_app_secret=None,
            )
            member_id = await _seed_human(s, org_id, role="member")
        _setup_org_scoped_app(app, Session, org_id, user_id=member_id)

        async with _client_for(app) as client:
            r_get = await client.get(f"/api/v2/organizations/{org_id}/channel-connections/threads/app-credentials")
        assert r_get.status_code == 200, r_get.text
        assert r_get.json()["configured"] is False
        assert r_get.json()["effective_source"] == "none"
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()


# ─── PKCE fallback flag(페드루 PO 2026-09-03 07:56Z — Meta가 code_challenge를 거부할 때
# 재배포 없이 끄는 자리) ────────────────────────────────────────────────────────

def test_build_authorize_url_includes_pkce_params_by_default(monkeypatch):
    import app.core.config as config_module
    monkeypatch.setattr(config_module.settings, "threads_pkce_enabled", True)

    from app.services.threads_oauth import build_authorize_url

    url = build_authorize_url(redirect_uri="https://x/callback", state="s", code_challenge="chal123", app_id="app-id")
    assert "code_challenge=chal123" in url
    assert "code_challenge_method=S256" in url
    assert "client_id=app-id" in url


def test_build_authorize_url_omits_pkce_params_when_flag_disabled(monkeypatch):
    import app.core.config as config_module
    monkeypatch.setattr(config_module.settings, "threads_pkce_enabled", False)

    from app.services.threads_oauth import build_authorize_url

    url = build_authorize_url(redirect_uri="https://x/callback", state="s", code_challenge="chal123", app_id="app-id")
    assert "code_challenge" not in url
    assert "chal123" not in url


@pytest.mark.anyio
async def test_short_lived_token_exchange_omits_code_verifier_when_pkce_disabled(monkeypatch):
    import app.core.config as config_module
    monkeypatch.setattr(config_module.settings, "threads_pkce_enabled", False)

    from app.services.threads_oauth import exchange_code_for_short_lived_token

    captured = {}

    class _FakeResponse:
        status_code = 200
        def json(self):
            return {"access_token": "tok", "user_id": "acc-1"}

    class _FakeClient:
        async def post(self, url, *, data):
            captured["data"] = data
            return _FakeResponse()

    await exchange_code_for_short_lived_token(
        _FakeClient(), code="c", redirect_uri="https://x/callback", code_verifier="verifier123",
        app_id="app-id", app_secret="app-secret",
    )
    assert "code_verifier" not in captured["data"]


@pytest.mark.anyio
async def test_short_lived_token_exchange_includes_code_verifier_by_default(monkeypatch):
    import app.core.config as config_module
    monkeypatch.setattr(config_module.settings, "threads_pkce_enabled", True)

    from app.services.threads_oauth import exchange_code_for_short_lived_token

    captured = {}

    class _FakeResponse:
        status_code = 200
        def json(self):
            return {"access_token": "tok", "user_id": "acc-1"}

    class _FakeClient:
        async def post(self, url, *, data):
            captured["data"] = data
            return _FakeResponse()

    await exchange_code_for_short_lived_token(
        _FakeClient(), code="c", redirect_uri="https://x/callback", code_verifier="verifier123",
        app_id="app-id", app_secret="app-secret",
    )
    assert captured["data"]["code_verifier"] == "verifier123"
    assert captured["data"]["client_id"] == "app-id"
    assert captured["data"]["client_secret"] == "app-secret"
