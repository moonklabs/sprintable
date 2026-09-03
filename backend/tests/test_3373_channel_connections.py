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
    monkeypatch.setattr(config_module.settings, "threads_app_id", "test-app-id")
    monkeypatch.setattr(config_module.settings, "threads_app_secret", "test-app-secret")

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
