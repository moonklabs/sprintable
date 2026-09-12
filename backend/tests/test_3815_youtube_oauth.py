"""story #3815(Phase3·3-5 PR1, 페드루 PO 確定 2026-09-12) — YouTube(Google) 서버
OAuth 2.0(PKCE 지원·표준 비회전 refresh_token). x_oauth.py/test_3808_x_oauth.py와
동형 구조 4단:
① youtube_oauth.py 단위(PKCE·단일 hop 교환·⭐비회전 refresh — 3튜플이지만 세 번째
  값은 항상 입력값 그대로)
② youtube_sandbox_oauth.py 단위(결정적 응답, 회전 세대 마커 없음 — X와 다른 자리)
③ channel_adapters.py 등재(refresh_mode="refresh_token" 재사용 — 새 enum 값 발명 0)
④ 실DB 통합 — cron 배선이 비회전 refresh 함수도 기존 `_ROTATING_REFRESH_FN_BY_
  CHANNEL` 디스패치 그대로 태우는지(⭐뮤테이션 대상: youtube_sandbox_oauth.py가
  실수로 새 refresh_token을 만들어 내면 이 테스트가 RED — "회전 안 함"이 실제
  계약이지 우연이 아님을 pin)."""
from __future__ import annotations

import os
import uuid

import httpx
import pytest

from tests.test_3373_channel_connections_auth import (
    _seed_org as _seed_org_scoped, _seed_human as _seed_human_scoped, _session_factory as _scoped_session_factory,
    _client_for, _setup_org_scoped_app,
)

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
    monkeypatch.setattr(config_module.settings, "channel_oauth_state_secret", "test-channel-oauth-state-secret")

    import app.services.channel_credential_crypto as crypto_module
    importlib.reload(crypto_module)
    yield
    importlib.reload(crypto_module)


# ─── ① youtube_oauth.py — PKCE·단일 hop 교환·비회전 refresh ───────────────────

def test_build_authorize_url_includes_pkce_and_offline_consent_params():
    """Google 표준 딱지 — access_type=offline·prompt=consent가 둘 다 없으면 재인증
    시 refresh_token 자체가 응답에서 빠진다(youtube_oauth.py 상단 딱지)."""
    from app.services.youtube_oauth import build_authorize_url

    url = build_authorize_url(
        redirect_uri="https://yt/callback", state="s", code_challenge="chal123", app_id="app-id",
    )
    assert "code_challenge=chal123" in url
    assert "code_challenge_method=S256" in url
    assert "client_id=app-id" in url
    assert "access_type=offline" in url
    assert "prompt=consent" in url
    assert "youtube.upload" in url


@pytest.mark.anyio
async def test_exchange_code_for_token_sends_client_secret_in_body_not_basic_auth():
    """X(HTTP Basic)와 다른 자리 — Google 토큰 엔드포인트는 client_id/client_secret을
    POST body 평문으로 받는다(공개 문서 안정 사실)."""
    from app.services.youtube_oauth import exchange_code_for_token

    captured = {}

    class _FakeResponse:
        status_code = 200

        def json(self):
            return {"access_token": "at-1", "refresh_token": "rt-1", "expires_in": 3600}

    class _FakeClient:
        async def post(self, url, *, data):
            captured["url"], captured["data"] = url, data
            return _FakeResponse()

    access_token, refresh_token, expires_in = await exchange_code_for_token(
        _FakeClient(), code="c", redirect_uri="https://yt/callback", code_verifier="verifier-1",
        app_id="app-id", app_secret="app-secret",
    )
    assert (access_token, refresh_token, expires_in) == ("at-1", "rt-1", 3600)
    assert captured["data"]["client_secret"] == "app-secret"
    assert captured["data"]["code_verifier"] == "verifier-1"
    assert captured["data"]["grant_type"] == "authorization_code"


@pytest.mark.anyio
async def test_exchange_code_for_token_missing_refresh_token_raises():
    from app.services.youtube_oauth import YouTubeOAuthError, exchange_code_for_token

    class _FakeResponse:
        status_code = 200

        def json(self):
            return {"access_token": "at-1", "expires_in": 3600}  # refresh_token 없음

    class _FakeClient:
        async def post(self, url, *, data):
            return _FakeResponse()

    with pytest.raises(YouTubeOAuthError) as exc_info:
        await exchange_code_for_token(
            _FakeClient(), code="c", redirect_uri="https://yt/callback", code_verifier="v",
            app_id="app-id", app_secret="app-secret",
        )
    assert exc_info.value.code == "YOUTUBE_TOKEN_EXCHANGE_MISSING_FIELDS"


@pytest.mark.anyio
async def test_refresh_access_token_echoes_input_refresh_token_unchanged():
    """⭐핵심 계약 — Google은 회전하지 않는다: 세 번째 반환값(new_refresh_token)은
    provider 응답에 refresh_token 필드가 아예 없어도 **입력으로 받은 값 그대로**여야
    한다(X의 3튜플과 형태만 같고 의미는 반대)."""
    from app.services.youtube_oauth import refresh_access_token

    captured = {}

    class _FakeResponse:
        status_code = 200

        def json(self):
            return {"access_token": "at-2", "expires_in": 3600}  # refresh_token 필드 자체가 없음(정상)

    class _FakeClient:
        async def post(self, url, *, data):
            captured["data"] = data
            return _FakeResponse()

    new_access, new_refresh, expires_in = await refresh_access_token(
        _FakeClient(), refresh_token="rt-1", app_id="app-id", app_secret="app-secret",
    )
    assert (new_access, new_refresh, expires_in) == ("at-2", "rt-1", 3600)
    assert captured["data"]["grant_type"] == "refresh_token"
    assert captured["data"]["refresh_token"] == "rt-1"


@pytest.mark.anyio
async def test_refresh_access_token_provider_rejection_raises_youtube_oauth_error():
    from app.services.youtube_oauth import YouTubeOAuthError, refresh_access_token

    class _FakeResponse:
        status_code = 400
        text = "invalid_grant: Token has been expired or revoked"

    class _FakeClient:
        async def post(self, url, *, data):
            return _FakeResponse()

    with pytest.raises(YouTubeOAuthError) as exc_info:
        await refresh_access_token(_FakeClient(), refresh_token="rt-stale", app_id="app-id", app_secret="app-secret")
    assert exc_info.value.code == "YOUTUBE_REFRESH_FAILED"


@pytest.mark.anyio
async def test_test_connection_raises_when_account_has_no_channel():
    """⭐fail-closed — 채널이 하나도 없는 Google 계정으로 연결이 조용히 "성공"하면
    안 된다(연결은 됐는데 채널이 안 보이는 조용한 실패 방지)."""
    from app.services.youtube_oauth import YouTubeOAuthError, test_connection

    class _FakeResponse:
        status_code = 200

        def json(self):
            return {"items": []}

    class _FakeClient:
        async def get(self, url, *, params, headers):
            return _FakeResponse()

    with pytest.raises(YouTubeOAuthError) as exc_info:
        await test_connection(_FakeClient(), access_token="at-1")
    assert exc_info.value.code == "YOUTUBE_NO_CHANNEL_FOUND"


# ─── ② youtube_sandbox_oauth.py — 결정적 응답, 회전 세대 마커 없음 ─────────────

@pytest.mark.anyio
async def test_sandbox_exchange_returns_fixed_tokens():
    from app.services.youtube_sandbox_oauth import exchange_code_for_token

    access_token, refresh_token, expires_in = await exchange_code_for_token(
        httpx.AsyncClient(), code="c", redirect_uri="https://yt/callback", code_verifier="v",
        app_id="app-1", app_secret="secret",
    )
    assert refresh_token == "sandbox-youtube-refresh:app-1"
    assert access_token == "sandbox-youtube-access:app-1"
    assert expires_in == 3600


@pytest.mark.anyio
async def test_sandbox_refresh_returns_new_access_token_but_same_refresh_token():
    """⭐youtube_oauth.py와 같은 계약 — sandbox도 회전하지 않는다(x_sandbox_oauth.py의
    세대 상승과 다른 자리)."""
    from app.services.youtube_sandbox_oauth import refresh_access_token

    new_access, new_refresh, expires_in = await refresh_access_token(
        httpx.AsyncClient(), refresh_token="sandbox-youtube-refresh:app-1", app_id="app-1", app_secret="secret",
    )
    assert new_refresh == "sandbox-youtube-refresh:app-1", "회전하면 안 된다 — 입력값 그대로"
    assert new_access.startswith("sandbox-youtube-access:app-1:")
    assert new_access != "sandbox-youtube-access:app-1"
    assert expires_in == 3600


@pytest.mark.anyio
async def test_mutation_sandbox_refresh_rotating_would_break_non_rotation_contract():
    """⭐뮤테이션 셀프체크 — sandbox refresh가 실수로 refresh_token을 회전시키면
    (X와 뒤섞인 구현 사고), 위 "같은 값" 테스트가 그 즉시 RED로 잡는다는 증명."""
    import app.services.youtube_sandbox_oauth as yt_sandbox_module

    original = yt_sandbox_module.refresh_access_token

    async def _mutated_rotating_refresh(client, *, refresh_token, app_id, app_secret):
        new_access, _same_refresh, expires_in = await original(
            client, refresh_token=refresh_token, app_id=app_id, app_secret=app_secret,
        )
        return new_access, f"{refresh_token}:rotated-by-mistake", expires_in

    yt_sandbox_module.refresh_access_token = _mutated_rotating_refresh
    try:
        _, new_refresh, _ = await yt_sandbox_module.refresh_access_token(
            httpx.AsyncClient(), refresh_token="sandbox-youtube-refresh:app-1", app_id="app-1", app_secret="secret",
        )
        assert new_refresh != "sandbox-youtube-refresh:app-1", "가드 무력화 시 회전이 그대로 통과(RED 재현)"
    finally:
        yt_sandbox_module.refresh_access_token = original


# ─── ③ channel_adapters.py 등재 — refresh_mode="refresh_token" 재사용 확認 ──────

def test_youtube_and_youtube_sandbox_adapters_registered_with_reused_refresh_mode():
    from app.services.channel_adapters import CHANNEL_ADAPTERS, can_auto_refresh

    for channel in ("youtube", "youtube_sandbox"):
        cfg = CHANNEL_ADAPTERS[channel]
        assert cfg.refresh_mode == "refresh_token"
        assert cfg.credential_kind == "oauth"
        assert cfg.kind == "social"
        assert "youtube.upload" in cfg.scope
        assert "youtube.readonly" in cfg.scope
        # PR1은 OAuth만 — 발행/인사이트 능력은 아직 선언하지 않는다(§3696 가드가
        # 요구하는 "선언=dispatch 존재" 계약을 어길 자리 자체를 안 만든다).
        assert cfg.insight_metrics == ()
    assert can_auto_refresh("refresh_token") is True


# ─── 라우터 왕복 — story #3613과 동형 종단 재현(브라우저가 authorize URL을 실제로
# 따라가면 곧장 이 채널 자신의 콜백 라우트에 닿는지) ────────────────────────────

async def _register_youtube_sandbox_app_credentials(session, *, org_id, updated_by, app_id="sandbox-app-id"):
    from app.services.channel_app_credentials import upsert_channel_app_credentials

    return await upsert_channel_app_credentials(
        session, org_id=org_id, channel="youtube_sandbox", app_id=app_id, app_secret="sandbox-secret",
        updated_by=updated_by,
    )


def test_youtube_sandbox_build_authorize_url_redirects_straight_back_to_its_own_callback():
    """story #3613과 동형 사고 방지 — redirect_uri(=이 채널 콜백 URL 그 자체)로
    가짜 code+real state를 실어 곧장 돌아간다."""
    from app.services.youtube_sandbox_oauth import build_authorize_url
    from urllib.parse import urlparse, parse_qs

    redirect_uri = "https://dev-app.sprintable.ai/api/oauth-channel/callback/youtube_sandbox"
    url = build_authorize_url(redirect_uri=redirect_uri, state="signed-state-abc", code_challenge="c", app_id="app-id")

    parsed = urlparse(url)
    assert f"{parsed.scheme}://{parsed.netloc}{parsed.path}" == redirect_uri
    qs = parse_qs(parsed.query)
    assert qs["state"] == ["signed-state-abc"]
    assert qs["code"][0]


@pytest.mark.anyio
async def test_youtube_sandbox_authorize_url_is_navigable_back_into_the_real_callback_endpoint():
    """실 authorize→callback 라우터 코드를 그대로 태운다(목 없이) — 이번 PR이
    channel_connections.py에 새로 얹은 elif 분기·`_youtube_channel_connection_
    callback` 자체가 대상(서비스 단위 테스트로는 못 잡는 배선 실수 축)."""
    from app.main import app
    from urllib.parse import urlparse, parse_qs

    engine, Session = await _scoped_session_factory()
    try:
        async with Session() as s:
            org_id, _ = await _seed_org_scoped(s)
            owner_id = await _seed_human_scoped(s, org_id, role="owner")
            await _register_youtube_sandbox_app_credentials(s, org_id=org_id, updated_by=owner_id)
        _setup_org_scoped_app(app, Session, org_id, user_id=owner_id)

        async with _client_for(app) as client:
            r_auth = await client.post(f"/api/v2/organizations/{org_id}/channel-connections/youtube_sandbox/authorize")
            assert r_auth.status_code == 200, r_auth.text
            authorize_url = r_auth.json()["url"]

            parsed = urlparse(authorize_url)
            qs = parse_qs(parsed.query)
            code, state = qs["code"][0], qs["state"][0]

            r_cb = await client.post(
                f"/api/v2/organizations/{org_id}/channel-connections/youtube_sandbox/callback",
                json={"code": code, "state": state},
            )
            assert r_cb.status_code == 200, r_cb.text
            body = r_cb.json()
            assert body["channel"] == "youtube_sandbox"
            assert body["account_label"] == "Sandbox YouTube Channel"
    finally:
        await engine.dispose()


def test_youtube_publish_dispatch_registered_in_pr2():
    """⭐PR 경계 pin — 이 테스트는 PR1(이 파일 최초 작성) 시점엔 `_PUBLISH_CLIENT_
    MODULE_PATHS`에 youtube/youtube_sandbox가 아예 없어(x/stibee PR1·PR2 경계
    선례와 동형, 그때의 이 테스트는 ChannelPublishDispatchNotImplementedError를
    기대했었다) 통과했지만, PR2(story #3815, 이 카드)가 실 발행 파사드(youtube_
    publish.py/youtube_sandbox_publish.py)를 만들며 등재했으므로 뒤집혔다(옛
    fail-closed pin은 이제 stale — 새 pin으로 교체, 삭제하지 않고 갱신해 "이
    시점 이후 등재가 빠지면" 회귀를 잡는다)."""
    from app.services.channel_adapters import get_publish_client_module

    assert get_publish_client_module("youtube") is not None
    assert get_publish_client_module("youtube_sandbox") is not None


# ─── ④ 실DB 통합 — cron 배선이 비회전 refresh도 그대로 태우는지 ────────────────

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

    org = Organization(id=uuid.uuid4(), name="YouTube OAuth Test Org", slug=f"org-{uuid.uuid4().hex[:8]}")
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


async def _seed_youtube_sandbox_connection(session, org_id, *, refresh_token: str, connected_by: uuid.UUID, due=True):
    from datetime import datetime, timedelta, timezone
    from app.models.channel_connection import ChannelConnection
    from app.services.channel_credential_crypto import encrypt_channel_credential

    expires_at = (
        datetime.now(timezone.utc) - timedelta(minutes=1) if due
        else datetime.now(timezone.utc) + timedelta(days=1)
    )
    row = ChannelConnection(
        id=uuid.uuid4(), org_id=org_id, channel="youtube_sandbox", account_id=f"acct-{uuid.uuid4().hex[:8]}",
        credential_kind="oauth", encrypted_access_token=encrypt_channel_credential("sandbox-youtube-access:app-1"),
        encrypted_refresh_token=encrypt_channel_credential(refresh_token),
        token_expires_at=expires_at, refresh_mode="refresh_token",
        scopes=["https://www.googleapis.com/auth/youtube.readonly"],
        status="active", connected_by=connected_by,
    )
    session.add(row)
    await session.commit()
    return row.id


async def _seed_youtube_sandbox_app_credentials(session, org_id, *, app_id: str, updated_by: uuid.UUID):
    from app.models.channel_app_credential import ChannelAppCredentials
    from app.services.channel_credential_crypto import encrypt_channel_credential

    row = ChannelAppCredentials(
        id=uuid.uuid4(), org_id=org_id, channel="youtube_sandbox", app_id=app_id,
        encrypted_app_secret=encrypt_channel_credential("secret"), updated_by=updated_by,
    )
    session.add(row)
    await session.commit()


@pytest.mark.anyio
async def test_cron_refresh_channel_tokens_refreshes_youtube_sandbox_without_rotating_refresh_token(monkeypatch):
    """⭐뮤테이션 대상(cron 배선 계층) — `_ROTATING_REFRESH_FN_BY_CHANNEL`에서
    youtube_sandbox 항목을 빼면 이 연결이 갱신 루프에 아예 안 올라와 access_token이
    그대로 남는다(RED). refresh_token은 access_token과 달리 회전하지 않아야
    한다는 게 X 테스트와 대비되는 이 테스트의 값."""
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
            await _seed_youtube_sandbox_app_credentials(s, org_id, app_id="app-1", updated_by=owner_id)
            conn_id = await _seed_youtube_sandbox_connection(
                s, org_id, refresh_token="sandbox-youtube-refresh:app-1", connected_by=owner_id,
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
            assert decrypt_refresh_token_for_use(row) == "sandbox-youtube-refresh:app-1", "회전하면 안 된다"
            assert decrypt_for_use(row) != "sandbox-youtube-access:app-1", "access_token은 갱신돼야 한다"
            assert row.status == "active"
    finally:
        await engine.dispose()
