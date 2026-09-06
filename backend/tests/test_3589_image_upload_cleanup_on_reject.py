"""story #3589(Phase2·BE·소형·결함, 페드루 PO 確定 2026-09-06) — 이미지 confirm이
422로 거부되면 업로드된 GCS 객체가 고아로 남던 결함 클래스(영상 몫과 동일
원인·동일 처방 — `test_3589_video_upload_cleanup_on_reject.py` docstring
참조).

처방(channel_post_images.py::confirm_channel_post_image_upload) — head_object
확認 뒤 구간 전체를 try/except 하나로 감싸 갈래별 delete_object 누락을
구조적으로 없앴다(파생본이 이미 올라갔으면 그것도 같이 정리). 이 파일은 그
처방(이미지 몫)을 실측한다: 거부 갈래마다 (a) 디스크에서 객체가 실제로
사라졌는지 (b) delete_object가 정확히 1회만 불렸는지 — 성공 갈래는 둘 다 0.

원래 영상 5건+이미지 5건 단일 파일이었는데 페드루 PO 리뷰(2026-09-06 14:00Z)
— weights 42s가 story #3579의 60초 가드 경계대역이라 영상/이미지 2-way로
분할. 영상 관련 helper(`_build_mp4`·`_upload_and_confirm_video`)도 이
파일에 필요하다 — cover-aspect-rejected 케이스가 영상을 먼저 첨부하기
때문(#3578류 커버 교체 분기 재현에 필수).

세팅 헬퍼는 test_620beefc_channel_post_image_upload.py(이미지)·test_3554_
instagram_reels.py(영상 MP4 픽스처+어댑터) 재사용(중복 재발명 금지)."""
from __future__ import annotations

import os

import pytest

from tests.test_620beefc_channel_post_image_upload import (
    _CHANNEL_MEDIA_BUCKET,
    _client_for,
    _create_draft,
    _jpeg_bytes,
    _object_path_for,
    _png_bytes,
    _put_raw_object,
    _seed_connection,
    _seed_human,
    _seed_org,
    _seed_story,
    _session_factory,
    _setup_org_scoped_app,
    _upload_and_confirm,
)
from tests.test_3554_instagram_reels import (
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


@pytest.fixture(autouse=True)
def _local_channel_media_storage(monkeypatch, tmp_path):
    """test_620beefc_channel_post_image_upload.py::_local_channel_media_storage와
    동형(다른 tmp_path로 격리) — importlib.reload 대신 monkeypatch.setattr로
    모듈 상수만 덮는 이유는 그 픽스처 docstring 참조(예외 클래스 정체성 함정)."""
    import app.services.channel_post_images as cpi_module

    monkeypatch.setenv("STORAGE_PROVIDER", "local")
    monkeypatch.setenv("STORAGE_LOCAL_ROOT", str(tmp_path / ".storage"))
    monkeypatch.setattr(cpi_module, "CHANNEL_MEDIA_BUCKET", _CHANNEL_MEDIA_BUCKET)
    monkeypatch.setattr(cpi_module, "_PUBLIC_BASE", f"https://storage.googleapis.com/{_CHANNEL_MEDIA_BUCKET}/")
    yield


@pytest.fixture(autouse=True)
def _instagram_sandbox_video_config(monkeypatch):
    """test_3554_instagram_reels.py와 동형 — sandbox video_* 어댑터 값 직접 주입."""
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


def _count_delete_object_calls(monkeypatch) -> list[str]:
    """LocalStorageProvider.delete_object 호출을 클래스 메서드 레벨에서 카운트
    (매 `get_storage_provider()` 호출이 새 인스턴스를 만들어 인스턴스 래핑은
    안 통한다) — 실 삭제 동작은 원본 그대로 수행(디스크 확認과 이중 검증)."""
    from app.services.storage.local import LocalStorageProvider

    calls: list[str] = []
    original = LocalStorageProvider.delete_object

    async def _counted(self, container: str, object_path: str) -> bool:
        calls.append(object_path)
        return await original(self, container, object_path)

    monkeypatch.setattr(LocalStorageProvider, "delete_object", _counted)
    return calls


async def _object_exists(object_path: str) -> bool:
    from app.services.storage import get_storage_provider

    size = await get_storage_provider().head_object(_CHANNEL_MEDIA_BUCKET, object_path)
    return size is not None


# ─── 이미지 거부 갈래 ─────────────────────────────────────────────────────────

@pytest.mark.anyio
async def test_image_confirm_undecodable_deletes_object(monkeypatch):
    from app.main import app

    delete_calls = _count_delete_object_calls(monkeypatch)
    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org_id, project_id = await _seed_org(s)
            human_id = await _seed_human(s, org_id, project_id)
            connection_id = await _seed_connection(s, org_id)
            story_id = await _seed_story(s, org_id, project_id)
        _setup_org_scoped_app(app, Session, org_id, user_id=human_id, agent=False)

        async with _client_for(app) as client:
            draft_id = await _create_draft(client, org_id=org_id, connection_id=connection_id, story_id=story_id)
            object_path = _object_path_for(org_id, draft_id, content_type="image/png")
            await _put_raw_object(object_path, b"not a real image at all", content_type="image/png")
            r = await client.post(
                f"/api/v2/organizations/{org_id}/channel-posts/drafts/{draft_id}/assets/confirm",
                json={"object_path": object_path},
            )
        assert r.status_code == 422, r.text
        assert r.json()["error"]["code"] == "CHANNEL_IMAGE_UNDECODABLE"
        assert delete_calls == [object_path]
        assert not await _object_exists(object_path)
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()


@pytest.mark.anyio
async def test_image_confirm_animated_unsupported_deletes_object(monkeypatch):
    from app.main import app

    delete_calls = _count_delete_object_calls(monkeypatch)
    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org_id, project_id = await _seed_org(s)
            human_id = await _seed_human(s, org_id, project_id)
            connection_id = await _seed_connection(s, org_id)
            story_id = await _seed_story(s, org_id, project_id)
        _setup_org_scoped_app(app, Session, org_id, user_id=human_id, agent=False)

        from PIL import Image
        import io

        frames = [Image.new("RGB", (100, 100), color=(i * 40, 0, 0)) for i in range(3)]
        buf = io.BytesIO()
        frames[0].save(buf, format="GIF", save_all=True, append_images=frames[1:], duration=100, loop=0)
        raw = buf.getvalue()

        async with _client_for(app) as client:
            draft_id = await _create_draft(client, org_id=org_id, connection_id=connection_id, story_id=story_id)
            object_path = _object_path_for(org_id, draft_id, content_type="image/png")
            await _put_raw_object(object_path, raw, content_type="image/gif")
            r = await client.post(
                f"/api/v2/organizations/{org_id}/channel-posts/drafts/{draft_id}/assets/confirm",
                json={"object_path": object_path},
            )
        assert r.status_code == 422, r.text
        assert r.json()["error"]["code"] == "CHANNEL_IMAGE_ANIMATED_UNSUPPORTED"
        assert delete_calls == [object_path]
        assert not await _object_exists(object_path)
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()


@pytest.mark.anyio
async def test_image_confirm_aspect_ratio_exceeded_deletes_object(monkeypatch):
    from app.main import app

    delete_calls = _count_delete_object_calls(monkeypatch)
    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org_id, project_id = await _seed_org(s)
            human_id = await _seed_human(s, org_id, project_id)
            connection_id = await _seed_connection(s, org_id)
            story_id = await _seed_story(s, org_id, project_id)
        _setup_org_scoped_app(app, Session, org_id, user_id=human_id, agent=False)

        async with _client_for(app) as client:
            draft_id = await _create_draft(client, org_id=org_id, connection_id=connection_id, story_id=story_id)
            raw = _png_bytes(2000, 100)  # 20:1 — threads image_aspect_max(10.0) 초과
            object_path = _object_path_for(org_id, draft_id, content_type="image/png")
            await _put_raw_object(object_path, raw, content_type="image/png")
            r = await client.post(
                f"/api/v2/organizations/{org_id}/channel-posts/drafts/{draft_id}/assets/confirm",
                json={"object_path": object_path},
            )
        assert r.status_code == 422, r.text
        assert r.json()["error"]["code"] == "CHANNEL_IMAGE_ASPECT_RATIO_EXCEEDED"
        assert delete_calls == [object_path]
        assert not await _object_exists(object_path)
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()


@pytest.mark.anyio
async def test_image_confirm_cover_aspect_rejected_deletes_object(monkeypatch):
    """story #3578류 — 영상 이미 붙은 draft에 커버(이미지) confirm, 영상 규격과
    안 맞는 비율 → 422 CHANNEL_COVER_ASPECT_RATIO_REJECTED. 이 갈래도 원래
    delete_object가 없었다(#3589 결함 클래스 동일)."""
    from app.main import app

    delete_calls = _count_delete_object_calls(monkeypatch)
    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org_id, project_id = await _seed_org(s)
            human_id = await _seed_human(s, org_id, project_id)
            connection_id = await _seed_connection(s, org_id, channel="instagram_sandbox")
            story_id = await _seed_story(s, org_id, project_id)
        _setup_org_scoped_app(app, Session, org_id, user_id=human_id, agent=False)

        async with _client_for(app) as client:
            draft_id = await _create_draft(client, org_id=org_id, connection_id=connection_id, story_id=story_id)
            r_video = await _upload_and_confirm_video(
                client, org_id, draft_id, _build_mp4(duration_seconds=10.0, **_VALID_9_16),
            )
            assert r_video.status_code == 201, r_video.text

            # 커버(이미지) — 9:16이 아닌 정방형으로 넣어 비율 거부 유도.
            raw = _jpeg_bytes(800, 800)
            object_path = _object_path_for(org_id, draft_id, content_type="image/jpeg")
            await _put_raw_object(object_path, raw, content_type="image/jpeg")
            r = await client.post(
                f"/api/v2/organizations/{org_id}/channel-posts/drafts/{draft_id}/assets/confirm",
                json={"object_path": object_path},
            )
        assert r.status_code == 422, r.text
        assert r.json()["error"]["code"] == "CHANNEL_COVER_ASPECT_RATIO_REJECTED"
        assert delete_calls == [object_path]
        assert not await _object_exists(object_path)
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()


@pytest.mark.anyio
async def test_image_confirm_success_does_not_delete_object(monkeypatch):
    """성공 갈래 — delete_object 0회."""
    from app.main import app

    delete_calls = _count_delete_object_calls(monkeypatch)
    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org_id, project_id = await _seed_org(s)
            human_id = await _seed_human(s, org_id, project_id)
            connection_id = await _seed_connection(s, org_id)
            story_id = await _seed_story(s, org_id, project_id)
        _setup_org_scoped_app(app, Session, org_id, user_id=human_id, agent=False)

        async with _client_for(app) as client:
            draft_id = await _create_draft(client, org_id=org_id, connection_id=connection_id, story_id=story_id)
            r = await _upload_and_confirm(client, org_id, draft_id, _png_bytes(800, 600), content_type="image/png")
        assert r.status_code == 201, r.text
        assert delete_calls == []
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()
