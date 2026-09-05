"""story #3523(카디르 QA #3873 실측 발견, PO 確定 2026-09-06) — 범용 채널 샌드박스
연결 엔드포인트(`POST /{org}/channel-connections/{channel}/sandbox`). story 5b27b32f
(`/sandbox`)와 #3320 조각①(`/instagram-sandbox`)이 채널마다 라우트+하드코딩 문자열을
복제하던 것을 수렴한다 — 판정 로직은 channel_connections.py::
_create_channel_sandbox_connection 참조.

이 파일은 그 새 로직 자체(fail-closed 판정 3갈래 + 하위호환 위임 두 라우트와의
계약 동치)만 커버한다. owner/admin/member/agent 권한 매트릭스는
test_5b27b32f_sandbox_channel.py가 이미 촘촘히 덮으므로 여기서 반복하지 않는다."""
from __future__ import annotations

import os
import uuid

import pytest

from tests.test_3373_channel_connections import (
    _seed_agent, _seed_human, _seed_org, _session_factory, _client_for, _setup_org_scoped_app,
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


@pytest.fixture(autouse=True)
def _enable_sandbox_adapters(monkeypatch):
    """test_5b27b32f_sandbox_channel.py::_enable_sandbox_adapter와 동형 — dict 직접
    주입(SANDBOX_CHANNEL_ENABLED env 파싱 자체는 그 파일의 subprocess 테스트가 이미
    독립 검증). "sandbox"·"instagram_sandbox" 둘 다 실 channel_adapters.py 값 그대로
    복제(이 파일이 검증하는 건 라우팅/판정이지 어댑터 필드 값 자체가 아니다)."""
    import app.services.channel_adapters as adapters_mod

    monkeypatch.setitem(adapters_mod.CHANNEL_ADAPTERS, "sandbox", adapters_mod.ChannelAdapterConfig(
        authorize_url="", token_url="", scope="sandbox_publish,sandbox_delete",
        refresh_mode="manual", credential_kind="none", display_name="Sandbox", max_text_length=500,
        utm_source="sandbox", utm_medium="test",
    ))
    monkeypatch.setitem(adapters_mod.CHANNEL_ADAPTERS, "instagram_sandbox", adapters_mod.ChannelAdapterConfig(
        authorize_url="", token_url="", scope="sandbox_publish,sandbox_delete",
        refresh_mode="manual", credential_kind="none", display_name="Instagram Sandbox", max_text_length=2200,
        utm_source="instagram_sandbox", utm_medium="test",
    ))
    yield


async def _owner_client(app, Session, org_id):
    human_id = None
    async with Session() as s:
        human_id = await _seed_human(s, org_id, role="owner")
    _setup_org_scoped_app(app, Session, org_id, user_id=human_id)
    return _client_for(app)


@pytest.mark.anyio
async def test_generic_route_creates_sandbox_connection_identically_to_legacy_route():
    """channel="sandbox"로 신규 범용 라우트를 부르면 구 /sandbox 라우트와 동일한
    channel·credential_kind로 행이 생긴다(위임 계약 동치)."""
    from app.main import app

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org_id, _ = await _seed_org(s)
        async with await _owner_client(app, Session, org_id) as client:
            resp = await client.post(f"/api/v2/organizations/{org_id}/channel-connections/sandbox/sandbox")
        assert resp.status_code == 201, resp.text
        body = resp.json()
        assert body["channel"] == "sandbox"
        assert body["credential_kind"] == "none"
        assert body["account_label"] == "Sandbox"
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()


@pytest.mark.anyio
async def test_generic_route_creates_instagram_sandbox_connection():
    from app.main import app

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org_id, _ = await _seed_org(s)
        async with await _owner_client(app, Session, org_id) as client:
            resp = await client.post(f"/api/v2/organizations/{org_id}/channel-connections/instagram_sandbox/sandbox")
        assert resp.status_code == 201, resp.text
        body = resp.json()
        assert body["channel"] == "instagram_sandbox"
        assert body["account_label"] == "Instagram Sandbox"
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()


@pytest.mark.anyio
async def test_generic_route_unregistered_channel_returns_404():
    """미등록 채널(어댑터 자체가 없음)은 404 CHANNEL_SANDBOX_DISABLED — 기존
    /sandbox·/instagram-sandbox 라우트의 "어댑터 없음" 응답과 동형."""
    from app.main import app

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org_id, _ = await _seed_org(s)
        async with await _owner_client(app, Session, org_id) as client:
            resp = await client.post(f"/api/v2/organizations/{org_id}/channel-connections/nonexistent-channel/sandbox")
        assert resp.status_code == 404, resp.text
        assert resp.json()["error"]["code"] == "CHANNEL_SANDBOX_DISABLED"
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()


@pytest.mark.anyio
async def test_generic_route_oauth_channel_returns_422_not_ok():
    """channel="threads"(실 OAuth 자격이 필요한 채널)를 이 엔드포인트에 부르면
    422 CHANNEL_SANDBOX_UNSUPPORTED — 조용히 가짜 access_token을 심는 오분기를
    fail-closed로 막는다(이 스토리의 발단이 된 결함 클래스 자체의 회귀 가드)."""
    from app.main import app

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org_id, _ = await _seed_org(s)
        async with await _owner_client(app, Session, org_id) as client:
            resp = await client.post(f"/api/v2/organizations/{org_id}/channel-connections/threads/sandbox")
        assert resp.status_code == 422, resp.text
        assert resp.json()["error"]["code"] == "CHANNEL_SANDBOX_UNSUPPORTED"
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()


@pytest.mark.anyio
async def test_generic_route_hosted_site_returns_422():
    """hosted_site는 credential_kind="none"이지만 requires_connection=False(연결
    자체가 불요) — credential_kind만 보면 sandbox와 같은 값이라 이 가드
    (requires_connection도 함께 검사)가 없으면 조용히 통과했을 자리."""
    from app.main import app

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org_id, _ = await _seed_org(s)
        async with await _owner_client(app, Session, org_id) as client:
            resp = await client.post(f"/api/v2/organizations/{org_id}/channel-connections/hosted_site/sandbox")
        assert resp.status_code == 422, resp.text
        assert resp.json()["error"]["code"] == "CHANNEL_SANDBOX_UNSUPPORTED"
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()


@pytest.mark.anyio
async def test_legacy_then_generic_route_upsert_same_row_not_duplicate():
    """구 /instagram-sandbox로 먼저 연결을 만들고 신규 범용 라우트를 같은 채널로
    다시 부르면, 새 행이 아니라 같은 (org, channel, account_id) 행이 upsert된다
    (account_id의 `_`→`-` 치환 규칙이 기존 하드코딩 문자열과 정확히 일치해야
    성립 — 이 규칙이 틀리면 여기서 새 UUID가 나와 실패한다)."""
    from app.main import app

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org_id, _ = await _seed_org(s)
        async with await _owner_client(app, Session, org_id) as client:
            r1 = await client.post(f"/api/v2/organizations/{org_id}/channel-connections/instagram-sandbox")
            assert r1.status_code == 201, r1.text
            id1 = r1.json()["id"]

            r2 = await client.post(f"/api/v2/organizations/{org_id}/channel-connections/instagram_sandbox/sandbox")
            assert r2.status_code == 201, r2.text
            id2 = r2.json()["id"]

        assert id1 == id2, "구 라우트와 신규 범용 라우트가 서로 다른 행을 만들면 안 된다(멱등 upsert 위반)"
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()


@pytest.mark.anyio
async def test_member_forbidden_on_generic_route():
    """권한 매트릭스 자체는 test_5b27b32f_sandbox_channel.py가 촘촘히 덮지만, 신규
    라우트가 같은 _require_owner_or_admin 가드를 실제로 타는지 한 번은 직접 확인."""
    from app.main import app

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org_id, _ = await _seed_org(s)
            member_id = await _seed_human(s, org_id, role="member")
        _setup_org_scoped_app(app, Session, org_id, user_id=member_id)
        async with _client_for(app) as client:
            resp = await client.post(f"/api/v2/organizations/{org_id}/channel-connections/sandbox/sandbox")
        assert resp.status_code == 403, resp.text
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()
