"""story #3578(Phase2·BE·급·결함, 페드루 PO 確定 2026-09-06) — 릴스 커버(9:16)가
구조적으로 못 올라가던 결함. `channel_post_images.py`의 이미지 비율 검증
(image_aspect_min=0.80)이 커버/캐러셀 분기(영상 유무)보다 먼저 돌아 커버도
캐러셀 규격(하한 0.80)으로 재졌다 — 릴스 커버는 본디 9:16(0.5625)이라 그 하한을
영원히 못 넘는다(유나 §17-23 ④ 실측).

確定 — 분기(영상 유무)를 먼저 결정하고, 영상이 있으면 **커버 규격**
(video_aspect_target±video_aspect_tolerance, 어댑터 선언)으로 검증. 영상이
없으면(캐러셀) 기존 image_aspect_min/max 그대로(회귀 0).

세팅 헬퍼는 test_620beefc_channel_post_image_upload.py(base)·test_3567_facebook_page_
final.py(facebook_sandbox 영상 픽스처)·test_3574_video_requires_single_cover.py
(instagram_sandbox 영상 설정 monkeypatch) 재사용(중복 재발명 금지)."""
from __future__ import annotations

import os
import uuid

import pytest

from tests.test_620beefc_channel_post_image_upload import (
    _client_for,
    _create_draft,
    _jpeg_bytes,
    _seed_connection,
    _seed_human,
    _seed_org,
    _seed_story,
    _session_factory,
    _setup_org_scoped_app,
    _upload_and_confirm,
)
from tests.test_3567_facebook_page_final import (
    _VALID_9_16,
    _build_mp4,
    _upload_and_confirm_video,
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


_CHANNEL_MEDIA_BUCKET = "test-channel-media-3578"


@pytest.fixture(autouse=True)
def _local_channel_media_storage(monkeypatch, tmp_path):
    import app.services.channel_post_images as cpi_module

    monkeypatch.setenv("STORAGE_PROVIDER", "local")
    monkeypatch.setenv("STORAGE_LOCAL_ROOT", str(tmp_path / ".storage"))
    monkeypatch.setattr(cpi_module, "CHANNEL_MEDIA_BUCKET", _CHANNEL_MEDIA_BUCKET)
    monkeypatch.setattr(cpi_module, "_PUBLIC_BASE", f"https://storage.googleapis.com/{_CHANNEL_MEDIA_BUCKET}/")
    yield


@pytest.fixture(autouse=True)
def _local_channel_media_storage_object_path_fix(monkeypatch):
    import tests.test_620beefc_channel_post_image_upload as base_test_module

    monkeypatch.setattr(base_test_module, "_CHANNEL_MEDIA_BUCKET", _CHANNEL_MEDIA_BUCKET)
    yield


@pytest.fixture(autouse=True)
def _instagram_sandbox_video_config(monkeypatch):
    """test_3554_instagram_reels.py::_instagram_sandbox_video_config와 동형 —
    SANDBOX_CHANNEL_ENABLED 조건부 블록(모듈 import 시점 1회 평가)에 기대지 않고
    이 테스트 파일이 필요로 하는 정확한 값(image_max_count=10+video_*)을 직접
    주입한다(import 순서 무관하게 결정적)."""
    import app.services.channel_adapters as adapters_mod

    ig_sandbox_cfg = adapters_mod.ChannelAdapterConfig(
        authorize_url="", token_url="", scope="sandbox_publish,sandbox_delete",
        refresh_mode="manual", credential_kind="none", display_name="Instagram Sandbox",
        max_text_length=2200, utm_source="instagram_sandbox", utm_medium="test",
        image_formats=("image/jpeg",), image_max_bytes=8 * 1024 * 1024,
        image_aspect_max=1.91, image_aspect_min=0.8,
        image_width_min=320, image_width_max=1440, image_color_space="sRGB",
        image_max_count=10,
        video_max_bytes=100 * 1024 * 1024, video_max_seconds=90.0, video_min_seconds=3.0,
        video_aspect_target=9 / 16, video_aspect_tolerance=0.05,
        video_codecs=("avc1", "hvc1", "hev1"),
    )
    monkeypatch.setitem(adapters_mod.CHANNEL_ADAPTERS, "instagram_sandbox", ig_sandbox_cfg)
    yield


@pytest.mark.anyio
@pytest.mark.parametrize("channel", ["facebook_sandbox", "instagram_sandbox"])
async def test_cover_9_16_accepted_after_video_attached(channel):
    from app.main import app

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org_id, project_id = await _seed_org(s)
            human_id = await _seed_human(s, org_id, project_id)
            connection_id = await _seed_connection(s, org_id, channel=channel)
            story_id = await _seed_story(s, org_id, project_id)

        _setup_org_scoped_app(app, Session, org_id, user_id=human_id, agent=False)
        async with _client_for(app) as client:
            draft_id = await _create_draft(client, org_id=org_id, connection_id=connection_id, story_id=story_id)
            raw_video = _build_mp4(duration_seconds=6.0, **_VALID_9_16)
            r_video = await _upload_and_confirm_video(client, org_id, draft_id, raw_video)
            assert r_video.status_code == 201, r_video.text

            r_cover = await _upload_and_confirm(
                client, org_id, draft_id, _jpeg_bytes(720, 1280), content_type="image/jpeg",
            )
        assert r_cover.status_code == 201, r_cover.text
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()


@pytest.mark.anyio
@pytest.mark.parametrize("channel", ["facebook_sandbox", "instagram_sandbox"])
async def test_cover_square_rejected_with_cover_specific_code(channel):
    from app.main import app

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org_id, project_id = await _seed_org(s)
            human_id = await _seed_human(s, org_id, project_id)
            connection_id = await _seed_connection(s, org_id, channel=channel)
            story_id = await _seed_story(s, org_id, project_id)

        _setup_org_scoped_app(app, Session, org_id, user_id=human_id, agent=False)
        async with _client_for(app) as client:
            draft_id = await _create_draft(client, org_id=org_id, connection_id=connection_id, story_id=story_id)
            raw_video = _build_mp4(duration_seconds=6.0, **_VALID_9_16)
            r_video = await _upload_and_confirm_video(client, org_id, draft_id, raw_video)
            assert r_video.status_code == 201, r_video.text

            r_cover = await _upload_and_confirm(
                client, org_id, draft_id, _jpeg_bytes(1000, 1000), content_type="image/jpeg",
            )
        assert r_cover.status_code == 422, r_cover.text
        detail = r_cover.json()["error"]
        assert detail["code"] == "CHANNEL_COVER_ASPECT_RATIO_REJECTED"
        assert detail["target"] == pytest.approx(9 / 16)
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()


@pytest.mark.anyio
@pytest.mark.parametrize("channel", ["instagram_sandbox"])
async def test_carousel_image_without_video_uses_carousel_spec_regression_zero(channel):
    """영상 없는 버전(캐러셀)은 기존 image_aspect_min/max 그대로 — 9:16(0.5625)
    이미지는 여전히 캐러셀 하한(0.80) 미달로 기존 422 코드가 나야 한다(회귀 0).
    facebook은 image_aspect_min 자체를 선언 안 해(하한 없음, Threads류 상한-only
    관례) 이 축의 회귀 대상이 아니다 — instagram(_sandbox)만 해당."""
    from app.main import app

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org_id, project_id = await _seed_org(s)
            human_id = await _seed_human(s, org_id, project_id)
            connection_id = await _seed_connection(s, org_id, channel=channel)
            story_id = await _seed_story(s, org_id, project_id)

        _setup_org_scoped_app(app, Session, org_id, user_id=human_id, agent=False)
        async with _client_for(app) as client:
            draft_id = await _create_draft(client, org_id=org_id, connection_id=connection_id, story_id=story_id)
            r_image = await _upload_and_confirm(
                client, org_id, draft_id, _jpeg_bytes(720, 1280), content_type="image/jpeg",
            )
        assert r_image.status_code == 422, r_image.text
        assert r_image.json()["error"]["code"] == "CHANNEL_IMAGE_ASPECT_RATIO_TOO_NARROW"
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()
