"""story #3559(Phase2·BE·소형, 페드루 PO 確定 2026-09-06) — #3554 후속. PO 확定 2가지:
① 연결 응답(`ChannelConnectionResponse`/`_to_response()`)에 어댑터가 이미 선언한
   영상 규격 6종을 image_* 6종과 동형 관례로 노출(additive) — 미지원 채널은 0/0.0/[].
② draft 상세(`ChannelPostDraftListItem.video_url`)에 최신 버전의 영상 원본 공개
   URL을 additive로 싣는다 — violations와 동형(단건 전용, N+1 방지로 목록엔 항상
   None).

세팅 헬퍼는 test_620beefc_channel_post_image_upload.py 재사용, MP4 픽스처 조립은
test_3554_instagram_reels.py의 순수 파이썬 박스 빌더 재사용(중복 재발명 금지).
instagram_sandbox가 아니라 **instagram**(실 어댑터, 조건부 등재 불요)을 쓴다 —
video_* 검증엔 sandbox 마커·조건부 config 주입이 불필요."""
from __future__ import annotations

import os
import struct
import uuid

import pytest

from tests.test_620beefc_channel_post_image_upload import (
    _client_for,
    _create_draft,
    _jpeg_bytes,
    _put_raw_object,
    _seed_connection,
    _seed_human,
    _seed_org,
    _seed_story,
    _session_factory,
    _setup_org_scoped_app,
    _upload_and_confirm,
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


_CHANNEL_MEDIA_BUCKET = "test-channel-media-3559"


@pytest.fixture(autouse=True)
def _local_channel_media_storage(monkeypatch, tmp_path):
    """test_3554_instagram_reels.py와 동형 픽스처(다른 버킷명으로 격리)."""
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


# ─── MP4(ISOBMFF) 최소 유효 픽스처 조립 — test_3554_instagram_reels.py와 동형 ────


def _box(box_type: bytes, payload: bytes) -> bytes:
    return struct.pack(">I", 8 + len(payload)) + box_type + payload


def _build_mvhd(*, timescale: int, duration: int) -> bytes:
    payload = b"\x00\x00\x00\x00" + struct.pack(">I", 0) * 2 + struct.pack(">I", timescale) + struct.pack(">I", duration)
    return _box(b"mvhd", payload)


def _build_tkhd(*, width: int, height: int) -> bytes:
    payload = b"\x00\x00\x00\x00" + struct.pack(">I", 0) * 5
    payload += b"\x00" * 8 + b"\x00" * 2 * 4 + b"\x00" * 36
    payload += struct.pack(">I", width << 16) + struct.pack(">I", height << 16)
    return _box(b"tkhd", payload)


def _build_hdlr(handler_type: bytes) -> bytes:
    payload = b"\x00\x00\x00\x00" + struct.pack(">I", 0) + handler_type + b"\x00" * 12 + b"\x00"
    return _box(b"hdlr", payload)


def _build_stsd(fourcc: bytes) -> bytes:
    payload = b"\x00\x00\x00\x00" + struct.pack(">I", 1) + struct.pack(">I", 16) + fourcc
    return _box(b"stsd", payload)


def _build_trak(*, width: int, height: int, handler_type: bytes, fourcc: bytes) -> bytes:
    m = _box(b"mdia", _build_hdlr(handler_type) + _box(b"minf", _box(b"stbl", _build_stsd(fourcc))))
    return _box(b"trak", _build_tkhd(width=width, height=height) + m)


def _build_mp4(*, duration_seconds: float, width: int, height: int, codec: bytes = b"avc1", timescale: int = 600) -> bytes:
    duration = round(duration_seconds * timescale)
    moov = _box(b"moov", _build_mvhd(timescale=timescale, duration=duration) + _build_trak(
        width=width, height=height, handler_type=b"vide", fourcc=codec,
    ))
    ftyp = _box(b"ftyp", b"isom" + struct.pack(">I", 0) + b"isomiso2avc1mp41")
    return ftyp + moov + _box(b"mdat", b"\x00" * 16)


async def _upload_and_confirm_video(client, org_id, draft_id, raw: bytes, *, content_type: str = "video/mp4"):
    ext = {"video/mp4": "mp4", "video/quicktime": "mov"}.get(content_type, "bin")
    object_path = f"channel-media/{org_id}/{draft_id}/{uuid.uuid4().hex}.{ext}"
    await _put_raw_object(object_path, raw, content_type=content_type)
    return await client.post(
        f"/api/v2/organizations/{org_id}/channel-posts/drafts/{draft_id}/assets/video/confirm",
        json={"object_path": object_path},
    )


_VALID_9_16 = {"width": 720, "height": 1280}


# ─── ① 연결 응답 video_* 6종 ─────────────────────────────────────────────────


@pytest.mark.anyio
async def test_connection_response_exposes_instagram_video_spec():
    from app.main import app

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org_id, project_id = await _seed_org(s)
            human_id = await _seed_human(s, org_id, project_id)
            await _seed_connection(s, org_id, channel="instagram")

        _setup_org_scoped_app(app, Session, org_id, user_id=human_id, agent=False)
        async with _client_for(app) as client:
            r = await client.get(f"/api/v2/organizations/{org_id}/channel-connections")
        assert r.status_code == 200, r.text
        row = r.json()[0]
        assert row["video_max_bytes"] == 100 * 1024 * 1024
        assert row["video_max_seconds"] == 90.0
        assert row["video_min_seconds"] == 3.0
        assert row["video_aspect_target"] == pytest.approx(9 / 16)
        assert row["video_aspect_tolerance"] == 0.05
        assert row["video_codecs"] == ["avc1", "hvc1", "hev1"]
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()


@pytest.mark.anyio
async def test_connection_response_video_unsupported_channel_returns_zero_defaults():
    """threads는 영상 미선언(video_max_bytes=0) — image_* 관례(§17-16) 그대로
    0/0.0/[](null이 아니다 — "0건 허용"과 "모른다"는 다르다)."""
    from app.main import app

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org_id, project_id = await _seed_org(s)
            human_id = await _seed_human(s, org_id, project_id)
            await _seed_connection(s, org_id, channel="threads")

        _setup_org_scoped_app(app, Session, org_id, user_id=human_id, agent=False)
        async with _client_for(app) as client:
            r = await client.get(f"/api/v2/organizations/{org_id}/channel-connections")
        assert r.status_code == 200, r.text
        row = r.json()[0]
        assert row["video_max_bytes"] == 0
        assert row["video_max_seconds"] == 0.0
        assert row["video_min_seconds"] == 0.0
        assert row["video_aspect_target"] == 0.0
        assert row["video_aspect_tolerance"] == 0.0
        assert row["video_codecs"] == []
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()


# ─── ② draft 상세 video_url additive ─────────────────────────────────────────


@pytest.mark.anyio
async def test_draft_detail_video_url_present_when_video_confirmed():
    from app.main import app

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org_id, project_id = await _seed_org(s)
            human_id = await _seed_human(s, org_id, project_id)
            connection_id = await _seed_connection(s, org_id, channel="instagram")
            story_id = await _seed_story(s, org_id, project_id)

        _setup_org_scoped_app(app, Session, org_id, user_id=human_id, agent=False)
        async with _client_for(app) as client:
            draft_id = await _create_draft(client, org_id=org_id, connection_id=connection_id, story_id=story_id)
            raw = _build_mp4(duration_seconds=6.0, **_VALID_9_16)
            r_video = await _upload_and_confirm_video(client, org_id, draft_id, raw)
            assert r_video.status_code == 201, r_video.text
            expected_video_url = r_video.json()["video_url"]
            assert expected_video_url is not None

            r_detail = await client.get(f"/api/v2/organizations/{org_id}/channel-posts/drafts/{draft_id}")
        assert r_detail.status_code == 200, r_detail.text
        assert r_detail.json()["video_url"] == expected_video_url
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()


@pytest.mark.anyio
async def test_draft_detail_video_url_null_when_no_media():
    from app.main import app

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org_id, project_id = await _seed_org(s)
            human_id = await _seed_human(s, org_id, project_id)
            connection_id = await _seed_connection(s, org_id, channel="instagram")
            story_id = await _seed_story(s, org_id, project_id)

        _setup_org_scoped_app(app, Session, org_id, user_id=human_id, agent=False)
        async with _client_for(app) as client:
            draft_id = await _create_draft(client, org_id=org_id, connection_id=connection_id, story_id=story_id)
            r_detail = await client.get(f"/api/v2/organizations/{org_id}/channel-posts/drafts/{draft_id}")
        assert r_detail.status_code == 200, r_detail.text
        assert r_detail.json()["video_url"] is None
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()


@pytest.mark.anyio
async def test_draft_detail_video_url_null_when_only_image_attached():
    """이미지만 있는 draft(썸네일=커버 이미지 파이프 재사용)도 video_url은 null —
    thumbnail_url과 video_url은 서로 다른 축(이미지 vs 영상)이라 섞이면 안 된다."""
    from app.main import app

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org_id, project_id = await _seed_org(s)
            human_id = await _seed_human(s, org_id, project_id)
            connection_id = await _seed_connection(s, org_id, channel="instagram")
            story_id = await _seed_story(s, org_id, project_id)

        _setup_org_scoped_app(app, Session, org_id, user_id=human_id, agent=False)
        async with _client_for(app) as client:
            draft_id = await _create_draft(client, org_id=org_id, connection_id=connection_id, story_id=story_id)
            raw = _jpeg_bytes(800, 1000)
            r_image = await _upload_and_confirm(client, org_id, draft_id, raw, content_type="image/jpeg")
            assert r_image.status_code == 201, r_image.text
            assert r_image.json()["image_url"] is not None

            r_detail = await client.get(f"/api/v2/organizations/{org_id}/channel-posts/drafts/{draft_id}")
        assert r_detail.status_code == 200, r_detail.text
        body = r_detail.json()
        assert body["thumbnail_url"] is not None
        assert body["video_url"] is None
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()


@pytest.mark.anyio
async def test_list_endpoint_never_leaks_video_url_even_with_video_confirmed():
    """N+1 방지(story #3559 明示) — video_url은 목록 응답엔 항상 None(violations와
    동형 관례). 영상이 실제로 confirm돼 있어도 목록 쿼리는 그 값을 안 채운다."""
    from app.main import app

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org_id, project_id = await _seed_org(s)
            human_id = await _seed_human(s, org_id, project_id)
            connection_id = await _seed_connection(s, org_id, channel="instagram")
            story_id = await _seed_story(s, org_id, project_id)

        _setup_org_scoped_app(app, Session, org_id, user_id=human_id, agent=False)
        async with _client_for(app) as client:
            draft_id = await _create_draft(client, org_id=org_id, connection_id=connection_id, story_id=story_id)
            raw = _build_mp4(duration_seconds=6.0, **_VALID_9_16)
            r_video = await _upload_and_confirm_video(client, org_id, draft_id, raw)
            assert r_video.status_code == 201, r_video.text

            r_list = await client.get(f"/api/v2/organizations/{org_id}/channel-posts/drafts")
        assert r_list.status_code == 200, r_list.text
        rows = r_list.json()
        assert len(rows) == 1
        assert rows[0]["video_url"] is None
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()


# ─── story #3590: draft 상세 video_meta additive(재진입에서도 남는다) ───────────


@pytest.mark.anyio
async def test_draft_detail_video_meta_present_when_video_confirmed():
    """유나 §17-23 ⑤-1 정정 — 업로드 직후뿐 아니라 재진입(단건 재조회)에서도
    메타 줄(길이·해상도·코덱·용량)이 같은 값으로 서야 한다. video_url과 같은
    video_row 재사용(추가 쿼리 0) — confirm 응답과 정확히 같은 값이어야 FE
    formatVideoMetaLine이 두 응답을 같은 코드로 처리할 수 있다."""
    from app.main import app

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org_id, project_id = await _seed_org(s)
            human_id = await _seed_human(s, org_id, project_id)
            connection_id = await _seed_connection(s, org_id, channel="instagram")
            story_id = await _seed_story(s, org_id, project_id)

        _setup_org_scoped_app(app, Session, org_id, user_id=human_id, agent=False)
        async with _client_for(app) as client:
            draft_id = await _create_draft(client, org_id=org_id, connection_id=connection_id, story_id=story_id)
            raw = _build_mp4(duration_seconds=6.0, **_VALID_9_16)
            r_video = await _upload_and_confirm_video(client, org_id, draft_id, raw)
            assert r_video.status_code == 201, r_video.text
            confirm_body = r_video.json()

            # 재진입 — 새 GET 왕복(업로드 직후 응답이 아니라 별개 단건 재조회).
            r_detail = await client.get(f"/api/v2/organizations/{org_id}/channel-posts/drafts/{draft_id}")
        assert r_detail.status_code == 200, r_detail.text
        video_meta = r_detail.json()["video_meta"]
        assert video_meta is not None
        assert video_meta["duration_seconds"] == confirm_body["duration_seconds"]
        assert video_meta["width"] == confirm_body["width"]
        assert video_meta["height"] == confirm_body["height"]
        assert video_meta["codec"] == confirm_body["codec"]
        assert video_meta["original_bytes"] == confirm_body["original_bytes"]
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()


@pytest.mark.anyio
async def test_draft_detail_video_meta_null_when_no_media():
    from app.main import app

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org_id, project_id = await _seed_org(s)
            human_id = await _seed_human(s, org_id, project_id)
            connection_id = await _seed_connection(s, org_id, channel="instagram")
            story_id = await _seed_story(s, org_id, project_id)

        _setup_org_scoped_app(app, Session, org_id, user_id=human_id, agent=False)
        async with _client_for(app) as client:
            draft_id = await _create_draft(client, org_id=org_id, connection_id=connection_id, story_id=story_id)
            r_detail = await client.get(f"/api/v2/organizations/{org_id}/channel-posts/drafts/{draft_id}")
        assert r_detail.status_code == 200, r_detail.text
        assert r_detail.json()["video_meta"] is None
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()
