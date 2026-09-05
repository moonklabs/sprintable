"""story #3523(PO 실측(3523 그라운딩·page.tsx:239)·確定 2026-09-06) — 범용 채널 샌드박스
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
@pytest.mark.parametrize(
    "channel,legacy_account_id",
    [("sandbox", "sandbox-{org_id}"), ("instagram_sandbox", "instagram-sandbox-{org_id}")],
)
async def test_generic_route_upserts_preexisting_legacy_row_not_duplicate(channel, legacy_account_id):
    """카디르 QA(뮤테이션) 지적 — 이전 버전은 구 라우트·신규 라우트 둘 다 같은
    헬퍼(_create_channel_sandbox_connection)를 태워 account_id 치환(`_`→`-`)을
    빼도 초록이 나오는 동어반복이었다(둘 다 같은 코드로 계산하니 항상 일치).

    진짜 위험은 "배포 前 코드가 이미 만들어 둔 기존 행"(리터럴 `sandbox-{org}`·
    `instagram-sandbox-{org}`)과 새 규칙이 안 맞아 dev에서 행이 갈라지는 것이다
    — 그래서 이 테스트는 헬퍼를 거치지 않고 `upsert_channel_connection`을 직접
    불러 그 리터럴 account_id로 기존 행을 먼저 심은 뒤, 범용 라우트를 호출해
    같은 id가 돌아오는지 확인한다(치환 규칙을 빼면 여기서 새 UUID가 나와야
    RED)."""
    from app.main import app
    from app.services.channel_adapters import get_channel_adapter
    from app.services.channel_connection import upsert_channel_connection

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org_id, _ = await _seed_org(s)
            owner_id = await _seed_human(s, org_id, role="owner")
            adapter = get_channel_adapter(channel)
            legacy_row = await upsert_channel_connection(
                s, org_id=org_id, channel=channel, account_id=legacy_account_id.format(org_id=org_id),
                account_label=adapter.display_name, credential_kind=adapter.credential_kind,
                access_token="sandbox-dummy-access-token", refresh_token=None,
                token_expires_at=None, refresh_mode=adapter.refresh_mode,
                scopes=adapter.scope.split(","), connected_by=owner_id,
            )
            legacy_id = str(legacy_row.id)

        _setup_org_scoped_app(app, Session, org_id, user_id=owner_id)
        async with _client_for(app) as client:
            resp = await client.post(f"/api/v2/organizations/{org_id}/channel-connections/{channel}/sandbox")
        assert resp.status_code == 201, resp.text
        assert resp.json()["id"] == legacy_id, (
            "범용 라우트의 account_id 치환 규칙이 배포 前 리터럴 문자열과 안 맞으면 "
            "새 행이 생겨 여기서 실패한다(dev 기존 연결이 갈라지는 실사고 재현)"
        )
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
