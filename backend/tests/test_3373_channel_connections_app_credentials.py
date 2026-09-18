"""story #3373(Phase1·마케팅운영, 선생님 확定 2026-09-03) — cron 자동 갱신(AC4)·토큰
평문 미노출 grep·조직별 채널 앱 자격(선생님 지적·페드루 PO 정정 2026-09-03 08:29Z)·
3단 우선순위(조직 등록→플랫폼 공용→미설정, 페드루 PO 확定 2026-09-03 08:40Z, 블루프린트
§8)·effective_source(페드루 PO 2026-09-03 11:19Z). story #3579(2026-09-06, 페드루 PO
確定) 후속으로 `test_3373_channel_connections.py`(31 테스트)에서 3-way 분할 — 원본
파일이 러너 정규화 60초 가드 경계대역(36~77s 관측)에 있어 러너가 조금만 느려져도 가드에
걸림. 세팅 헬퍼·픽스처는 `test_3373_channel_connections_auth.py`에서 그대로 재사용
(중복 재발명 0) — autouse 픽스처(`_dispose_global_engine_after_test`·
`_configure_secrets`)만 pytest 관례상 파일마다 재선언(import로는 전파 안 됨, story
#3562 전례와 동일).

이 파일 담당 — cron 갱신 성공/실패(AC4)·토큰 평문 미노출 grep(story 명시 QA 관점)·
조직별 앱 자격 설정/조회(owner만·agent/member 403)·3단 우선순위(조직 credentials →
플랫폼 fallback → 409)·effective_source(org/platform/none) 노출."""
from __future__ import annotations

import os
import uuid
from datetime import datetime, timedelta, timezone
from unittest.mock import AsyncMock, patch

import pytest

from tests.test_3373_channel_connections_auth import (
    _client_for,
    _seed_agent,
    _seed_human,
    _seed_org,
    _session_factory,
    _setup_org_scoped_app,
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


