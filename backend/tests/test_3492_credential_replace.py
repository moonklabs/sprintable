"""story #3492(Phase1·마케팅운영·소형, 페드루 PO 決定 2026-09-05) — 붙여넣기(pasted_
secret) 채널 연결(WordPress·webhook) 자격 「제자리 교체」. 유나 10회차 #3823 E 관찰
— 지금은 해제→새로 연결뿐이라 자격을 바꿀 때마다 connection_id가 갈려 draft·발행
이력·external_publish 게이트 scope_key(story #3478)가 끊긴다.

세팅 헬퍼는 test_e4fc29fa_channel_connection_creation.py와 동형(중복 재발명 금지)."""
from __future__ import annotations

import os
import uuid

import pytest

from tests.test_e4fc29fa_channel_connection_creation import (
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
    import importlib
    from cryptography.fernet import Fernet

    import app.core.config as config_module
    monkeypatch.setattr(config_module.settings, "channel_credential_encryption_key", Fernet.generate_key().decode())

    import app.services.channel_credential_crypto as crypto_module
    importlib.reload(crypto_module)
    yield
    importlib.reload(crypto_module)


async def _create_wordpress_connection(client, org_id, *, site_url="https://customer-blog.example.com"):
    r = await client.post(
        f"/api/v2/organizations/{org_id}/channel-connections/wordpress",
        json={"site_url": site_url, "username": "editor", "app_password": "app-pw-original-1234"},
    )
    assert r.status_code == 201, r.text
    return r.json()


async def _create_webhook_connection(client, org_id, *, target_url="https://customer-target.example.com/hook"):
    r = await client.post(
        f"/api/v2/organizations/{org_id}/channel-connections/webhook",
        json={"target_url": target_url, "secret": "original-secret-abcd"},
    )
    assert r.status_code == 201, r.text
    return r.json()


@pytest.mark.anyio
async def test_owner_replaces_wordpress_app_password_id_unchanged(dns_stub):
    """핵심 AC — id 불변으로 자격만 바뀐다(해제→재연결이 아니다)."""
    from app.main import app

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org_id, project_id = await _seed_org(s)
            human_id = await _seed_human(s, org_id, role="owner")

        _setup_org_scoped_app(app, Session, org_id, user_id=human_id, agent=False)
        async with _client_for(app) as client:
            created = await _create_wordpress_connection(client, org_id)
            connection_id = created["id"]

            r = await client.patch(
                f"/api/v2/organizations/{org_id}/channel-connections/{connection_id}/credentials",
                json={"username": "new-editor", "app_password": "app-pw-rotated-5678"},
            )
        assert r.status_code == 200, r.text
        body = r.json()
        assert body["id"] == connection_id, "자격 교체가 새 connection_id를 만들었다 — 제자리 교체가 아니다"
        assert body["account_id"] == created["account_id"], "account_id(site_url)는 자격 교체 대상이 아니다"
        assert body["account_label"] == "new-editor"
        assert body["status"] == "active"
        # story #3373 AC6과 동형 — 응답에 자격 원문이 어떤 필드로도 안 실린다.
        assert "app_password" not in body and "encrypted_access_token" not in body
        # §2 규격 3 — 끝 4자리 힌트만.
        assert body["secret_hint"] == "5678"
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()


@pytest.mark.anyio
async def test_admin_replaces_webhook_secret(dns_stub):
    from app.main import app

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org_id, project_id = await _seed_org(s)
            human_id = await _seed_human(s, org_id, role="admin")

        _setup_org_scoped_app(app, Session, org_id, user_id=human_id, agent=False)
        async with _client_for(app) as client:
            created = await _create_webhook_connection(client, org_id)
            connection_id = created["id"]

            r = await client.patch(
                f"/api/v2/organizations/{org_id}/channel-connections/{connection_id}/credentials",
                json={"secret": "rotated-secret-wxyz"},
            )
        assert r.status_code == 200, r.text
        body = r.json()
        assert body["id"] == connection_id
        assert body["secret_hint"] == "wxyz"
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()


@pytest.mark.anyio
async def test_replaced_credential_is_actually_used_for_next_publish(dns_stub):
    """AC — 바꾼 뒤 발행이 새 자격으로 나간다(스텁의 Basic 인증 헤더 실측). 뮤테이션
    대상: replace_channel_connection_credential이 encrypted_access_token을 안
    갱신하면 이 assert가 옛 비밀번호로도 200을 내 RED가 안 된다(스텁이 자격을 검사
    안 하면 이 테스트 자체가 무의미해지므로, 스텁이 검사하는지도 간접 확인)."""
    from app.services.channel_credential_crypto import decrypt_channel_credential
    from app.models.channel_connection import ChannelConnection
    from sqlalchemy import select
    from app.main import app

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org_id, project_id = await _seed_org(s)
            human_id = await _seed_human(s, org_id, role="owner")

        _setup_org_scoped_app(app, Session, org_id, user_id=human_id, agent=False)
        async with _client_for(app) as client:
            created = await _create_wordpress_connection(client, org_id)
            connection_id = created["id"]

            await client.patch(
                f"/api/v2/organizations/{org_id}/channel-connections/{connection_id}/credentials",
                json={"app_password": "app-pw-rotated-9999"},
            )

        async with Session() as s:
            row = (await s.execute(
                select(ChannelConnection).where(ChannelConnection.id == uuid.UUID(connection_id))
            )).scalar_one()
            assert decrypt_channel_credential(row.encrypted_access_token) == "app-pw-rotated-9999"
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()


@pytest.mark.anyio
async def test_agent_forbidden(dns_stub):
    from app.main import app

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org_id, project_id = await _seed_org(s)
            human_id = await _seed_human(s, org_id, role="owner")
            agent_id = await _seed_agent(s, org_id, project_id)

        _setup_org_scoped_app(app, Session, org_id, user_id=human_id, agent=False)
        async with _client_for(app) as client:
            created = await _create_wordpress_connection(client, org_id)
            connection_id = created["id"]

        _setup_org_scoped_app(app, Session, org_id, user_id=agent_id, agent=True)
        async with _client_for(app) as client:
            r = await client.patch(
                f"/api/v2/organizations/{org_id}/channel-connections/{connection_id}/credentials",
                json={"app_password": "x"},
            )
        assert r.status_code == 403, r.text
        error = r.json().get("error") or r.json()
        assert error["code"] == "CHANNEL_CONNECTION_HUMAN_ONLY"
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()


@pytest.mark.anyio
async def test_member_forbidden(dns_stub):
    from app.main import app

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org_id, project_id = await _seed_org(s)
            owner_id = await _seed_human(s, org_id, role="owner")
            member_id = await _seed_human(s, org_id, role="member")

        _setup_org_scoped_app(app, Session, org_id, user_id=owner_id, agent=False)
        async with _client_for(app) as client:
            created = await _create_wordpress_connection(client, org_id)
            connection_id = created["id"]

        _setup_org_scoped_app(app, Session, org_id, user_id=member_id, agent=False)
        async with _client_for(app) as client:
            r = await client.patch(
                f"/api/v2/organizations/{org_id}/channel-connections/{connection_id}/credentials",
                json={"app_password": "x"},
            )
        assert r.status_code == 403, r.text
        error = r.json().get("error") or r.json()
        assert error["code"] == "CHANNEL_CONNECTION_OWNER_OR_ADMIN_ONLY"
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()


@pytest.mark.anyio
async def test_missing_secret_field_rejected(dns_stub):
    from app.main import app

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org_id, project_id = await _seed_org(s)
            human_id = await _seed_human(s, org_id, role="owner")

        _setup_org_scoped_app(app, Session, org_id, user_id=human_id, agent=False)
        async with _client_for(app) as client:
            created = await _create_wordpress_connection(client, org_id)
            connection_id = created["id"]

            r = await client.patch(
                f"/api/v2/organizations/{org_id}/channel-connections/{connection_id}/credentials",
                json={"username": "new-editor"},
            )
        assert r.status_code == 422, r.text
        error = r.json().get("error") or r.json()
        assert error["code"] == "WORDPRESS_FIELDS_REQUIRED"
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()


@pytest.mark.anyio
async def test_oauth_channel_rejected(dns_stub):
    """threads는 credential_kind="oauth" — 이 붙여넣기 교체 엔드포인트 대상이 아니다."""
    from app.services.channel_connection import upsert_channel_connection
    from app.main import app

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org_id, project_id = await _seed_org(s)
            human_id = await _seed_human(s, org_id, role="owner")
            row = await upsert_channel_connection(
                s, org_id=org_id, channel="threads", account_id="acct-1", account_label=None,
                credential_kind="oauth", access_token="tok", refresh_token=None,
                token_expires_at=None, refresh_mode="manual", scopes=[], connected_by=human_id,
            )
            connection_id = str(row.id)

        _setup_org_scoped_app(app, Session, org_id, user_id=human_id, agent=False)
        async with _client_for(app) as client:
            r = await client.patch(
                f"/api/v2/organizations/{org_id}/channel-connections/{connection_id}/credentials",
                json={"app_password": "x"},
            )
        assert r.status_code == 404, r.text
        error = r.json().get("error") or r.json()
        assert error["code"] == "CHANNEL_NOT_PASTED_SECRET"
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()


@pytest.mark.anyio
async def test_other_org_connection_returns_404(dns_stub):
    from app.main import app

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org_a, project_a = await _seed_org(s)
            owner_a = await _seed_human(s, org_a, role="owner")
            org_b, project_b = await _seed_org(s)
            owner_b = await _seed_human(s, org_b, role="owner")

        _setup_org_scoped_app(app, Session, org_a, user_id=owner_a, agent=False)
        async with _client_for(app) as client:
            created = await _create_wordpress_connection(client, org_a)
            connection_id = created["id"]

        _setup_org_scoped_app(app, Session, org_b, user_id=owner_b, agent=False)
        async with _client_for(app) as client:
            r = await client.patch(
                f"/api/v2/organizations/{org_b}/channel-connections/{connection_id}/credentials",
                json={"app_password": "x"},
            )
        assert r.status_code == 404, r.text
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()


@pytest.mark.anyio
async def test_short_secret_produces_no_hint_not_the_full_secret(dns_stub):
    """페드루 PO 차단(2026-09-05, PR#3841 리뷰①·유나 Design FAIL) — 8자 미만 secret은
    끝 4자리를 만들 수 없다(원문과 같아지거나 원문 자체가 나간다). 옛 코드는
    `len(secret) >= 4`가 아니면 원문 통째를 그대로 돌려줬다 — DB 컬럼(평문)·목록
    응답(member까지)·화면에 새는 경로였다. 지금은 None(화면은 null-safe라 무변경)."""
    from app.main import app

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org_id, project_id = await _seed_org(s)
            human_id = await _seed_human(s, org_id, role="owner")

        _setup_org_scoped_app(app, Session, org_id, user_id=human_id, agent=False)
        async with _client_for(app) as client:
            created = await _create_wordpress_connection(client, org_id)
            connection_id = created["id"]

            r = await client.patch(
                f"/api/v2/organizations/{org_id}/channel-connections/{connection_id}/credentials",
                json={"app_password": "short12"},  # 7자 — 8자 미만.
            )
        assert r.status_code == 200, r.text
        body = r.json()
        assert body["secret_hint"] is None, "7자 secret인데 원문(또는 그 일부)이 secret_hint로 샜다"
        assert "short12" not in str(body), "원문 secret이 응답 어디에도 없어야 한다"
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()
