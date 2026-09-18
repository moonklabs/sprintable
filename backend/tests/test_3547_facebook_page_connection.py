"""story #3547(Phase2·마케팅운영, 페드루 PO 確定 2026-09-06) — Facebook Page 연결
(BE PR1). threads/instagram(test_3373·test_3320)과 동형 세팅 헬퍼 재사용(중복
재발명 0). 세 갈래(0/1/2+ 페이지)·select 5실패코드·자가회수 스윕·「삭제는 성공에만」
뮤테이션이 이 파일의 척추.

facebook_sandbox_oauth.py는 실 HTTP 없이 인프로세스 결정적으로 답한다 — 그래서 이
파일의 대부분은 목 없이 진짜 authorize→callback→select 라우터 코드를 그대로 태운다
(페드루 PO 明示 — "같은 코드 경로·가짜 데이터" 철학을 시험 자체로 검증)."""
from __future__ import annotations

import os
import uuid
from datetime import datetime, timedelta, timezone
from unittest.mock import AsyncMock, patch

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


async def _register_facebook_sandbox_app_credentials(session, *, org_id, updated_by, app_id="sandbox-app-id"):
    """facebook_sandbox는 platform fallback이 없다(channel_app_credentials.py의
    _PLATFORM_SETTINGS_COLUMNS에 의도적으로 미등재 — org마다 다른 페이지-수 마커를
    고를 수 있어야 한다). org가 직접 등록해야 authorize가 진입한다."""
    from app.services.channel_app_credentials import upsert_channel_app_credentials

    return await upsert_channel_app_credentials(
        session, org_id=org_id, channel="facebook_sandbox", app_id=app_id, app_secret="sandbox-secret",
        updated_by=updated_by,
    )


async def _authorize_and_callback(client, org_id: str, *, channel="facebook_sandbox", code="auth-code"):
    r_auth = await client.post(f"/api/v2/organizations/{org_id}/channel-connections/{channel}/authorize")
    assert r_auth.status_code == 200, r_auth.text
    state = r_auth.json()["state"]
    return await client.post(
        f"/api/v2/organizations/{org_id}/channel-connections/{channel}/callback",
        json={"code": code, "state": state},
    )


# ─── 어댑터 dispatch(get_publish_client_module) ──────────────────────────────


def test_get_publish_client_module_dispatches_facebook_and_facebook_sandbox():
    from app.services.channel_adapters import get_publish_client_module
    import app.services.facebook_publish as facebook_publish
    import app.services.facebook_sandbox_publish as facebook_sandbox_publish

    assert get_publish_client_module("facebook") is facebook_publish
    assert get_publish_client_module("facebook_sandbox") is facebook_sandbox_publish


# ─── facebook_oauth.py 단위 ───────────────────────────────────────────────────


def test_facebook_build_authorize_url_never_sends_pkce_params():
    from app.services.facebook_oauth import build_authorize_url

    url = build_authorize_url(redirect_uri="https://x/callback", state="s", app_id="app-id")
    assert "code_challenge" not in url
    assert "client_id=app-id" in url
    assert url.startswith("https://www.facebook.com/v21.0/dialog/oauth?")


@pytest.mark.anyio
async def test_facebook_list_pages_normalizes_id_to_page_id_and_skips_incomplete_entries():
    from app.services.facebook_oauth import list_pages

    class _FakeResponse:
        status_code = 200
        def json(self):
            return {"data": [
                {"id": "111", "name": "Page A", "access_token": "tok-a"},
                {"id": "222", "name": "Page B"},  # access_token 없음 — 스킵.
            ]}

    class _FakeClient:
        async def get(self, url, *, params):
            return _FakeResponse()

    pages = await list_pages(_FakeClient(), user_access_token="user-token")
    assert pages == [{"page_id": "111", "name": "Page A", "access_token": "tok-a"}]


# ─── facebook_sandbox_oauth.py — 페이지 수 마커 ───────────────────────────────


@pytest.mark.anyio
async def test_facebook_sandbox_list_pages_marker_branches():
    from app.services.facebook_sandbox_oauth import list_pages

    zero = await list_pages(None, user_access_token="sandbox-fb-user-token:app:pages-0")
    one = await list_pages(None, user_access_token="sandbox-fb-user-token:app:pages-1")
    default_two = await list_pages(None, user_access_token="sandbox-fb-user-token:app")

    assert zero == []
    assert [p["page_id"] for p in one] == ["sandbox-page-1"]
    assert [p["page_id"] for p in default_two] == ["sandbox-page-1", "sandbox-page-2"]
    # 결정적 고정값(페드루 PO 明示) — 라이브 판정이 이름을 대조한다.
    assert default_two[0]["name"] == "Sandbox Page 1"
    assert default_two[1]["name"] == "Sandbox Page 2"


# ─── facebook_sandbox_oauth.py — story #3613(결함 2: 브라우저가 실제로 authorize
# URL을 방문했을 때 콜백에 닿는 경로가 없었다) ────────────────────────────────


def test_facebook_sandbox_build_authorize_url_redirects_straight_back_to_its_own_callback():
    """story #3613 — 원판은 `https://sandbox.local/...`(실존 안 함)을 냈다. 이제
    `redirect_uri`(=그 채널의 콜백 URL 그 자체)로 가짜 code+real state를 실어 곧장
    돌아간다 — 브라우저가 이 URL을 실제로 따라가면 곧바로 콜백 라우트에 닿는다
    (real Meta 없이도 같은 코드 경로, 새 엔드포인트 0)."""
    from app.services.facebook_sandbox_oauth import build_authorize_url
    from urllib.parse import urlparse, parse_qs

    redirect_uri = "https://dev-app.sprintable.ai/api/oauth-channel/callback/facebook_sandbox"
    url = build_authorize_url(redirect_uri=redirect_uri, state="signed-state-abc", app_id="app-id")

    parsed = urlparse(url)
    assert f"{parsed.scheme}://{parsed.netloc}{parsed.path}" == redirect_uri, (
        "브라우저가 authorize URL을 그대로 따라가면 이 채널의 콜백 라우트 자신에게 도착해야 한다"
    )
    qs = parse_qs(parsed.query)
    assert qs["state"] == ["signed-state-abc"], "state는 반드시 실물(BE가 서명 검증한다) — 지어내면 안 됨"
    assert qs["code"][0], "code는 exchange 단계에서 검증 없이 소비되므로 값 자체는 임의(비어있지만 않으면 됨)"


@pytest.mark.anyio
async def test_facebook_sandbox_authorize_url_is_navigable_back_into_the_real_callback_endpoint():
    """story #3613 — 결함 2의 종단 재현: authorize가 낸 url을 «파싱해서 code/state를
    꺼내» 실제 callback 엔드포인트에 그대로 태우면(브라우저가 그 URL을 따라갔을 때
    벌어질 일 그대로) 연결이 정상적으로 만들어진다 — 원판(`sandbox.local`)이었다면
    이 url 자체에서 code/state를 뽑아낼 수조차 없었다(도메인만 있고 쿼리에 code가
    아예 없었다)."""
    from app.main import app
    from urllib.parse import urlparse, parse_qs

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org_id, _ = await _seed_org(s)
            owner_id = await _seed_human(s, org_id, role="owner")
            await _register_facebook_sandbox_app_credentials(s, org_id=org_id, updated_by=owner_id, app_id="app:pages-1")
        _setup_org_scoped_app(app, Session, org_id, user_id=owner_id)

        async with _client_for(app) as client:
            r_auth = await client.post(f"/api/v2/organizations/{org_id}/channel-connections/facebook_sandbox/authorize")
            assert r_auth.status_code == 200, r_auth.text
            authorize_url = r_auth.json()["url"]

            parsed = urlparse(authorize_url)
            qs = parse_qs(parsed.query)
            code, state = qs["code"][0], qs["state"][0]

            r_cb = await client.post(
                f"/api/v2/organizations/{org_id}/channel-connections/facebook_sandbox/callback",
                json={"code": code, "state": state},
            )
            assert r_cb.status_code == 200, r_cb.text
    finally:
        await engine.dispose()


# ─── 콜백 3갈래(0/1/2+) — 실 authorize→callback 라우터 코드, HTTP 왕복 ────────


@pytest.mark.anyio
async def test_callback_zero_pages_returns_422_no_pending_row():
    from app.main import app
    from app.models.channel_oauth_pending_selection import ChannelOAuthPendingSelection
    from sqlalchemy import select

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org_id, _ = await _seed_org(s)
            owner_id = await _seed_human(s, org_id, role="owner")
            await _register_facebook_sandbox_app_credentials(s, org_id=org_id, updated_by=owner_id, app_id="app:pages-0")
        _setup_org_scoped_app(app, Session, org_id, user_id=owner_id)

        async with _client_for(app) as client:
            r = await _authorize_and_callback(client, org_id)
        assert r.status_code == 422, r.text
        assert r.json()["error"]["code"] == "CHANNEL_FACEBOOK_NO_PAGES_AVAILABLE"

        async with Session() as s:
            rows = (await s.execute(select(ChannelOAuthPendingSelection))).scalars().all()
            assert rows == []
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()


@pytest.mark.anyio
async def test_callback_one_page_connects_immediately_no_pending_row():
    from app.main import app
    from app.models.channel_connection import ChannelConnection
    from app.models.channel_oauth_pending_selection import ChannelOAuthPendingSelection
    from sqlalchemy import select

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org_id, _ = await _seed_org(s)
            owner_id = await _seed_human(s, org_id, role="owner")
            await _register_facebook_sandbox_app_credentials(s, org_id=org_id, updated_by=owner_id, app_id="app:pages-1")
        _setup_org_scoped_app(app, Session, org_id, user_id=owner_id)

        async with _client_for(app) as client:
            r = await _authorize_and_callback(client, org_id)
        assert r.status_code == 200, r.text
        body = r.json()
        assert body["kind"] == "connected"
        assert body["account_id"] == "sandbox-page-1"
        assert body["account_label"] == "Sandbox Page 1"

        async with Session() as s:
            conn = (await s.execute(select(ChannelConnection).where(ChannelConnection.org_id == org_id))).scalar_one()
            assert conn.encrypted_access_token is not None
            pending_rows = (await s.execute(select(ChannelOAuthPendingSelection))).scalars().all()
            assert pending_rows == []
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()


@pytest.mark.anyio
async def test_callback_two_pages_returns_pending_selection_no_connection_row():
    from app.main import app
    from app.models.channel_connection import ChannelConnection
    from sqlalchemy import select

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org_id, _ = await _seed_org(s)
            owner_id = await _seed_human(s, org_id, role="owner")
            await _register_facebook_sandbox_app_credentials(s, org_id=org_id, updated_by=owner_id)
        _setup_org_scoped_app(app, Session, org_id, user_id=owner_id)

        async with _client_for(app) as client:
            r = await _authorize_and_callback(client, org_id)
        assert r.status_code == 200, r.text
        body = r.json()
        assert body["kind"] == "pending_selection"
        assert {c["page_id"] for c in body["candidates"]} == {"sandbox-page-1", "sandbox-page-2"}
        assert body["pending_id"]
        assert body["expires_at"]

        async with Session() as s:
            conns = (await s.execute(select(ChannelConnection).where(ChannelConnection.org_id == org_id))).scalars().all()
            assert conns == [], "2개+ 갈래는 콜백에서 연결 행을 만들면 안 된다(select가 만든다)"
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()


# ─── select — 성공 + 5실패코드 ─────────────────────────────────────────────────


async def _setup_pending_two_pages(app, Session, *, org_id, owner_id):
    async with Session() as s:
        await _register_facebook_sandbox_app_credentials(s, org_id=org_id, updated_by=owner_id)
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
        pending_id = await _setup_pending_two_pages(app, Session, org_id=org_id, owner_id=owner_id)

        async with _client_for(app) as client:
            r = await client.post(
                f"/api/v2/organizations/{org_id}/channel-connections/facebook/select",
                json={"pending_id": pending_id, "page_id": "sandbox-page-2"},
            )
        assert r.status_code == 200, r.text
        body = r.json()
        assert body["kind"] == "connected"
        assert body["account_id"] == "sandbox-page-2"
        assert body["account_label"] == "Sandbox Page 2"

        async with Session() as s:
            row = (await s.execute(
                select(ChannelOAuthPendingSelection).where(ChannelOAuthPendingSelection.id == uuid.UUID(pending_id))
            )).scalar_one_or_none()
            assert row is None, "성공했는데 pending 행이 안 지워졌다"
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()


@pytest.mark.anyio
async def test_select_not_found_for_random_pending_id():
    from app.main import app

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org_id, _ = await _seed_org(s)
            owner_id = await _seed_human(s, org_id, role="owner")
        _setup_org_scoped_app(app, Session, org_id, user_id=owner_id)

        async with _client_for(app) as client:
            r = await client.post(
                f"/api/v2/organizations/{org_id}/channel-connections/facebook/select",
                json={"pending_id": str(uuid.uuid4()), "page_id": "x"},
            )
        assert r.status_code == 404, r.text
        assert r.json()["error"]["code"] == "CHANNEL_OAUTH_PENDING_SELECTION_NOT_FOUND"
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()


@pytest.mark.anyio
async def test_select_forbidden_when_requester_mismatch():
    from app.main import app

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org_id, _ = await _seed_org(s)
            owner_id = await _seed_human(s, org_id, role="owner")
            other_owner_id = await _seed_human(s, org_id, role="owner")
        pending_id = await _setup_pending_two_pages(app, Session, org_id=org_id, owner_id=owner_id)

        # 다른 owner로 세션을 다시 세팅 — pending은 첫 owner가 만들었다.
        _setup_org_scoped_app(app, Session, org_id, user_id=other_owner_id)
        async with _client_for(app) as client:
            r = await client.post(
                f"/api/v2/organizations/{org_id}/channel-connections/facebook/select",
                json={"pending_id": pending_id, "page_id": "sandbox-page-1"},
            )
        assert r.status_code == 403, r.text
        assert r.json()["error"]["code"] == "CHANNEL_OAUTH_PENDING_SELECTION_FORBIDDEN"
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()


@pytest.mark.anyio
async def test_select_expired_row_kept_not_deleted():
    """페드루 PO 確定 — 만료는 select가 안 지운다(스윕 몫, 삭제 책임 단일화)."""
    from app.main import app
    from app.models.channel_oauth_pending_selection import ChannelOAuthPendingSelection
    from sqlalchemy import select

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org_id, _ = await _seed_org(s)
            owner_id = await _seed_human(s, org_id, role="owner")
        pending_id = await _setup_pending_two_pages(app, Session, org_id=org_id, owner_id=owner_id)

        async with Session() as s:
            row = (await s.execute(
                select(ChannelOAuthPendingSelection).where(ChannelOAuthPendingSelection.id == uuid.UUID(pending_id))
            )).scalar_one()
            row.expires_at = datetime.now(timezone.utc) - timedelta(minutes=1)
            await s.commit()

        async with _client_for(app) as client:
            r = await client.post(
                f"/api/v2/organizations/{org_id}/channel-connections/facebook/select",
                json={"pending_id": pending_id, "page_id": "sandbox-page-1"},
            )
        assert r.status_code == 404, r.text
        assert r.json()["error"]["code"] == "CHANNEL_OAUTH_PENDING_SELECTION_EXPIRED"

        async with Session() as s:
            row = (await s.execute(
                select(ChannelOAuthPendingSelection).where(ChannelOAuthPendingSelection.id == uuid.UUID(pending_id))
            )).scalar_one_or_none()
            assert row is not None, "만료 select가 행을 지워버렸다(스윕 몫이어야 한다)"
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()


@pytest.mark.anyio
async def test_select_invalid_page_id_not_in_candidates():
    from app.main import app

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org_id, _ = await _seed_org(s)
            owner_id = await _seed_human(s, org_id, role="owner")
        pending_id = await _setup_pending_two_pages(app, Session, org_id=org_id, owner_id=owner_id)

        async with _client_for(app) as client:
            r = await client.post(
                f"/api/v2/organizations/{org_id}/channel-connections/facebook/select",
                json={"pending_id": pending_id, "page_id": "not-a-real-page"},
            )
        assert r.status_code == 400, r.text
        assert r.json()["error"]["code"] == "CHANNEL_OAUTH_PENDING_SELECTION_INVALID_PAGE"
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()


@pytest.mark.anyio
async def test_select_provider_unavailable_keeps_pending_row_for_retry():
    """페드루 PO REQUIRED — Meta(/me/accounts) 재호출 실패는 행을 지우지 않는다(TTL이
    상한, 사람이 재시도할 수 있게)."""
    from app.main import app
    from app.models.channel_oauth_pending_selection import ChannelOAuthPendingSelection
    from app.services.facebook_oauth import FacebookOAuthError
    import app.services.facebook_sandbox_oauth as fb_sandbox_oauth
    from sqlalchemy import select

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org_id, _ = await _seed_org(s)
            owner_id = await _seed_human(s, org_id, role="owner")
        pending_id = await _setup_pending_two_pages(app, Session, org_id=org_id, owner_id=owner_id)

        with patch.object(
            fb_sandbox_oauth, "list_pages",
            AsyncMock(side_effect=FacebookOAuthError("FACEBOOK_LIST_PAGES_FAILED", "provider down")),
        ):
            async with _client_for(app) as client:
                r = await client.post(
                    f"/api/v2/organizations/{org_id}/channel-connections/facebook/select",
                    json={"pending_id": pending_id, "page_id": "sandbox-page-1"},
                )
        assert r.status_code == 503, r.text
        assert r.json()["error"]["code"] == "CHANNEL_OAUTH_PROVIDER_UNAVAILABLE"

        async with Session() as s:
            row = (await s.execute(
                select(ChannelOAuthPendingSelection).where(ChannelOAuthPendingSelection.id == uuid.UUID(pending_id))
            )).scalar_one_or_none()
            assert row is not None, "Meta 호출 실패인데 행이 지워졌다(재시도 불가능해짐)"
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()


@pytest.mark.anyio
async def test_select_twice_with_same_pending_second_call_not_found():
    """페드루 PO 確定 — 「삭제는 성공에만」의 자연스러운 귀결: 같은 pending으로 두 번째
    성공은 첫 성공의 삭제가 막는다(뮤테이션 대상 아래 참고)."""
    from app.main import app

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org_id, _ = await _seed_org(s)
            owner_id = await _seed_human(s, org_id, role="owner")
        pending_id = await _setup_pending_two_pages(app, Session, org_id=org_id, owner_id=owner_id)

        async with _client_for(app) as client:
            r1 = await client.post(
                f"/api/v2/organizations/{org_id}/channel-connections/facebook/select",
                json={"pending_id": pending_id, "page_id": "sandbox-page-1"},
            )
            r2 = await client.post(
                f"/api/v2/organizations/{org_id}/channel-connections/facebook/select",
                json={"pending_id": pending_id, "page_id": "sandbox-page-2"},
            )
        assert r1.status_code == 200, r1.text
        assert r2.status_code == 404, r2.text
        assert r2.json()["error"]["code"] == "CHANNEL_OAUTH_PENDING_SELECTION_NOT_FOUND"
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()


# ─── 자가회수 스윕 ─────────────────────────────────────────────────────────────


@pytest.mark.anyio
async def test_sweep_deletes_expired_pending_selections_keeps_fresh_ones():
    from app.services.channel_oauth_pending_selection import create_pending_selection, sweep_expired_pending_selections
    from app.models.channel_oauth_pending_selection import ChannelOAuthPendingSelection
    from sqlalchemy import select

    engine, Session = await _session_factory()
    try:
        now = datetime.now(timezone.utc)
        async with Session() as s:
            org_id, _ = await _seed_org(s)
            owner_id = await _seed_human(s, org_id, role="owner")
            expired = await create_pending_selection(
                s, org_id=org_id, requester_member_id=owner_id, channel="facebook_sandbox",
                user_token="t", candidates=[{"page_id": "p1", "name": "P1"}], now=now - timedelta(minutes=30),
            )
            fresh = await create_pending_selection(
                s, org_id=org_id, requester_member_id=owner_id, channel="facebook_sandbox",
                user_token="t", candidates=[{"page_id": "p2", "name": "P2"}], now=now,
            )

        async with Session() as s:
            deleted = await sweep_expired_pending_selections(s, now=now)
        assert deleted == 1

        async with Session() as s:
            remaining_ids = {r.id for r in (await s.execute(select(ChannelOAuthPendingSelection))).scalars().all()}
        assert expired.id not in remaining_ids
        assert fresh.id in remaining_ids
    finally:
        await engine.dispose()


@pytest.mark.anyio
async def test_cron_publication_commands_tick_wires_the_sweep():
    """cron.py::publication_commands_tick 응답에 oauth_pending_selections_swept
    카운트가 있어야 배선이 실제로 됐다는 뜻(3497/3527과 동형 피기백 검증 사상)."""
    from app.main import app

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            await _seed_org(s)

        async def _db():
            async with Session() as s:
                yield s

        from app.dependencies.database import get_worker_db
        app.dependency_overrides[get_worker_db] = _db

        import app.routers.cron as cron_module
        with patch.object(cron_module, "verify_cron", lambda request: None):
            async with _client_for(app) as client:
                r = await client.post("/api/v2/internal/cron/publication-commands")
        assert r.status_code == 200, r.text
        assert "oauth_pending_selections_swept" in r.json()["data"]
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()
