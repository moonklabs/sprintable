"""story #3806(Phase3·3-2 PR1, 페드루 PO 確定 2026-09-11) — Meta Ads 광고 계정 연결.
`test_3547_facebook_page_connection.py`(story #3547/#3613)와 동형 세팅 헬퍼 재사용
(중복 재발명 0) — 이 파일은 그 파일의 정확한 계약 사본이 아니라 **진짜 차이가
있는 자리만** 새로 검증한다: 계정별 토큰이 없다(장기 유저 토큰 하나로 select까지
재사용) · account_status/disable_reason 원값 투과 · review-rejected가 목록 조회
자체를 예외로 죽인다(0개 반환이 아니라).

ads_sandbox_oauth.py도 facebook_sandbox_oauth.py와 동형으로 실 HTTP 없이 인프로세스
결정적으로 답한다 — authorize→callback→select 라우터 코드를 그대로 태운다."""
from __future__ import annotations

import os
import uuid
from datetime import datetime, timezone

import pytest

from tests.test_3373_channel_connections_auth import (
    _seed_org, _seed_human, _session_factory, _client_for, _setup_org_scoped_app,
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


async def _register_ads_sandbox_app_credentials(session, *, org_id, updated_by, app_id="sandbox-app-id"):
    """ads_sandbox도 facebook_sandbox와 동형 이유로 platform fallback이 없다(org가
    직접 등록해야 authorize가 진입)."""
    from app.services.channel_app_credentials import upsert_channel_app_credentials

    return await upsert_channel_app_credentials(
        session, org_id=org_id, channel="ads_sandbox", app_id=app_id, app_secret="sandbox-secret",
        updated_by=updated_by,
    )


async def _authorize_and_callback(client, org_id: str, *, channel="ads_sandbox", code="auth-code"):
    r_auth = await client.post(f"/api/v2/organizations/{org_id}/channel-connections/{channel}/authorize")
    assert r_auth.status_code == 200, r_auth.text
    state = r_auth.json()["state"]
    return await client.post(
        f"/api/v2/organizations/{org_id}/channel-connections/{channel}/callback",
        json={"code": code, "state": state},
    )


# ─── 어댑터 등재 ──────────────────────────────────────────────────────────────


def test_meta_ads_and_ads_sandbox_registered_with_ads_kind():
    from app.services.channel_adapters import CHANNEL_ADAPTERS

    assert CHANNEL_ADAPTERS["meta_ads"].kind == "ads"
    assert CHANNEL_ADAPTERS["ads_sandbox"].kind == "ads"
    assert CHANNEL_ADAPTERS["meta_ads"].credential_kind == "oauth"
    assert CHANNEL_ADAPTERS["ads_sandbox"].credential_kind == "oauth"
    # 콘텐츠 필드 전부 미선언(그라운딩 — 이 채널은 콘텐츠를 만들지 않는다).
    assert CHANNEL_ADAPTERS["meta_ads"].image_max_count == 0
    assert CHANNEL_ADAPTERS["meta_ads"].max_text_length == 0


# ─── ads_sandbox_oauth.py 단위 — 계정 수·상태 마커 ────────────────────────────


@pytest.mark.anyio
async def test_ads_sandbox_list_ad_accounts_marker_branches():
    from app.services.ads_sandbox_oauth import list_ad_accounts

    zero = await list_ad_accounts(None, user_access_token="sandbox-meta-ads-user-token:app:accounts-0")
    one = await list_ad_accounts(None, user_access_token="sandbox-meta-ads-user-token:app:accounts-1")
    default_two = await list_ad_accounts(None, user_access_token="sandbox-meta-ads-user-token:app")
    unverified = await list_ad_accounts(None, user_access_token="sandbox-meta-ads-user-token:app:account-unverified")

    assert zero == []
    assert [a["account_id"] for a in one] == ["sandbox-ads-account-1"]
    assert [a["account_id"] for a in default_two] == ["sandbox-ads-account-1", "sandbox-ads-account-2"]
    assert default_two[0]["name"] == "Sandbox Ads Account 1"
    assert default_two[1]["name"] == "Sandbox Ads Account 2"
    # account_status 원값 투과 — 1(ACTIVE) 기본.
    assert one[0]["account_status"] == 1
    # 미인증 마커 — 7(PENDING_RISK_REVIEW, Meta 공식 enum), 계정은 여전히 1개 반환.
    assert len(unverified) == 1
    assert unverified[0]["account_status"] == 7


@pytest.mark.anyio
async def test_ads_sandbox_review_rejected_marker_raises_not_empty_list():
    """review-rejected는 «계정 0개»(빈 목록)가 아니라 목록 조회 자체가 실패한다 —
    「이 앱 자격이 광고 API 접근을 아예 못 받음」과 「계정을 하나도 못 찾음」은
    다른 사실이다(0개로 뭉치면 콜백이 CHANNEL_META_ADS_NO_ACCOUNTS_AVAILABLE로
    오분류해 실제 원인 — 앱 심사 거부 — 이 사람에게 안 닿는다)."""
    from app.services.ads_sandbox_oauth import list_ad_accounts
    from app.services.meta_ads_oauth import MetaAdsOAuthError

    with pytest.raises(MetaAdsOAuthError) as exc_info:
        await list_ad_accounts(None, user_access_token="sandbox-meta-ads-user-token:app:review-rejected")
    assert exc_info.value.code == "META_ADS_ACCOUNT_REVIEW_REJECTED"


# ─── 콜백 3갈래(0/1/2+) — 실 authorize→callback 라우터 코드, HTTP 왕복 ────────


@pytest.mark.anyio
async def test_callback_zero_accounts_returns_422_no_pending_row():
    from app.main import app
    from app.models.channel_oauth_pending_selection import ChannelOAuthPendingSelection
    from sqlalchemy import select

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org_id, _ = await _seed_org(s)
            owner_id = await _seed_human(s, org_id, role="owner")
            await _register_ads_sandbox_app_credentials(s, org_id=org_id, updated_by=owner_id, app_id="app:accounts-0")
        _setup_org_scoped_app(app, Session, org_id, user_id=owner_id)

        async with _client_for(app) as client:
            r = await _authorize_and_callback(client, org_id)
        assert r.status_code == 422, r.text
        assert r.json()["error"]["code"] == "CHANNEL_META_ADS_NO_ACCOUNTS_AVAILABLE"

        async with Session() as s:
            rows = (await s.execute(select(ChannelOAuthPendingSelection))).scalars().all()
            assert rows == []
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()


@pytest.mark.anyio
async def test_callback_review_rejected_returns_400_not_422():
    """META_ADS_ACCOUNT_REVIEW_REJECTED는 MetaAdsOAuthError로 전파돼 400(다른
    OAuth 교환 실패류와 동형 — no-accounts의 422와 다른 축, 콜백 코드에서 두
    except 경로가 다른 status를 내는 게 의도다)."""
    from app.main import app

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org_id, _ = await _seed_org(s)
            owner_id = await _seed_human(s, org_id, role="owner")
            await _register_ads_sandbox_app_credentials(
                s, org_id=org_id, updated_by=owner_id, app_id="app:review-rejected",
            )
        _setup_org_scoped_app(app, Session, org_id, user_id=owner_id)

        async with _client_for(app) as client:
            r = await _authorize_and_callback(client, org_id)
        assert r.status_code == 400, r.text
        assert r.json()["error"]["code"] == "META_ADS_ACCOUNT_REVIEW_REJECTED"
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()


@pytest.mark.anyio
async def test_callback_one_account_connects_immediately_no_pending_row():
    from app.main import app
    from app.models.channel_connection import ChannelConnection
    from app.models.channel_oauth_pending_selection import ChannelOAuthPendingSelection
    from sqlalchemy import select

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org_id, _ = await _seed_org(s)
            owner_id = await _seed_human(s, org_id, role="owner")
            await _register_ads_sandbox_app_credentials(s, org_id=org_id, updated_by=owner_id, app_id="app:accounts-1")
        _setup_org_scoped_app(app, Session, org_id, user_id=owner_id)

        async with _client_for(app) as client:
            r = await _authorize_and_callback(client, org_id)
        assert r.status_code == 200, r.text
        body = r.json()
        assert body["kind"] == "connected"
        assert body["account_id"] == "sandbox-ads-account-1"
        assert body["account_label"] == "Sandbox Ads Account 1"

        async with Session() as s:
            conn = (await s.execute(select(ChannelConnection).where(ChannelConnection.org_id == org_id))).scalar_one()
            assert conn.encrypted_access_token is not None
            pending_rows = (await s.execute(select(ChannelOAuthPendingSelection))).scalars().all()
            assert pending_rows == []
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()


@pytest.mark.anyio
async def test_callback_two_accounts_returns_pending_selection_no_connection_row():
    from app.main import app
    from app.models.channel_connection import ChannelConnection
    from sqlalchemy import select

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org_id, _ = await _seed_org(s)
            owner_id = await _seed_human(s, org_id, role="owner")
            await _register_ads_sandbox_app_credentials(s, org_id=org_id, updated_by=owner_id)
        _setup_org_scoped_app(app, Session, org_id, user_id=owner_id)

        async with _client_for(app) as client:
            r = await _authorize_and_callback(client, org_id)
        assert r.status_code == 200, r.text
        body = r.json()
        assert body["kind"] == "pending_selection"
        assert {c["account_id"] for c in body["candidates"]} == {"sandbox-ads-account-1", "sandbox-ads-account-2"}
        assert body["pending_id"]
        assert body["expires_at"]

        async with Session() as s:
            conns = (await s.execute(select(ChannelConnection).where(ChannelConnection.org_id == org_id))).scalars().all()
            assert conns == [], "2개+ 갈래는 콜백에서 연결 행을 만들면 안 된다(select가 만든다)"
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()


# ─── select — 성공(토큰 재사용, /me/adaccounts 재호출 없음) + 실패코드 ────────


async def _setup_pending_two_accounts(app, Session, *, org_id, owner_id):
    async with Session() as s:
        await _register_ads_sandbox_app_credentials(s, org_id=org_id, updated_by=owner_id)
    _setup_org_scoped_app(app, Session, org_id, user_id=owner_id)
    async with _client_for(app) as client:
        r = await _authorize_and_callback(client, org_id)
    assert r.status_code == 200, r.text
    return r.json()["pending_id"]


@pytest.mark.anyio
async def test_select_success_creates_connection_and_deletes_pending_row():
    from app.main import app
    from app.models.channel_oauth_pending_selection import ChannelOAuthPendingSelection
    from sqlalchemy import select

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org_id, _ = await _seed_org(s)
            owner_id = await _seed_human(s, org_id, role="owner")
        pending_id = await _setup_pending_two_accounts(app, Session, org_id=org_id, owner_id=owner_id)

        async with _client_for(app) as client:
            r = await client.post(
                f"/api/v2/organizations/{org_id}/channel-connections/meta-ads/select",
                json={"pending_id": pending_id, "account_id": "sandbox-ads-account-2"},
            )
        assert r.status_code == 200, r.text
        body = r.json()
        assert body["kind"] == "connected"
        assert body["account_id"] == "sandbox-ads-account-2"
        assert body["account_label"] == "Sandbox Ads Account 2"

        async with Session() as s:
            row = (await s.execute(
                select(ChannelOAuthPendingSelection).where(ChannelOAuthPendingSelection.id == uuid.UUID(pending_id))
            )).scalar_one_or_none()
            assert row is None, "성공했는데 pending 행이 안 지워졌다"
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()


@pytest.mark.anyio
async def test_select_unknown_account_id_returns_400():
    from app.main import app

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org_id, _ = await _seed_org(s)
            owner_id = await _seed_human(s, org_id, role="owner")
        pending_id = await _setup_pending_two_accounts(app, Session, org_id=org_id, owner_id=owner_id)

        async with _client_for(app) as client:
            r = await client.post(
                f"/api/v2/organizations/{org_id}/channel-connections/meta-ads/select",
                json={"pending_id": pending_id, "account_id": "not-a-real-account"},
            )
        assert r.status_code == 400, r.text
        assert r.json()["error"]["code"] == "CHANNEL_OAUTH_PENDING_SELECTION_INVALID_ACCOUNT"
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()


@pytest.mark.anyio
async def test_select_wrong_requester_returns_403():
    from app.main import app

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org_id, _ = await _seed_org(s)
            owner_id = await _seed_human(s, org_id, role="owner")
            other_owner_id = await _seed_human(s, org_id, role="owner")
        pending_id = await _setup_pending_two_accounts(app, Session, org_id=org_id, owner_id=owner_id)

        _setup_org_scoped_app(app, Session, org_id, user_id=other_owner_id)
        async with _client_for(app) as client:
            r = await client.post(
                f"/api/v2/organizations/{org_id}/channel-connections/meta-ads/select",
                json={"pending_id": pending_id, "account_id": "sandbox-ads-account-1"},
            )
        assert r.status_code == 403, r.text
        assert r.json()["error"]["code"] == "CHANNEL_OAUTH_PENDING_SELECTION_FORBIDDEN"
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()


@pytest.mark.anyio
async def test_select_expired_pending_returns_404_row_not_deleted():
    from app.main import app
    from app.models.channel_oauth_pending_selection import ChannelOAuthPendingSelection
    from sqlalchemy import select

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org_id, _ = await _seed_org(s)
            owner_id = await _seed_human(s, org_id, role="owner")
        pending_id = await _setup_pending_two_accounts(app, Session, org_id=org_id, owner_id=owner_id)

        async with Session() as s:
            row = (await s.execute(
                select(ChannelOAuthPendingSelection).where(ChannelOAuthPendingSelection.id == uuid.UUID(pending_id))
            )).scalar_one()
            row.expires_at = datetime.now(timezone.utc).replace(year=2020)
            s.add(row)
            await s.commit()

        async with _client_for(app) as client:
            r = await client.post(
                f"/api/v2/organizations/{org_id}/channel-connections/meta-ads/select",
                json={"pending_id": pending_id, "account_id": "sandbox-ads-account-1"},
            )
        assert r.status_code == 404, r.text
        assert r.json()["error"]["code"] == "CHANNEL_OAUTH_PENDING_SELECTION_EXPIRED"

        async with Session() as s:
            row = (await s.execute(
                select(ChannelOAuthPendingSelection).where(ChannelOAuthPendingSelection.id == uuid.UUID(pending_id))
            )).scalar_one_or_none()
            assert row is not None, "만료 실패 경로는 삭제 책임이 없다(스윕 몫) — 여기서 지우면 회귀"
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()


# ─── ads_sandbox는 credential_kind="oauth"라 범용 /sandbox 엔드포인트가 거부해야 함 ──


@pytest.mark.anyio
async def test_generic_sandbox_endpoint_rejects_ads_sandbox_422():
    """facebook_sandbox와 동형 가드(story #3523 판정 로직) — credential_kind가
    "none"이 아니면 범용 /sandbox 엔드포인트가 422로 막는다. ads_sandbox는 authorize
    →callback 진짜 라우터를 태워야 한다(위 테스트들)."""
    from app.main import app

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org_id, _ = await _seed_org(s)
            owner_id = await _seed_human(s, org_id, role="owner")
        _setup_org_scoped_app(app, Session, org_id, user_id=owner_id)

        async with _client_for(app) as client:
            r = await client.post(f"/api/v2/organizations/{org_id}/channel-connections/ads_sandbox/sandbox")
        assert r.status_code == 422, r.text
        assert r.json()["error"]["code"] == "CHANNEL_SANDBOX_UNSUPPORTED"
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()
