"""story #3320(Phase2·마케팅운영, 페드루 PO 確定 2026-09-05) — Instagram Graph API
커넥터 조각①(연결+sandbox 발행). threads_oauth.py/threads_publish.py/sandbox_
publish.py와 정확히 같은 계약(신규 판정 로직 0) — 세팅 헬퍼는 test_3373_channel_
connections.py 재사용(플랫폼 앱 자격 시드가 threads/instagram 공용 컬럼이라
그대로 맞는다, 그라운딩+PO 決定 반영).

AC 매핑:
- get_publish_client_module이 명시 dict로 채널을 갈라 미등록 채널은 fail-closed
  (뮤테이션 대상 — dict에서 instagram을 빼면 threads_publish가 아니라 예외로
  떨어져야 한다).
- instagram_oauth.py: PKCE 없음(문서 확認)·"data" 배열 응답 shape 처리.
- instagram_publish.py/instagram_sandbox_publish.py: 이미지 필수(threads_publish.py
  의 TEXT-optional과 다른 성질) · ThreadsPublishError 재사용(신규 예외 클래스 0).
- channel_post_images.py: image_aspect_min(신규 축)이 Threads(0.0=하한 없음)는
  회귀 0, Instagram(0.8)만 세로 과도 이미지를 거부."""
from __future__ import annotations

import os
import uuid
from unittest.mock import AsyncMock, patch

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
    monkeypatch.setattr(config_module.settings, "channel_oauth_state_secret", "test-channel-oauth-state-secret")

    import app.services.channel_credential_crypto as crypto_module
    importlib.reload(crypto_module)
    yield
    importlib.reload(crypto_module)


@pytest.fixture(autouse=True)
def _enable_sandbox_flag(monkeypatch):
    """instagram_sandbox 어댑터는 CHANNEL_ADAPTERS의 SANDBOX_CHANNEL_ENABLED
    조건부 블록 안에 등재된다(기존 sandbox와 동형) — 모듈이 이미 import된 뒤라
    딕셔너리에 직접 주입(test_3497_insight_snapshots.py의 선례와 동형)."""
    import app.services.channel_adapters as adapters_mod

    ig_sandbox_cfg = adapters_mod.ChannelAdapterConfig(
        authorize_url="", token_url="", scope="sandbox_publish,sandbox_delete",
        refresh_mode="manual", credential_kind="none", display_name="Instagram Sandbox",
        max_text_length=2200, utm_source="instagram_sandbox", utm_medium="test",
        image_formats=("image/jpeg",), image_max_bytes=8 * 1024 * 1024,
        image_aspect_max=1.91, image_aspect_min=0.8,
        image_width_min=320, image_width_max=1440, image_color_space="sRGB", image_max_count=1,
    )
    monkeypatch.setitem(adapters_mod.CHANNEL_ADAPTERS, "instagram_sandbox", ig_sandbox_cfg)
    yield


# ─── get_publish_client_module: dict 디스패치·fail-closed ────────────────────


def test_get_publish_client_module_dispatches_instagram_and_instagram_sandbox():
    from app.services.channel_adapters import get_publish_client_module
    import app.services.instagram_publish as instagram_publish
    import app.services.instagram_sandbox_publish as instagram_sandbox_publish
    import app.services.threads_publish as threads_publish

    assert get_publish_client_module("instagram") is instagram_publish
    assert get_publish_client_module("instagram_sandbox") is instagram_sandbox_publish
    assert get_publish_client_module("threads") is threads_publish


def test_get_publish_client_module_unknown_channel_fail_closed():
    from app.services.channel_adapters import ChannelPublishDispatchNotImplementedError, get_publish_client_module

    with pytest.raises(ChannelPublishDispatchNotImplementedError):
        get_publish_client_module("myspace")


def test_get_publish_client_module_never_falls_through_to_threads_for_instagram(monkeypatch):
    """뮤테이션 자가검증 — dict에서 instagram을 빼면(과거 if/elif 폴백 재현) 예전
    결함처럼 threads_publish로 조용히 떨어지면 안 되고 예외로 fail-closed 되는지."""
    import app.services.channel_adapters as adapters_mod

    mutated = dict(adapters_mod._PUBLISH_CLIENT_MODULE_PATHS)
    del mutated["instagram"]
    monkeypatch.setattr(adapters_mod, "_PUBLISH_CLIENT_MODULE_PATHS", mutated)

    with pytest.raises(adapters_mod.ChannelPublishDispatchNotImplementedError):
        adapters_mod.get_publish_client_module("instagram")


# ─── instagram_oauth.py ───────────────────────────────────────────────────────


def test_build_authorize_url_never_sends_pkce_params():
    from app.services.instagram_oauth import build_authorize_url

    url = build_authorize_url(redirect_uri="https://x/callback", state="s", app_id="app-id")
    assert "code_challenge" not in url
    assert "client_id=app-id" in url
    assert url.startswith("https://www.instagram.com/oauth/authorize?")


@pytest.mark.anyio
async def test_exchange_short_lived_token_handles_data_array_response_shape():
    from app.services.instagram_oauth import exchange_code_for_short_lived_token

    class _FakeResponse:
        status_code = 200
        def json(self):
            return {"data": [{"access_token": "tok", "user_id": "17841400000000"}]}

    class _FakeClient:
        async def post(self, url, *, data):
            return _FakeResponse()

    token, user_id = await exchange_code_for_short_lived_token(
        _FakeClient(), code="c", redirect_uri="https://x/callback", app_id="app-id", app_secret="secret",
    )
    assert token == "tok"
    assert user_id == "17841400000000"


@pytest.mark.anyio
async def test_exchange_short_lived_token_handles_flat_response_shape():
    from app.services.instagram_oauth import exchange_code_for_short_lived_token

    class _FakeResponse:
        status_code = 200
        def json(self):
            return {"access_token": "tok", "user_id": "17841400000000"}

    class _FakeClient:
        async def post(self, url, *, data):
            return _FakeResponse()

    token, user_id = await exchange_code_for_short_lived_token(
        _FakeClient(), code="c", redirect_uri="https://x/callback", app_id="app-id", app_secret="secret",
    )
    assert token == "tok"
    assert user_id == "17841400000000"


@pytest.mark.anyio
async def test_exchange_short_lived_token_failure_raises():
    from app.services.instagram_oauth import InstagramOAuthError, exchange_code_for_short_lived_token

    class _FakeResponse:
        status_code = 400
        text = "bad request"

    class _FakeClient:
        async def post(self, url, *, data):
            return _FakeResponse()

    with pytest.raises(InstagramOAuthError):
        await exchange_code_for_short_lived_token(
            _FakeClient(), code="c", redirect_uri="https://x/callback", app_id="app-id", app_secret="secret",
        )


@pytest.mark.anyio
async def test_exchange_for_long_lived_token_uses_ig_exchange_token_grant():
    from app.services.instagram_oauth import exchange_for_long_lived_token

    captured = {}

    class _FakeResponse:
        status_code = 200
        def json(self):
            return {"access_token": "long-tok", "expires_in": 5184000}

    class _FakeClient:
        async def get(self, url, *, params):
            captured["params"] = params
            return _FakeResponse()

    token, expires_in = await exchange_for_long_lived_token(_FakeClient(), short_lived_token="short", app_secret="secret")
    assert token == "long-tok"
    assert expires_in == 5184000
    assert captured["params"]["grant_type"] == "ig_exchange_token"


@pytest.mark.anyio
async def test_refresh_long_lived_token_uses_ig_refresh_token_grant():
    from app.services.instagram_oauth import refresh_long_lived_token

    captured = {}

    class _FakeResponse:
        status_code = 200
        def json(self):
            return {"access_token": "refreshed-tok", "expires_in": 5184000}

    class _FakeClient:
        async def get(self, url, *, params):
            captured["params"] = params
            return _FakeResponse()

    token, expires_in = await refresh_long_lived_token(_FakeClient(), current_token="current")
    assert token == "refreshed-tok"
    assert captured["params"]["grant_type"] == "ig_refresh_token"


@pytest.mark.anyio
async def test_instagram_test_connection_returns_id_and_username():
    from app.services.instagram_oauth import test_connection

    class _FakeResponse:
        status_code = 200
        def json(self):
            return {"id": "17841400000000", "username": "sprintable_demo"}

    class _FakeClient:
        async def get(self, url, *, params):
            return _FakeResponse()

    account = await test_connection(_FakeClient(), access_token="tok")
    assert account == {"id": "17841400000000", "username": "sprintable_demo"}


# ─── instagram_publish.py ─────────────────────────────────────────────────────


@pytest.mark.anyio
async def test_create_container_requires_image_url():
    from app.services.instagram_publish import create_container
    from app.services.threads_publish import ThreadsPublishError

    with pytest.raises(ThreadsPublishError) as exc_info:
        await create_container(None, access_token="tok", threads_user_id="ig-1", text="캡션", image_url=None)
    assert exc_info.value.code == "INSTAGRAM_IMAGE_REQUIRED"


@pytest.mark.anyio
async def test_create_container_success_posts_caption_and_image_url():
    from app.services.instagram_publish import create_container

    captured = {}

    class _FakeResponse:
        status_code = 200
        def json(self):
            return {"id": "creation-1"}

    class _FakeClient:
        async def post(self, url, *, params):
            captured["url"], captured["params"] = url, params
            return _FakeResponse()

    creation_id = await create_container(
        _FakeClient(), access_token="tok", threads_user_id="ig-1", text="캡션",
        image_url="https://storage.googleapis.com/bucket/img.jpg",
    )
    assert creation_id == "creation-1"
    assert captured["params"]["caption"] == "캡션"
    assert captured["params"]["image_url"] == "https://storage.googleapis.com/bucket/img.jpg"
    assert "ig-1" in captured["url"]


@pytest.mark.anyio
async def test_get_container_status_reads_status_code_field():
    from app.services.instagram_publish import get_container_status

    class _FakeResponse:
        status_code = 200
        def json(self):
            return {"status_code": "FINISHED"}

    class _FakeClient:
        async def get(self, url, *, params):
            return _FakeResponse()

    status, error_message = await get_container_status(_FakeClient(), access_token="tok", creation_id="c1")
    assert status == "FINISHED"
    assert error_message is None


@pytest.mark.anyio
async def test_publish_container_returns_media_id():
    from app.services.instagram_publish import publish_container

    class _FakeResponse:
        status_code = 200
        def json(self):
            return {"id": "media-1"}

    class _FakeClient:
        async def post(self, url, *, params):
            return _FakeResponse()

    media_id = await publish_container(_FakeClient(), access_token="tok", threads_user_id="ig-1", creation_id="c1")
    assert media_id == "media-1"


@pytest.mark.anyio
async def test_get_publishing_limit_parses_quota_shape():
    from app.services.instagram_publish import get_publishing_limit

    class _FakeResponse:
        status_code = 200
        def json(self):
            return {"data": [{"quota_usage": 5, "config": {"quota_total": 25, "quota_duration": 86400}}]}

    class _FakeClient:
        async def get(self, url, *, params):
            return _FakeResponse()

    usage, total, duration = await get_publishing_limit(_FakeClient(), access_token="tok", threads_user_id="ig-1")
    assert (usage, total, duration) == (5, 25, 86400)


@pytest.mark.anyio
async def test_delete_media_not_implemented():
    from app.services.instagram_publish import delete_media
    from app.services.threads_publish import ThreadsPublishError

    with pytest.raises(ThreadsPublishError) as exc_info:
        await delete_media(None, access_token="tok", media_id="media-1")
    assert exc_info.value.code == "INSTAGRAM_DELETE_MEDIA_NOT_IMPLEMENTED"


@pytest.mark.anyio
async def test_get_permalink_returns_none_when_absent():
    from app.services.instagram_publish import get_permalink

    class _FakeResponse:
        status_code = 200
        def json(self):
            return {}

    class _FakeClient:
        async def get(self, url, *, params):
            return _FakeResponse()

    permalink = await get_permalink(_FakeClient(), access_token="tok", media_id="media-1")
    assert permalink is None


# ─── instagram_sandbox_publish.py ─────────────────────────────────────────────


@pytest.mark.anyio
async def test_sandbox_create_container_requires_image_too():
    """sandbox가 실 provider보다 관대하면 "sandbox는 됐는데 실계정은 막힘" 격차가
    생긴다 — 이미지 필수는 sandbox도 지킨다."""
    from app.services.instagram_sandbox_publish import create_container
    from app.services.threads_publish import ThreadsPublishError

    with pytest.raises(ThreadsPublishError) as exc_info:
        await create_container(None, access_token="x", threads_user_id="ig-1", text="캡션", image_url=None)
    assert exc_info.value.code == "INSTAGRAM_IMAGE_REQUIRED"


@pytest.mark.anyio
async def test_sandbox_create_container_success_and_publish_are_deterministic_shape():
    from app.services.instagram_sandbox_publish import create_container, get_container_status, publish_container

    creation_id = await create_container(
        None, access_token="x", threads_user_id="ig-1", text="캡션", image_url="https://example.com/img.jpg",
    )
    assert creation_id.startswith("sandbox-ig-creation-")

    status, _ = await get_container_status(None, access_token="x", creation_id=creation_id)
    assert status == "FINISHED"

    media_id = await publish_container(None, access_token="x", threads_user_id="ig-1", creation_id=creation_id)
    assert media_id.startswith("sandbox-ig-media-")


@pytest.mark.anyio
async def test_sandbox_markers_simulate_failures():
    from app.services.instagram_sandbox_publish import create_container
    from app.services.threads_publish import ThreadsPublishError

    with pytest.raises(ThreadsPublishError) as exc_429:
        await create_container(
            None, access_token="x", threads_user_id="ig-1", text="[sandbox:429]",
            image_url="https://example.com/img.jpg",
        )
    assert exc_429.value.status_code == 429

    with pytest.raises(ThreadsPublishError) as exc_token:
        await create_container(
            None, access_token="x", threads_user_id="ig-1", text="[sandbox:expired-token]",
            image_url="https://example.com/img.jpg",
        )
    assert exc_token.value.status_code == 401


# ─── channel_post_images.py: image_aspect_min(신규 축) ───────────────────────


def test_channel_adapter_config_image_aspect_min_defaults_to_zero_for_threads():
    """회귀 0 확인 — 기존 Threads 어댑터는 새 필드를 안 건드려도 기본값(0.0)이라
    세로 하한 검사 자체를 안 탄다."""
    from app.services.channel_adapters import CHANNEL_ADAPTERS

    assert CHANNEL_ADAPTERS["threads"].image_aspect_min == 0.0


def test_channel_adapter_config_instagram_has_aspect_min():
    from app.services.channel_adapters import CHANNEL_ADAPTERS

    ig = CHANNEL_ADAPTERS["instagram"]
    assert ig.image_aspect_min == 0.8
    assert ig.image_aspect_max == 1.91


# ─── _PLATFORM_SETTINGS_COLUMNS: Meta 앱 재사용 ──────────────────────────────


def test_instagram_reuses_threads_platform_settings_columns():
    from app.services.channel_app_credentials import _PLATFORM_SETTINGS_COLUMNS

    assert _PLATFORM_SETTINGS_COLUMNS["instagram"] == _PLATFORM_SETTINGS_COLUMNS["threads"]


# ─── API: instagram authorize/callback + instagram-sandbox 연결 생성 ─────────


@pytest.mark.anyio
async def test_api_authorize_instagram_omits_pkce():
    from app.main import app

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org_id, project_id = await _seed_org(s)
            owner_id = await _seed_human(s, org_id, role="owner")
        _setup_org_scoped_app(app, Session, org_id, user_id=owner_id)

        async with _client_for(app) as client:
            resp = await client.post(f"/api/v2/organizations/{org_id}/channel-connections/instagram/authorize")
        assert resp.status_code == 200, resp.text
        assert "code_challenge" not in resp.json()["url"]
        assert "instagram.com" in resp.json()["url"]
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()


@pytest.mark.anyio
async def test_api_authorize_then_callback_creates_instagram_connection():
    from app.main import app
    import app.services.instagram_oauth as igo

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org_id, project_id = await _seed_org(s)
            owner_id = await _seed_human(s, org_id, role="owner")
        _setup_org_scoped_app(app, Session, org_id, user_id=owner_id)

        async with _client_for(app) as client:
            r_auth = await client.post(f"/api/v2/organizations/{org_id}/channel-connections/instagram/authorize")
        assert r_auth.status_code == 200, r_auth.text
        state = r_auth.json()["state"]

        plaintext_token = "ig_plaintext_super_secret_token_zzz"
        with patch.object(
            igo, "exchange_code_for_short_lived_token", AsyncMock(return_value=("short_lived_xyz", "17841400000000")),
        ), patch.object(
            igo, "exchange_for_long_lived_token", AsyncMock(return_value=(plaintext_token, 5184000)),
        ), patch.object(
            igo, "test_connection", AsyncMock(return_value={"id": "17841400000000", "username": "sprintable_ig_demo"}),
        ):
            async with _client_for(app) as client:
                r_cb = await client.post(
                    f"/api/v2/organizations/{org_id}/channel-connections/instagram/callback",
                    json={"code": "auth-code-abc", "state": state},
                )
        assert r_cb.status_code == 200, r_cb.text
        payload = r_cb.json()
        assert payload["channel"] == "instagram"
        assert payload["account_label"] == "sprintable_ig_demo"
        assert payload["status"] == "active"
        assert plaintext_token not in str(payload)

        async with Session() as s:
            from app.models.channel_connection import ChannelConnection
            from sqlalchemy import select
            row = (await s.execute(
                select(ChannelConnection).where(ChannelConnection.org_id == org_id)
            )).scalar_one()
        assert row.encrypted_access_token != plaintext_token
        assert row.refresh_mode == "reissue_from_access_token"
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()


@pytest.mark.anyio
async def test_api_create_instagram_sandbox_connection():
    from app.main import app

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org_id, project_id = await _seed_org(s)
            owner_id = await _seed_human(s, org_id, role="owner")
        _setup_org_scoped_app(app, Session, org_id, user_id=owner_id)

        async with _client_for(app) as client:
            resp = await client.post(f"/api/v2/organizations/{org_id}/channel-connections/instagram-sandbox")
        assert resp.status_code == 201, resp.text
        assert resp.json()["channel"] == "instagram_sandbox"
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()


# ─── channel_post_images.py: image_aspect_min 실 업로드 흐름(HTTP end-to-end) ──


@pytest.fixture(autouse=True)
def _local_channel_media_storage_for_image_upload(monkeypatch, tmp_path):
    """test_620beefc_channel_post_image.py의 동형 픽스처(중복 재발명 금지) — 이
    파일의 다른 테스트엔 영향 없다(channel_post_images.py를 안 건드리는 테스트는
    이 monkeypatch를 그냥 무시). 버킷 이름은 반드시 `_upload_and_confirm`이 쓰는
    `test_620beefc_channel_post_image.py`의 `_CHANNEL_MEDIA_BUCKET`과 같아야 한다
    — 다르면 PUT(_put_raw_object가 그 상수로 씀)과 confirm(cpi_module.
    CHANNEL_MEDIA_BUCKET을 읽음)이 서로 다른 버킷을 봐서 404 CHANNEL_IMAGE_
    OBJECT_NOT_FOUND가 난다(실제로 한 번 겪은 자리)."""
    import app.services.channel_post_images as cpi_module
    from tests.test_620beefc_channel_post_image import _CHANNEL_MEDIA_BUCKET

    monkeypatch.setenv("STORAGE_PROVIDER", "local")
    monkeypatch.setenv("STORAGE_LOCAL_ROOT", str(tmp_path / ".storage-3320"))
    monkeypatch.setattr(cpi_module, "CHANNEL_MEDIA_BUCKET", _CHANNEL_MEDIA_BUCKET)
    monkeypatch.setattr(cpi_module, "_PUBLIC_BASE", f"https://storage.googleapis.com/{_CHANNEL_MEDIA_BUCKET}/")
    yield


def _tall_png_bytes(width: int, height: int) -> bytes:
    from PIL import Image
    import io as _io

    img = Image.new("RGB", (width, height), color=(200, 50, 80))
    buf = _io.BytesIO()
    img.save(buf, format="PNG")
    return buf.getvalue()


@pytest.mark.anyio
async def test_upload_instagram_image_too_narrow_returns_422_but_threads_unaffected():
    """image_aspect_min(신규 축) 뮤테이션 자가검증 대조 — 같은 극단 세로 이미지가
    Instagram(0.8 하한)에서는 거부되고, Threads(0.0=하한 없음)에서는 기존 그대로
    통과해야 한다(회귀 0의 실제 증거, 흉내가 아니라 같은 이미지로 대조)."""
    from app.main import app
    from tests.test_620beefc_channel_post_image import (
        _create_draft, _seed_connection, _seed_human, _seed_org, _seed_story,
        _session_factory, _client_for, _setup_org_scoped_app, _upload_and_confirm,
    )

    # width/height=1:2 → width/height ratio=0.5 < instagram의 image_aspect_min(0.8).
    # 정규화(long/short)로는 2.0 < 10.0(threads image_aspect_max)이라 threads는 통과.
    raw = _tall_png_bytes(200, 400)

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org_id, project_id = await _seed_org(s)
            human_id = await _seed_human(s, org_id, project_id)
            ig_connection_id = await _seed_connection(s, org_id, channel="instagram")
            threads_connection_id = await _seed_connection(s, org_id, channel="threads")
            story_id = await _seed_story(s, org_id, project_id)

        _setup_org_scoped_app(app, Session, org_id, user_id=human_id, agent=False)
        try:
            async with _client_for(app) as client:
                ig_draft_id = await _create_draft(
                    client, org_id=org_id, connection_id=ig_connection_id, story_id=story_id,
                )
                r_ig = await _upload_and_confirm(client, org_id, ig_draft_id, raw, content_type="image/png")
            assert r_ig.status_code == 422, r_ig.text
            error = r_ig.json().get("error") or r_ig.json()
            assert error["code"] == "CHANNEL_IMAGE_ASPECT_RATIO_TOO_NARROW"

            async with _client_for(app) as client:
                threads_draft_id = await _create_draft(
                    client, org_id=org_id, connection_id=threads_connection_id, story_id=story_id,
                )
                r_threads = await _upload_and_confirm(
                    client, org_id, threads_draft_id, raw, content_type="image/png",
                )
            assert r_threads.status_code == 201, r_threads.text
        finally:
            app.dependency_overrides.clear()
    finally:
        await engine.dispose()


@pytest.mark.anyio
async def test_api_agent_rejected_from_instagram_authorize():
    from app.main import app

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org_id, project_id = await _seed_org(s)
            agent_id = await _seed_agent(s, org_id, project_id)
        _setup_org_scoped_app(app, Session, org_id, user_id=agent_id, agent=True)

        async with _client_for(app) as client:
            resp = await client.post(f"/api/v2/organizations/{org_id}/channel-connections/instagram/authorize")
        assert resp.status_code == 403
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()
