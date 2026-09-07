"""story #3373(Phase1·마케팅운영, 선생님 확定 2026-09-03) — crypto·OAuth state·agent
403(AC6)·authorize→callback happy path·disconnect(AC5). story #3579(2026-09-06, 페드루
PO 確定) 후속으로 `test_3373_channel_connections.py`(31 테스트)에서 3-way 분할 — 원본
파일이 러너 정규화 60초 가드 경계대역(36~77s 관측)에 있어 러너가 조금만 느려져도 가드에
걸림. 세팅 헬퍼·픽스처는 이 파일(`_auth`)이 그대로 소유(원본 그대로, 신규 헬퍼 0) —
`_app_credentials`·`_pkce` 두 파일 및 test_3320/test_3523/test_3547이 여기서 import.
autouse 픽스처(`_dispose_global_engine_after_test`·`_configure_secrets`)만 pytest
관례상 파일마다 재선언(import로는 전파 안 됨, story #3562 전례와 동일).

이 파일 담당 — crypto 왕복(AC2)·OAuth state 위조/만료/서명(AC3)·에이전트 403(AC6)·
authorize→callback happy path+재연결 upsert(AC1/AC8)·disconnect(AC5).

QA 관점(story 명시) — 토큰 평문이 응답·로그·DB 어디에도 없음을 grep으로 잰다(별도 파일
`_app_credentials`에서 담당). 뮤테이션 1건 — 콜백의 state 검증을 제거하면 «위조 state
거부» 테스트가 RED."""
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


# ─── story #3650 — 재연결 대상 행≠콜백 계정 mismatch 신호 ───────────────────

@pytest.mark.anyio
async def test_authorize_with_foreign_org_target_connection_id_rejected_404():
    """IDOR 방지 — target_connection_id가 이 org 소유가 아니면 authorize 자체를 막는다
    (콜백 mismatch 판정이 믿는 값이 여기서부터 정직해야 한다)."""
    from app.main import app
    from app.models.channel_connection import ChannelConnection

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org_a_id, _ = await _seed_org(s, slug="org-a-3650")
            org_b_id, _ = await _seed_org(s, slug="org-b-3650")
            owner_a_id = await _seed_human(s, org_a_id, role="owner")
            other_org_row = ChannelConnection(
                id=uuid.uuid4(), org_id=org_b_id, channel="threads", account_id="acc-b",
                account_label="b", credential_kind="oauth", refresh_mode="reissue_from_access_token",
                status="needs_reauth", connected_by=owner_a_id,
            )
            s.add(other_org_row)
            await s.commit()
            foreign_connection_id = other_org_row.id
        _setup_org_scoped_app(app, Session, org_a_id, user_id=owner_a_id)

        async with _client_for(app) as client:
            r_auth = await client.post(
                f"/api/v2/organizations/{org_a_id}/channel-connections/threads/authorize",
                json={"target_connection_id": str(foreign_connection_id)},
            )
        assert r_auth.status_code == 404, r_auth.text
        assert r_auth.json()["error"]["code"] == "CHANNEL_CONNECTION_NOT_FOUND"
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()


@pytest.mark.anyio
async def test_reconnect_target_matches_callback_account_no_mismatch():
    """재연결 대상 행과 콜백이 돌려준 계정이 같으면(정상 재인증) mismatch 신호가 없다."""
    from app.main import app
    from app.models.channel_connection import ChannelConnection
    import app.services.threads_oauth as ccr

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org_id, _ = await _seed_org(s)
            owner_id = await _seed_human(s, org_id, role="owner")
            row = ChannelConnection(
                id=uuid.uuid4(), org_id=org_id, channel="threads", account_id="ext-account-1",
                account_label="page1", credential_kind="oauth", refresh_mode="reissue_from_access_token",
                status="needs_reauth", connected_by=owner_id,
            )
            s.add(row)
            await s.commit()
            target_id = row.id
        _setup_org_scoped_app(app, Session, org_id, user_id=owner_id)

        async with _client_for(app) as client:
            r_auth = await client.post(
                f"/api/v2/organizations/{org_id}/channel-connections/threads/authorize",
                json={"target_connection_id": str(target_id)},
            )
        assert r_auth.status_code == 200, r_auth.text
        state = r_auth.json()["state"]

        with patch.object(
            ccr, "exchange_code_for_short_lived_token", AsyncMock(return_value=("sl", "ext-account-1")),
        ), patch.object(
            ccr, "exchange_for_long_lived_token", AsyncMock(return_value=("ll", 5184000)),
        ), patch.object(
            ccr, "test_connection", AsyncMock(return_value={"id": "ext-account-1", "username": "page1"}),
        ):
            async with _client_for(app) as client:
                r_cb = await client.post(
                    f"/api/v2/organizations/{org_id}/channel-connections/threads/callback",
                    json={"code": "c", "state": state},
                )
        assert r_cb.status_code == 200, r_cb.text
        payload = r_cb.json()
        assert payload["id"] == str(target_id)
        assert payload["reconnect_mismatch_target_id"] is None
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()


@pytest.mark.anyio
async def test_reconnect_target_differs_from_callback_account_mismatch_signaled():
    """dev 실측 재현(threads 축) — Page 2 행에서 「다시 연결」을 눌렀는데 콜백이 다른
    계정(Page 1에 해당하는 ext-account-1)을 돌려주면, 그 계정이 실제로 매핑되는 행이
    갱신되고(사실 유지) 응답에 mismatch_target_id=Page 2 행 id가 실린다. 뮤테이션
    대상 — mismatch 판정 줄을 지우면 이 단언이 RED."""
    from app.main import app
    from app.models.channel_connection import ChannelConnection
    import app.services.threads_oauth as ccr

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org_id, _ = await _seed_org(s)
            owner_id = await _seed_human(s, org_id, role="owner")
            page1_row = ChannelConnection(
                id=uuid.uuid4(), org_id=org_id, channel="threads", account_id="ext-account-1",
                account_label="page1", credential_kind="oauth", refresh_mode="reissue_from_access_token",
                status="active", connected_by=owner_id,
            )
            page2_row = ChannelConnection(
                id=uuid.uuid4(), org_id=org_id, channel="threads", account_id="ext-account-2",
                account_label="page2", credential_kind="oauth", refresh_mode="reissue_from_access_token",
                status="needs_reauth", connected_by=owner_id,
            )
            s.add_all([page1_row, page2_row])
            await s.commit()
            page1_id, page2_id = page1_row.id, page2_row.id
        _setup_org_scoped_app(app, Session, org_id, user_id=owner_id)

        # Page 2 행에서 "다시 연결"을 누른다(target=page2) — 그런데 브라우저가 돌아온
        # 계정은 ext-account-1(Page 1)이다(dev 실측: 사용자가 Meta 다이얼로그에서
        # 다른 계정을 골랐거나, sandbox처럼 고정 계정인 경우).
        async with _client_for(app) as client:
            r_auth = await client.post(
                f"/api/v2/organizations/{org_id}/channel-connections/threads/authorize",
                json={"target_connection_id": str(page2_id)},
            )
        state = r_auth.json()["state"]

        with patch.object(
            ccr, "exchange_code_for_short_lived_token", AsyncMock(return_value=("sl", "ext-account-1")),
        ), patch.object(
            ccr, "exchange_for_long_lived_token", AsyncMock(return_value=("ll", 5184000)),
        ), patch.object(
            ccr, "test_connection", AsyncMock(return_value={"id": "ext-account-1", "username": "page1"}),
        ):
            async with _client_for(app) as client:
                r_cb = await client.post(
                    f"/api/v2/organizations/{org_id}/channel-connections/threads/callback",
                    json={"code": "c", "state": state},
                )
        assert r_cb.status_code == 200, r_cb.text
        payload = r_cb.json()
        # 갱신 사실은 그대로 — ext-account-1에 매핑되는 page1_row가 갱신됐다(정직).
        assert payload["id"] == str(page1_id)
        assert payload["status"] == "active"
        # 화면이 침묵하지 않게 하는 신호 — 의도한 대상(page2)을 알린다.
        assert payload["reconnect_mismatch_target_id"] == str(page2_id)

        async with Session() as s:
            from sqlalchemy import select
            fresh_page2 = (await s.execute(select(ChannelConnection).where(ChannelConnection.id == page2_id))).scalar_one()
        assert fresh_page2.status == "needs_reauth", "의도한 행(page2)은 갱신되지 않고 그대로 남아야 한다"
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()


@pytest.mark.anyio
async def test_facebook_sandbox_single_page_reconnect_mismatch_signaled():
    """dev 실측 그대로(facebook_sandbox 축) — sandbox는 고정 계정 1개라 어느 행에서
    「다시 연결」을 눌러도 그 고정 계정으로 upsert된다. Page 2 행 target으로 authorize
    했는데 sandbox 모듈이 항상 Page 1 계정을 돌려주면 mismatch가 실린다."""
    from app.main import app
    from app.models.channel_connection import ChannelConnection
    import app.services.facebook_sandbox_oauth as fbs

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org_id, _ = await _seed_org(s)
            owner_id = await _seed_human(s, org_id, role="owner")
            # facebook_sandbox는 platform_settings 공용 앱 fallback 컬럼이 없다
            # (_PLATFORM_SETTINGS_COLUMNS 미등재) — org 자체 등록이 유일한 경로.
            from app.services.channel_app_credentials import upsert_channel_app_credentials
            await upsert_channel_app_credentials(
                s, org_id=org_id, channel="facebook_sandbox", app_id="org-fb-app-id",
                app_secret="org-fb-app-secret", updated_by=owner_id,
            )
            page1_row = ChannelConnection(
                id=uuid.uuid4(), org_id=org_id, channel="facebook_sandbox", account_id="fb-page-1",
                account_label="Page 1", credential_kind="oauth", refresh_mode="reissue_from_access_token",
                status="active", connected_by=owner_id,
            )
            page2_row = ChannelConnection(
                id=uuid.uuid4(), org_id=org_id, channel="facebook_sandbox", account_id="fb-page-2",
                account_label="Page 2", credential_kind="oauth", refresh_mode="reissue_from_access_token",
                status="needs_reauth", connected_by=owner_id,
            )
            s.add_all([page1_row, page2_row])
            await s.commit()
            page1_id, page2_id = page1_row.id, page2_row.id
        _setup_org_scoped_app(app, Session, org_id, user_id=owner_id)

        async with _client_for(app) as client:
            r_auth = await client.post(
                f"/api/v2/organizations/{org_id}/channel-connections/facebook_sandbox/authorize",
                json={"target_connection_id": str(page2_id)},
            )
        assert r_auth.status_code == 200, r_auth.text
        state = r_auth.json()["state"]

        with patch.object(
            fbs, "exchange_code_for_short_lived_token", AsyncMock(return_value=("sl", None)),
        ), patch.object(
            fbs, "exchange_for_long_lived_token", AsyncMock(return_value=("ll", 5184000)),
        ), patch.object(
            fbs, "list_pages", AsyncMock(return_value=[{"page_id": "fb-page-1", "name": "Page 1", "access_token": "pt"}]),
        ):
            async with _client_for(app) as client:
                r_cb = await client.post(
                    f"/api/v2/organizations/{org_id}/channel-connections/facebook_sandbox/callback",
                    json={"code": "c", "state": state},
                )
        assert r_cb.status_code == 200, r_cb.text
        payload = r_cb.json()
        assert payload["id"] == str(page1_id)
        assert payload["reconnect_mismatch_target_id"] == str(page2_id)
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()


