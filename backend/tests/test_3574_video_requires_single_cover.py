"""story #3574(Phase2·BE·결함, 페드루 PO 確定 2026-09-06) — 이미지 2장 이상(캐러셀)
초안에 영상을 첨부하면 `channel_post_videos.py`의 단수 getter(`get_channel_post_
image_for_version`, position=0만 대표)가 그대로 커버 캐리에 쓰여 N-1장이 사용자
행동 하나로 조용히 사라지던 결함(유나 §17-23 ④ 실측).

確定(금지 AC) — 영상 confirm 시 최신 버전의 이미지 수가 **2 이상이면** 트랜잭션
(새 버전 생성) 시작 前 422 `CHANNEL_VIDEO_REQUIRES_SINGLE_COVER`. 0·1장은 현행
그대로(단수 getter 의미가 정확히 일치하는 구간이라 무변경).

세팅 헬퍼는 test_620beefc_channel_post_image.py(base)·test_3567_facebook_page_
final.py(facebook_sandbox 영상 픽스처) 재사용(중복 재발명 금지)."""
from __future__ import annotations

import os
import uuid

import pytest

from tests.test_620beefc_channel_post_image import (
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
    _seed_default_role,
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


_CHANNEL_MEDIA_BUCKET = "test-channel-media-3574"


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
    import tests.test_620beefc_channel_post_image as base_test_module

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


async def _upload_n_images(client, org_id, draft_id, n: int, *, size=(800, 1000)):
    responses = []
    for i in range(n):
        raw = _jpeg_bytes(*size, color=(10 * i, 50, 80))
        r = await _upload_and_confirm(client, org_id, draft_id, raw, content_type="image/jpeg")
        responses.append(r)
    return responses


@pytest.mark.anyio
@pytest.mark.parametrize("channel", ["facebook_sandbox", "instagram_sandbox"])
async def test_video_confirm_rejected_when_two_images(channel):
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
            responses = await _upload_n_images(client, org_id, draft_id, 2)
            for r in responses:
                assert r.status_code == 201, r.text

            raw_video = _build_mp4(duration_seconds=6.0, **_VALID_9_16)
            r_video = await _upload_and_confirm_video(client, org_id, draft_id, raw_video)
        assert r_video.status_code == 422, r_video.text
        assert r_video.json()["error"]["code"] == "CHANNEL_VIDEO_REQUIRES_SINGLE_COVER"
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()


@pytest.mark.anyio
@pytest.mark.parametrize("channel", ["facebook_sandbox", "instagram_sandbox"])
async def test_video_confirm_carries_single_cover_when_one_image(channel):
    from app.main import app
    from sqlalchemy import select
    from app.models.channel_post_image import ChannelPostImage

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
                client, org_id, draft_id, _jpeg_bytes(800, 1000), content_type="image/jpeg",
            )
            assert r_image.status_code == 201, r_image.text

            raw_video = _build_mp4(duration_seconds=6.0, **_VALID_9_16)
            r_video = await _upload_and_confirm_video(client, org_id, draft_id, raw_video)
        assert r_video.status_code == 201, r_video.text
        new_version_id = uuid.UUID(r_video.json()["version_id"])

        async with Session() as s:
            covers = (await s.execute(
                select(ChannelPostImage).where(ChannelPostImage.version_id == new_version_id)
            )).scalars().all()
        assert len(covers) == 1
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()


@pytest.mark.anyio
@pytest.mark.parametrize("channel", ["facebook_sandbox", "instagram_sandbox"])
async def test_video_confirm_carries_zero_cover_when_no_image(channel):
    from app.main import app
    from sqlalchemy import select
    from app.models.channel_post_image import ChannelPostImage

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
        new_version_id = uuid.UUID(r_video.json()["version_id"])

        async with Session() as s:
            covers = (await s.execute(
                select(ChannelPostImage).where(ChannelPostImage.version_id == new_version_id)
            )).scalars().all()
        assert len(covers) == 0
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()
