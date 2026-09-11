"""story #3808(Phase3·3-3 PR1, 페드루 PO 確定 2026-09-11) — X(트위터) 서버 OAuth
2.0(PKCE 필수)·1회용 회전 refresh_token. AC1 담당 파일 — 아래 4단:
① x_oauth.py 단위(PKCE 강제·단일 hop 교환·회전 refresh 3튜플)
② x_sandbox_oauth.py 단위(결정적 회전 세대·⭐옛 세대 재사용 마커)
③ channel_adapters.py 등재(refresh_mode="refresh_token" 기존 값 재사용 확認)
④ 실DB 통합 — apply_refresh_result 회전 슬롯 저장·cron 배선이 실제로 그 슬롯까지
  갈아 끼우는지(⭐AC1 뮤테이션 대상: 여기가 되돌리면 다음 tick이 이미 무효화된
  옛 refresh_token으로 또 실패한다)."""
from __future__ import annotations

import os
import uuid

import httpx
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


# ─── ① x_oauth.py — PKCE 강제·단일 hop 교환·회전 refresh 3튜플 ──────────────────

def test_build_authorize_url_always_includes_pkce_params():
    """threads_oauth.py와 다른 자리 — 우회 플래그가 없어 항상 code_challenge를 싣는다."""
    from app.services.x_oauth import build_authorize_url

    url = build_authorize_url(redirect_uri="https://x/callback", state="s", code_challenge="chal123", app_id="app-id")
    assert "code_challenge=chal123" in url
    assert "code_challenge_method=S256" in url
    assert "client_id=app-id" in url
    assert "offline.access" in url  # scope에 refresh_token 발급 필수 스코프가 실제로 실림


@pytest.mark.anyio
async def test_exchange_code_for_token_sends_basic_auth_and_code_verifier():
    """confidential client 인증(RFC 6749 §2.3.1) + PKCE code_verifier가 실제로 요청에
    실리는지 — 둘 다 빠지면 X가 즉시 invalid_request로 거부한다(실 계약)."""
    from app.services.x_oauth import exchange_code_for_token

    captured = {}

    class _FakeResponse:
        status_code = 200

        def json(self):
            return {"access_token": "at-1", "refresh_token": "rt-1", "expires_in": 7200}

    class _FakeClient:
        async def post(self, url, *, data, headers):
            captured["url"], captured["data"], captured["headers"] = url, data, headers
            return _FakeResponse()

    access_token, refresh_token, expires_in = await exchange_code_for_token(
        _FakeClient(), code="c", redirect_uri="https://x/callback", code_verifier="verifier-1",
        app_id="app-id", app_secret="app-secret",
    )
    assert (access_token, refresh_token, expires_in) == ("at-1", "rt-1", 7200)
    assert captured["data"]["code_verifier"] == "verifier-1"
    assert captured["data"]["grant_type"] == "authorization_code"
    assert captured["headers"]["Authorization"].startswith("Basic ")


@pytest.mark.anyio
async def test_exchange_code_for_token_missing_refresh_token_raises():
    """offline.access 스코프 누락 등으로 refresh_token이 안 오면 그 자리에서 즉시
    실패해야 한다(회전 갱신을 할 수 없는 연결을 조용히 저장하지 않는다)."""
    from app.services.x_oauth import XOAuthError, exchange_code_for_token

    class _FakeResponse:
        status_code = 200

        def json(self):
            return {"access_token": "at-1", "expires_in": 7200}  # refresh_token 없음

    class _FakeClient:
        async def post(self, url, *, data, headers):
            return _FakeResponse()

    with pytest.raises(XOAuthError) as exc_info:
        await exchange_code_for_token(
            _FakeClient(), code="c", redirect_uri="https://x/callback", code_verifier="v",
            app_id="app-id", app_secret="app-secret",
        )
    assert exc_info.value.code == "X_TOKEN_EXCHANGE_MISSING_FIELDS"


@pytest.mark.anyio
async def test_refresh_access_token_sends_refresh_token_grant_and_returns_rotated_triple():
    """⭐1회용 회전의 핵심 계약 — refresh_token grant로 호출하고, 새 access_token
    **과** 새 refresh_token 둘 다 돌아온다(2튜플이면 회전을 못 담는다)."""
    from app.services.x_oauth import refresh_access_token

    captured = {}

    class _FakeResponse:
        status_code = 200

        def json(self):
            return {"access_token": "at-2", "refresh_token": "rt-2", "expires_in": 7200}

    class _FakeClient:
        async def post(self, url, *, data, headers):
            captured["data"] = data
            return _FakeResponse()

    new_access, new_refresh, expires_in = await refresh_access_token(
        _FakeClient(), refresh_token="rt-1", app_id="app-id", app_secret="app-secret",
    )
    assert (new_access, new_refresh, expires_in) == ("at-2", "rt-2", 7200)
    assert captured["data"]["grant_type"] == "refresh_token"
    assert captured["data"]["refresh_token"] == "rt-1"


@pytest.mark.anyio
async def test_refresh_access_token_provider_rejection_raises_x_oauth_error():
    from app.services.x_oauth import XOAuthError, refresh_access_token

    class _FakeResponse:
        status_code = 400
        text = "invalid_grant: refresh_token expired or revoked"

    class _FakeClient:
        async def post(self, url, *, data, headers):
            return _FakeResponse()

    with pytest.raises(XOAuthError) as exc_info:
        await refresh_access_token(_FakeClient(), refresh_token="rt-stale", app_id="app-id", app_secret="app-secret")
    assert exc_info.value.code == "X_REFRESH_FAILED"


# ─── ② x_sandbox_oauth.py — 결정적 회전 세대·⭐옛 세대 재사용 마커 ─────────────

@pytest.mark.anyio
async def test_sandbox_exchange_returns_generation_zero_refresh_token():
    from app.services.x_sandbox_oauth import exchange_code_for_token

    access_token, refresh_token, expires_in = await exchange_code_for_token(
        httpx.AsyncClient(), code="c", redirect_uri="https://x/callback", code_verifier="v",
        app_id="app-1", app_secret="secret",
    )
    assert refresh_token == "sandbox-x-refresh:app-1:g0"
    assert access_token.startswith("sandbox-x-access:app-1")
    assert expires_in == 7200


@pytest.mark.anyio
async def test_sandbox_refresh_rotates_to_next_generation_with_new_access_token():
    """정상 회전 — 세대가 올라가고 access_token도 매번 새 값(⭐재사용 감지가
    문자열 대조로 가능해지는 이유)."""
    from app.services.x_sandbox_oauth import refresh_access_token

    new_access, new_refresh, expires_in = await refresh_access_token(
        httpx.AsyncClient(), refresh_token="sandbox-x-refresh:app-1:g0", app_id="app-1", app_secret="secret",
    )
    assert new_refresh.startswith("sandbox-x-refresh:app-1:g1:")
    assert new_refresh != "sandbox-x-refresh:app-1:g0"
    assert expires_in == 7200


@pytest.mark.anyio
async def test_sandbox_refresh_with_stale_generation_marker_raises_reused_error():
    """⭐AC1 뮤테이션 대상 — 「회전 후 옛 refresh로 재발급 시 실패 마커」의 결정적
    재현. 음수 세대(:g-1)가 «이미 회전돼 폐기된 refresh_token을 재사용»을 나타내는
    고정 마커(x_sandbox_oauth.py 상단 딱지)."""
    from app.services.x_oauth import XOAuthError
    from app.services.x_sandbox_oauth import refresh_access_token

    with pytest.raises(XOAuthError) as exc_info:
        await refresh_access_token(
            httpx.AsyncClient(), refresh_token="sandbox-x-refresh:app-1:g-1", app_id="app-1", app_secret="secret",
        )
    assert exc_info.value.code == "X_REFRESH_TOKEN_REUSED"
    assert "[sandbox:refresh-token-reused]" in exc_info.value.message


@pytest.mark.anyio
async def test_sandbox_refresh_with_malformed_token_also_raises_reused_error():
    """세대 파싱 실패(형식 오염)도 fail-closed로 같은 실패 마커 — "모르는 형식이면
    조용히 통과"가 아니다."""
    from app.services.x_oauth import XOAuthError
    from app.services.x_sandbox_oauth import refresh_access_token

    with pytest.raises(XOAuthError):
        await refresh_access_token(
            httpx.AsyncClient(), refresh_token="not-a-generation-token", app_id="app-1", app_secret="secret",
        )


# ─── ③ channel_adapters.py 등재 — refresh_mode="refresh_token" 기존 값 재사용 확認 ──

def test_x_and_x_sandbox_adapters_registered_with_rotating_refresh_mode():
    from app.services.channel_adapters import CHANNEL_ADAPTERS, can_auto_refresh

    for channel in ("x", "x_sandbox"):
        cfg = CHANNEL_ADAPTERS[channel]
        assert cfg.refresh_mode == "refresh_token"
        assert cfg.credential_kind == "oauth"
        assert cfg.kind == "social"
        assert "offline.access" in cfg.scope
    # 그라운딩 정정(2026-09-11) — 신규 enum값이 아니라 기존 값이 이미 자동갱신
    # 대상으로 잡히는지 pin(되돌리면 x/x_sandbox가 cron 루프에 애초에 안 올라온다).
    assert can_auto_refresh("refresh_token") is True


# ─── ④ 실DB 통합 — apply_refresh_result 회전 슬롯·cron 배선 ────────────────────

def _async_url() -> str:
    url = _REAL_DB_URL
    for prefix in ("postgresql+psycopg2://", "postgresql+asyncpg://", "postgresql://"):
        if url.startswith(prefix):
            return "postgresql+asyncpg://" + url[len(prefix):]
    return url


async def _session_factory():
    from sqlalchemy.ext.asyncio import create_async_engine, async_sessionmaker
    from app.core.database import Base
    import app.models  # noqa: F401

    engine = create_async_engine(_async_url())
    async with engine.begin() as conn:
        await conn.run_sync(Base.metadata.create_all)
    return engine, async_sessionmaker(engine, expire_on_commit=False)


async def _seed_org(session):
    from app.models.organization import Organization

    org = Organization(id=uuid.uuid4(), name="X OAuth Test Org", slug=f"org-{uuid.uuid4().hex[:8]}")
    session.add(org)
    await session.commit()
    return org.id


async def _seed_human(session, org_id):
    from app.models.project import OrgMember
    from app.models.user import User

    user = User(id=uuid.uuid4(), email=f"human-{uuid.uuid4().hex[:8]}@test.dev", hashed_password="x")
    session.add(user)
    await session.commit()
    om = OrgMember(id=uuid.uuid4(), org_id=org_id, user_id=user.id, role="owner")
    session.add(om)
    await session.commit()
    return user.id


async def _seed_x_sandbox_connection(session, org_id, *, refresh_token: str, connected_by: uuid.UUID, due=True):
    from datetime import datetime, timedelta, timezone
    from app.models.channel_connection import ChannelConnection
    from app.services.channel_credential_crypto import encrypt_channel_credential

    expires_at = (
        datetime.now(timezone.utc) - timedelta(minutes=1) if due
        else datetime.now(timezone.utc) + timedelta(days=1)
    )
    row = ChannelConnection(
        id=uuid.uuid4(), org_id=org_id, channel="x_sandbox", account_id=f"acct-{uuid.uuid4().hex[:8]}",
        credential_kind="oauth", encrypted_access_token=encrypt_channel_credential("sandbox-x-access:app-1"),
        encrypted_refresh_token=encrypt_channel_credential(refresh_token),
        token_expires_at=expires_at, refresh_mode="refresh_token", scopes=["tweet.read", "offline.access"],
        status="active", connected_by=connected_by,
    )
    session.add(row)
    await session.commit()
    return row.id


async def _seed_x_sandbox_app_credentials(session, org_id, *, app_id: str, updated_by: uuid.UUID):
    from app.models.channel_app_credential import ChannelAppCredentials
    from app.services.channel_credential_crypto import encrypt_channel_credential

    row = ChannelAppCredentials(
        id=uuid.uuid4(), org_id=org_id, channel="x_sandbox", app_id=app_id,
        encrypted_app_secret=encrypt_channel_credential("secret"), updated_by=updated_by,
    )
    session.add(row)
    await session.commit()


@pytest.mark.anyio
async def test_apply_refresh_result_persists_rotated_refresh_token_when_given():
    """⭐AC1 뮤테이션 대상(계층 1: 저장 함수 자체) — `new_refresh_token`을 안
    갈아 끼우면 이 테스트가 즉시 RED(옛 값이 그대로 남는다)."""
    from app.services.channel_connection import apply_refresh_result, decrypt_refresh_token_for_use

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org_id = await _seed_org(s)
            owner_id = await _seed_human(s, org_id)
            conn_id = await _seed_x_sandbox_connection(
                s, org_id, refresh_token="sandbox-x-refresh:app-1:g0", connected_by=owner_id,
            )

        async with Session() as s:
            from sqlalchemy import select
            from app.models.channel_connection import ChannelConnection

            row = (await s.execute(select(ChannelConnection).where(ChannelConnection.id == conn_id))).scalar_one()
            await apply_refresh_result(
                s, connection=row, new_access_token="sandbox-x-access:app-1:rotated",
                expires_in_seconds=7200, new_refresh_token="sandbox-x-refresh:app-1:g1:rotated",
            )

        async with Session() as s:
            from sqlalchemy import select
            from app.models.channel_connection import ChannelConnection

            row = (await s.execute(select(ChannelConnection).where(ChannelConnection.id == conn_id))).scalar_one()
            assert decrypt_refresh_token_for_use(row) == "sandbox-x-refresh:app-1:g1:rotated"
    finally:
        await engine.dispose()


@pytest.mark.anyio
async def test_cron_refresh_channel_tokens_rotates_x_sandbox_refresh_token(monkeypatch):
    """⭐AC1 뮤테이션 대상(계층 2: 실 cron 배선) — `_ROTATING_REFRESH_FN_BY_CHANNEL`
    dispatch나 `apply_refresh_result(new_refresh_token=...)` 배선을 되돌리면 RED
    (DB에 남는 refresh_token이 계속 "g0"이거나 status가 expired로 뒤집힌다)."""
    import app.routers.cron as cron_module
    from app.dependencies.database import get_worker_db
    from app.main import app
    from httpx import AsyncClient, ASGITransport
    from app.services.channel_connection import decrypt_refresh_token_for_use, decrypt_for_use

    monkeypatch.setattr(cron_module, "CRON_SECRET", "test-cron-secret")

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org_id = await _seed_org(s)
            owner_id = await _seed_human(s, org_id)
            await _seed_x_sandbox_app_credentials(s, org_id, app_id="app-1", updated_by=owner_id)
            conn_id = await _seed_x_sandbox_connection(
                s, org_id, refresh_token="sandbox-x-refresh:app-1:g0", connected_by=owner_id,
            )

        async def _worker_db():
            async with Session() as s:
                yield s

        app.dependency_overrides[get_worker_db] = _worker_db
        try:
            async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as client:
                r = await client.get(
                    "/api/v2/internal/cron/refresh-channel-tokens",
                    headers={"Authorization": "Bearer test-cron-secret"},
                )
            assert r.status_code == 200, r.text
            body = r.json()["data"]
            assert body["refreshed"] == 1
            assert body["failed"] == 0
        finally:
            app.dependency_overrides.pop(get_worker_db, None)

        async with Session() as s:
            from sqlalchemy import select
            from app.models.channel_connection import ChannelConnection

            row = (await s.execute(select(ChannelConnection).where(ChannelConnection.id == conn_id))).scalar_one()
            new_refresh = decrypt_refresh_token_for_use(row)
            assert new_refresh != "sandbox-x-refresh:app-1:g0"
            assert new_refresh.startswith("sandbox-x-refresh:app-1:g1:")
            assert decrypt_for_use(row) != "sandbox-x-access:app-1"
            assert row.status == "active"
    finally:
        await engine.dispose()


@pytest.mark.anyio
async def test_cron_refresh_channel_tokens_marks_stale_rotated_refresh_reuse_as_failure(monkeypatch):
    """카드 AC1 원문 그대로 — "회전 후 옛 refresh로 재발급 시 실패 마커"의 cron
    레벨 재현. 이미 폐기된(음수 세대 마커) refresh_token으로 저장돼 있는 연결은
    cron이 실패로 분류하고 status=expired로 sticky 전환한다(재시도 스톰 방지)."""
    import app.routers.cron as cron_module
    from app.dependencies.database import get_worker_db
    from app.main import app
    from httpx import AsyncClient, ASGITransport

    monkeypatch.setattr(cron_module, "CRON_SECRET", "test-cron-secret")

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org_id = await _seed_org(s)
            owner_id = await _seed_human(s, org_id)
            await _seed_x_sandbox_app_credentials(s, org_id, app_id="app-1", updated_by=owner_id)
            conn_id = await _seed_x_sandbox_connection(
                s, org_id, refresh_token="sandbox-x-refresh:app-1:g-1", connected_by=owner_id,
            )

        async def _worker_db():
            async with Session() as s:
                yield s

        app.dependency_overrides[get_worker_db] = _worker_db
        try:
            async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as client:
                r = await client.get(
                    "/api/v2/internal/cron/refresh-channel-tokens",
                    headers={"Authorization": "Bearer test-cron-secret"},
                )
            assert r.status_code == 200, r.text
            body = r.json()["data"]
            assert body["refreshed"] == 0
            assert body["failed"] == 1
        finally:
            app.dependency_overrides.pop(get_worker_db, None)

        async with Session() as s:
            from sqlalchemy import select
            from app.models.channel_connection import ChannelConnection

            row = (await s.execute(select(ChannelConnection).where(ChannelConnection.id == conn_id))).scalar_one()
            assert row.status == "expired"
            assert "[sandbox:refresh-token-reused]" in (row.last_error or "")
    finally:
        await engine.dispose()
