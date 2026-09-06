"""story #3554(Phase2·마케팅운영, 페드루 PO 確定 2026-09-06) — Instagram 릴스(영상)
발행. PO 못박음 5가지:
① 어댑터 규격 선언(video_max_bytes·video_max_seconds/min_seconds·video_aspect_
   target/tolerance·video_codecs).
② 업로드는 3425 경로 재사용(signed URL→confirm)+sha256. 커버는 기존 이미지
   파이프 재사용(별개 테이블 X).
③ 봉인 합성 해시 `[video_sha256, cover_sha256 or ""]`(순서 고정) — 커버
   추가/제거/교체 전부 재승인.
④ `create_reels_container`(media_type=REELS)+processing 폴링(3539 축 재사용).
⑤ sandbox 마커(processing-failed·codec-rejected).

MP4 픽스처는 실 ffmpeg 없이 순수 파이썬으로 최소 유효 ISOBMFF 박스 트리를
직접 조립한다(파서가 실제로 요구하는 필드만 — moov/mvhd·trak/mdia/hdlr·
trak/tkhd·trak/mdia/minf/stbl/stsd, mdat은 더미).

세팅 헬퍼는 test_620beefc_channel_post_image_upload.py 재사용(중복 재발명 금지)."""
from __future__ import annotations

import os
import struct
import uuid

import pytest

from tests.test_620beefc_channel_post_image_upload import (
    _approve_gate_directly,
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


_CHANNEL_MEDIA_BUCKET = "test-channel-media-3554"


@pytest.fixture(autouse=True)
def _local_channel_media_storage(monkeypatch, tmp_path):
    """test_3550_instagram_carousel.py와 동형 픽스처(다른 버킷명으로 격리)."""
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
    """test_3550_instagram_carousel.py::_instagram_sandbox_ten_images와 동형 —
    SANDBOX_CHANNEL_ENABLED 조건부 블록에 기대지 않고 이 테스트 파일이 필요로
    하는 정확한 video_* 값을 직접 주입한다(import 순서 무관하게 결정적)."""
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


# ─── MP4(ISOBMFF) 최소 유효 픽스처 조립 ──────────────────────────────────────


def _box(box_type: bytes, payload: bytes) -> bytes:
    return struct.pack(">I", 8 + len(payload)) + box_type + payload


def _build_mvhd(*, timescale: int, duration: int) -> bytes:
    payload = b"\x00\x00\x00\x00"  # version(0)+flags
    payload += struct.pack(">I", 0)  # creation_time
    payload += struct.pack(">I", 0)  # modification_time
    payload += struct.pack(">I", timescale)
    payload += struct.pack(">I", duration)
    return _box(b"mvhd", payload)


def _build_tkhd(*, width: int, height: int) -> bytes:
    payload = b"\x00\x00\x00\x00"  # version(0)+flags
    payload += struct.pack(">I", 0)  # creation_time
    payload += struct.pack(">I", 0)  # modification_time
    payload += struct.pack(">I", 1)  # track_ID
    payload += struct.pack(">I", 0)  # reserved
    payload += struct.pack(">I", 0)  # duration
    payload += b"\x00" * 8  # reserved
    payload += b"\x00" * 2  # layer
    payload += b"\x00" * 2  # alternate_group
    payload += b"\x00" * 2  # volume
    payload += b"\x00" * 2  # reserved
    payload += b"\x00" * 36  # matrix
    payload += struct.pack(">I", width << 16)
    payload += struct.pack(">I", height << 16)
    return _box(b"tkhd", payload)


def _build_hdlr(handler_type: bytes) -> bytes:
    payload = b"\x00\x00\x00\x00"  # version(0)+flags
    payload += struct.pack(">I", 0)  # pre_defined
    payload += handler_type
    payload += b"\x00" * 12  # reserved
    payload += b"\x00"  # name(빈 문자열, null-terminated)
    return _box(b"hdlr", payload)


def _build_stsd(fourcc: bytes) -> bytes:
    payload = b"\x00\x00\x00\x00"  # version(0)+flags
    payload += struct.pack(">I", 1)  # entry_count
    payload += struct.pack(">I", 16)  # entry size(임의 — 파서는 fourcc만 읽는다)
    payload += fourcc
    return _box(b"stsd", payload)


def _build_trak(*, width: int, height: int, handler_type: bytes, fourcc: bytes) -> bytes:
    tkhd = _build_tkhd(width=width, height=height)
    hdlr = _build_hdlr(handler_type)
    stsd = _build_stsd(fourcc)
    stbl = _box(b"stbl", stsd)
    minf = _box(b"minf", stbl)
    mdia = _box(b"mdia", hdlr + minf)
    return _box(b"trak", tkhd + mdia)


def _build_mp4(
    *, duration_seconds: float, width: int, height: int, codec: bytes = b"avc1",
    timescale: int = 600, include_audio_track: bool = False,
) -> bytes:
    duration = round(duration_seconds * timescale)
    mvhd = _build_mvhd(timescale=timescale, duration=duration)
    video_trak = _build_trak(width=width, height=height, handler_type=b"vide", fourcc=codec)
    traks = video_trak
    if include_audio_track:
        audio_trak = _build_trak(width=0, height=0, handler_type=b"soun", fourcc=b"mp4a")
        traks = audio_trak + video_trak  # 오디오 먼저 — 비디오 트랙 선택이 이걸 건너뛰는지 검증
    moov = _box(b"moov", mvhd + traks)
    ftyp = _box(b"ftyp", b"isom" + struct.pack(">I", 0) + b"isomiso2avc1mp41")
    mdat = _box(b"mdat", b"\x00" * 16)  # 더미(파서가 안 읽음)
    return ftyp + moov + mdat


_CHANNEL_MEDIA_OBJECT_EXT: dict[str, str] = {"video/mp4": "mp4", "video/quicktime": "mov"}


def _object_path_for_video(org_id, draft_id, *, content_type: str = "video/mp4") -> str:
    ext = _CHANNEL_MEDIA_OBJECT_EXT.get(content_type, "bin")
    return f"channel-media/{org_id}/{draft_id}/{uuid.uuid4().hex}.{ext}"


async def _upload_and_confirm_video(client, org_id, draft_id, raw: bytes, *, content_type: str = "video/mp4"):
    object_path = _object_path_for_video(org_id, draft_id, content_type=content_type)
    await _put_raw_object(object_path, raw, content_type=content_type)
    return await client.post(
        f"/api/v2/organizations/{org_id}/channel-posts/drafts/{draft_id}/assets/video/confirm",
        json={"object_path": object_path},
    )


_VALID_9_16 = {"width": 720, "height": 1280}  # 720/1280 = 0.5625 = 9/16 정확히.


# ─── ① 파서 단위(순수 함수, DB 불요) ─────────────────────────────────────────


def test_parse_mp4_metadata_reads_duration_width_height_codec():
    from app.services.channel_post_videos import parse_mp4_metadata

    raw = _build_mp4(duration_seconds=10.0, width=720, height=1280, codec=b"avc1")
    meta = parse_mp4_metadata(raw)
    assert meta.duration_seconds == pytest.approx(10.0, abs=0.01)
    assert (meta.width, meta.height) == (720, 1280)
    assert meta.codec == "avc1"


def test_parse_mp4_metadata_skips_audio_track_picks_video():
    from app.services.channel_post_videos import parse_mp4_metadata

    raw = _build_mp4(duration_seconds=5.0, width=720, height=1280, codec=b"hvc1", include_audio_track=True)
    meta = parse_mp4_metadata(raw)
    assert meta.codec == "hvc1"
    assert (meta.width, meta.height) == (720, 1280)


def test_parse_mp4_metadata_missing_moov_raises_unparsable():
    from app.services.channel_post_videos import ChannelVideoUnparsableError, parse_mp4_metadata

    raw = _box(b"ftyp", b"isom") + _box(b"mdat", b"\x00" * 8)
    with pytest.raises(ChannelVideoUnparsableError):
        parse_mp4_metadata(raw)


def test_parse_mp4_metadata_corrupt_bytes_raises_unparsable():
    from app.services.channel_post_videos import ChannelVideoUnparsableError, parse_mp4_metadata

    with pytest.raises(ChannelVideoUnparsableError):
        parse_mp4_metadata(b"not an mp4 file at all, just garbage bytes")


def test_parse_mp4_metadata_moov_size_lies_past_buffer_end_raises_unparsable():
    """박스 size 필드가 실제 버퍼 길이를 넘어서게 거짓말하면(잘림·손상 파일의
    전형적 신호) fail-closed로 거부해야 한다 — 조용히 잘라 읽으면 안 된다."""
    from app.services.channel_post_videos import ChannelVideoUnparsableError, parse_mp4_metadata

    lying_moov = struct.pack(">I", 10_000) + b"moov" + b"\x00" * 4  # size=10000인데 실제론 12바이트뿐
    with pytest.raises(ChannelVideoUnparsableError):
        parse_mp4_metadata(lying_moov)


# ─── ①③ 업로드 확인+규격 검증 ────────────────────────────────────────────────


@pytest.mark.anyio
async def test_video_upload_confirm_success_stores_metadata_and_composite_seal():
    from app.main import app
    from app.models.channel_post_version import ChannelPostVersion
    from app.services.channel_post_images import compute_image_seal_hash
    from sqlalchemy import select

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
            raw = _build_mp4(duration_seconds=6.0, **_VALID_9_16)
            r = await _upload_and_confirm_video(client, org_id, draft_id, raw)
        assert r.status_code == 201, r.text
        body = r.json()
        assert body["duration_seconds"] == pytest.approx(6.0, abs=0.01)
        assert (body["width"], body["height"]) == (720, 1280)
        assert body["codec"] == "avc1"

        video_sha256 = __import__("hashlib").sha256(raw).hexdigest()
        async with Session() as s:
            version = (await s.execute(
                select(ChannelPostVersion).where(ChannelPostVersion.id == uuid.UUID(body["version_id"]))
            )).scalar_one()
        assert version.image_sha256 == compute_image_seal_hash([video_sha256, ""])
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()


@pytest.mark.anyio
async def test_video_duration_exceeded_rejected_422():
    from app.main import app

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
            raw = _build_mp4(duration_seconds=95.0, **_VALID_9_16)
            r = await _upload_and_confirm_video(client, org_id, draft_id, raw)
        assert r.status_code == 422, r.text
        assert r.json()["error"]["code"] == "CHANNEL_VIDEO_DURATION_EXCEEDED"
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()


@pytest.mark.anyio
async def test_video_duration_too_short_rejected_422():
    from app.main import app

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
            raw = _build_mp4(duration_seconds=1.0, **_VALID_9_16)
            r = await _upload_and_confirm_video(client, org_id, draft_id, raw)
        assert r.status_code == 422, r.text
        assert r.json()["error"]["code"] == "CHANNEL_VIDEO_DURATION_TOO_SHORT"
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()


@pytest.mark.anyio
async def test_video_aspect_ratio_rejected_422():
    from app.main import app

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
            raw = _build_mp4(duration_seconds=10.0, width=1000, height=1000)  # 1:1, 목표 0.5625와 크게 벗어남
            r = await _upload_and_confirm_video(client, org_id, draft_id, raw)
        assert r.status_code == 422, r.text
        assert r.json()["error"]["code"] == "CHANNEL_VIDEO_ASPECT_RATIO_REJECTED"
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()


@pytest.mark.anyio
async def test_video_codec_unsupported_rejected_422():
    from app.main import app

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
            raw = _build_mp4(duration_seconds=10.0, codec=b"mp4v", **_VALID_9_16)
            r = await _upload_and_confirm_video(client, org_id, draft_id, raw)
        assert r.status_code == 422, r.text
        assert r.json()["error"]["code"] == "CHANNEL_VIDEO_CODEC_UNSUPPORTED"
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()


@pytest.mark.anyio
async def test_video_corrupt_upload_rejected_422_unparsable():
    from app.main import app

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
            r = await _upload_and_confirm_video(client, org_id, draft_id, b"garbage not mp4")
        assert r.status_code == 422, r.text
        assert r.json()["error"]["code"] == "CHANNEL_VIDEO_UNPARSABLE"
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()


# ─── ②③ 커버(기존 이미지 파이프 재사용)·carry-forward ───────────────────────


@pytest.mark.anyio
async def test_cover_attach_after_video_computes_composite_and_replaces_not_appends():
    """PO 明示 ③ — 커버는 별개 이미지 에셋(기존 파이프)이지만 캐러셀처럼 "추가"
    되지 않고 "교체"된다(항상 position=0 슬롯 하나). 두 번째 커버 첨부 뒤에도
    이미지 행이 정확히 1개여야 한다."""
    from app.main import app
    from app.models.channel_post_image import ChannelPostImage
    from app.models.channel_post_version import ChannelPostVersion
    from app.services.channel_post_images import compute_image_seal_hash
    from sqlalchemy import select

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
            video_raw = _build_mp4(duration_seconds=6.0, **_VALID_9_16)
            r_video = await _upload_and_confirm_video(client, org_id, draft_id, video_raw)
            assert r_video.status_code == 201, r_video.text
            video_sha256 = __import__("hashlib").sha256(video_raw).hexdigest()

            cover1_raw = _jpeg_bytes(800, 1000, color=(10, 20, 30))
            r_cover1 = await _upload_and_confirm(client, org_id, draft_id, cover1_raw, content_type="image/jpeg")
            assert r_cover1.status_code == 201, r_cover1.text
            version1_id = r_cover1.json()["version_id"]

        async with Session() as s:
            images_v1 = list((await s.execute(
                select(ChannelPostImage).where(ChannelPostImage.version_id == uuid.UUID(version1_id))
            )).scalars().all())
            version1 = (await s.execute(
                select(ChannelPostVersion).where(ChannelPostVersion.id == uuid.UUID(version1_id))
            )).scalar_one()
        assert len(images_v1) == 1
        assert images_v1[0].position == 0
        assert version1.image_sha256 == compute_image_seal_hash([video_sha256, images_v1[0].final_sha256])

        async with _client_for(app) as client:
            cover2_raw = _jpeg_bytes(800, 1000, color=(200, 210, 220))
            r_cover2 = await _upload_and_confirm(client, org_id, draft_id, cover2_raw, content_type="image/jpeg")
            assert r_cover2.status_code == 201, r_cover2.text
            version2_id = r_cover2.json()["version_id"]

        async with Session() as s:
            images_v2 = list((await s.execute(
                select(ChannelPostImage).where(ChannelPostImage.version_id == uuid.UUID(version2_id))
            )).scalars().all())
            version2 = (await s.execute(
                select(ChannelPostVersion).where(ChannelPostVersion.id == uuid.UUID(version2_id))
            )).scalar_one()
        assert len(images_v2) == 1, "커버는 교체다 — 두 번째 첨부 뒤에도 이미지 행은 1개여야 한다"
        assert images_v2[0].position == 0
        assert version2.image_sha256 == compute_image_seal_hash([video_sha256, images_v2[0].final_sha256])
        assert version2.image_sha256 != version1.image_sha256, "커버 교체가 봉인을 안 깼다"
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()


@pytest.mark.anyio
async def test_text_only_edit_after_video_and_cover_carries_forward_both():
    from app.main import app
    from app.models.channel_post_image import ChannelPostImage
    from app.models.channel_post_version import ChannelPostVersion
    from app.services.channel_post_videos import get_channel_post_video_for_version
    from sqlalchemy import select

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
            video_raw = _build_mp4(duration_seconds=6.0, **_VALID_9_16)
            await _upload_and_confirm_video(client, org_id, draft_id, video_raw)
            cover_raw = _jpeg_bytes(800, 1000)
            r_cover = await _upload_and_confirm(client, org_id, draft_id, cover_raw, content_type="image/jpeg")
            assert r_cover.status_code == 201, r_cover.text
            version_before_id = r_cover.json()["version_id"]

            # 텍스트만 편집(같은 connection_id·work_item_id → 같은 draft, image_sha256
            # 인자 생략 → sentinel 경로 → 영상·커버 둘 다 캐리포워드돼야 한다).
            r_edit = await client.post(
                f"/api/v2/organizations/{org_id}/channel-posts/drafts",
                json={"work_item_id": str(story_id), "connection_id": str(connection_id), "text": "본문만 편집했습니다"},
            )
            assert r_edit.status_code == 201, r_edit.text
            version_after_id = r_edit.json()["version_id"]

        async with Session() as s:
            before = (await s.execute(
                select(ChannelPostVersion).where(ChannelPostVersion.id == uuid.UUID(version_before_id))
            )).scalar_one()
            after = (await s.execute(
                select(ChannelPostVersion).where(ChannelPostVersion.id == uuid.UUID(version_after_id))
            )).scalar_one()
            after_video = await get_channel_post_video_for_version(s, version_id=after.id)
            after_images = list((await s.execute(
                select(ChannelPostImage).where(ChannelPostImage.version_id == after.id)
            )).scalars().all())
        assert after_video is not None, "텍스트 편집이 영상을 떨어뜨렸다"
        assert len(after_images) == 1, "텍스트 편집이 커버를 떨어뜨렸다"
        assert after.image_sha256 == before.image_sha256, "캐리포워드인데 봉인이 바뀌었다"
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()


# ─── ④ REELS 컨테이너 발행(sandbox, 종단) ───────────────────────────────────


@pytest.mark.anyio
async def test_publish_dispatches_to_reels_container_for_video_instagram_sandbox():
    from app.main import app
    from app.models.channel_publication import ChannelPublication
    from sqlalchemy import select as sa_select

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org_id, project_id = await _seed_org(s)
            human_id = await _seed_human(s, org_id, project_id)
            connection_id = await _seed_connection(s, org_id, channel="instagram_sandbox")
            story_id = await _seed_story(s, org_id, project_id)
            from app.models.participation import ParticipationRole
            role = ParticipationRole(id=uuid.uuid4(), org_id=org_id, key="approver", label="Approver", is_default=True)
            s.add(role)
            await s.commit()
        _setup_org_scoped_app(app, Session, org_id, user_id=human_id, agent=False)

        async with _client_for(app) as client:
            draft_id = await _create_draft(client, org_id=org_id, connection_id=connection_id, story_id=story_id)
            video_raw = _build_mp4(duration_seconds=6.0, **_VALID_9_16)
            r_video = await _upload_and_confirm_video(client, org_id, draft_id, video_raw)
            assert r_video.status_code == 201, r_video.text
            version_id = r_video.json()["version_id"]

            r_submit = await client.post(
                f"/api/v2/organizations/{org_id}/channel-posts/drafts/{draft_id}/submit",
                json={"version_id": version_id},
            )
            assert r_submit.status_code == 200, r_submit.text
            gate_id = r_submit.json()["gate_id"]

        async with Session() as s:
            await _approve_gate_directly(s, uuid.UUID(gate_id))

        async with _client_for(app) as client:
            r_publish_1 = await client.post(
                f"/api/v2/organizations/{org_id}/channel-posts/drafts/{draft_id}/publish",
            )
            assert r_publish_1.status_code == 200, r_publish_1.text
            assert r_publish_1.json()["processing"] is True

        async with Session() as s:
            pub = (await s.execute(
                sa_select(ChannelPublication).where(ChannelPublication.version_id == uuid.UUID(version_id))
            )).scalar_one()
        assert pub.external_container_id is not None and pub.external_container_id.startswith("sandbox-ig-reels-"), (
            "REELS 컨테이너가 아니라 다른 경로(IMAGE/CAROUSEL)로 샜다"
        )

        async with _client_for(app) as client:
            r_publish_2 = await client.post(
                f"/api/v2/organizations/{org_id}/channel-posts/drafts/{draft_id}/publish",
            )
        assert r_publish_2.status_code == 200, r_publish_2.text
        body = r_publish_2.json()
        assert body["processing"] is False
        assert body["external_id"] is not None and body["external_id"].startswith("sandbox-ig-media-")
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()
