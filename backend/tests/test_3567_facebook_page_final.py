"""story #3567(Phase2·BE, 페드루 PO 確定 2026-09-06) — Facebook Page 발행 마지막
조각. 3547(Page 연결·단일 발행)이 이미 있는 상태에서 남은 두 조각:

① 다중 사진(캐러셀 동형, 2~10장) — `facebook_publish.py::create_carousel_container`
   가 N회 `/{page-id}/photos?published=false`(자식, 미발행) → 1회 `/{page-id}/feed
   attached_media[]`(부모=**실제 발행**, facebook_publish.py의 "단일 콜=이미 끝남"
   계약과 정합)로 구현. 자식 하나 실패=부모(=발행) 호출 자체가 안 일어난다(원자성).
② Page 릴스(영상 1+커버 1) — `create_reels_container`가 `/video_reels` start→
   upload→finish 3단(Facebook 최초의 진짜 비동기 경로). `get_container_status`는
   media_type을 인자로 안 받고 실 응답에 `status` 필드 유무로 분간(사진/피드=계속
   즉시 FINISHED·릴스만 진짜 폴링).
③ 어댑터 선언 확장 — `image_max_count=10`(제품 상한, Meta 실측 아님)·video_* 6종
   (Instagram 값 동형+«미확認»). `channel_connections.py::_to_response()`(story
   #3559)가 이미 제네릭이라 연결 응답에 코드 변경 0으로 노출.
④ `facebook_sandbox_publish.py` — instagram_sandbox_publish.py와 **같은 마커
   문자열**(`[sandbox:carousel-child-{n}-failed]`·`[sandbox:reels-processing-
   failed]`·`[sandbox:reels-codec-rejected]`)로 결정적 미러.
⑤ channel_posts.py는 **무변경**(오케스트레이션이 `getattr(_publish_client, ...)`
   duck-typing으로 이미 채널 무관 — facebook_publish.py/facebook_sandbox_publish.py
   에 같은 시그니처 함수 추가만).

봉인 규칙은 무변(3550 `compute_image_seal_hash`(순서 봉인)·3554
`[video_sha256, cover_sha256 or ""]` 합성 그대로) — 뮤테이션 2건은 이 기존
공유 로직이 facebook 채널에서도 실제로 exercise되는지 확認한다."""
from __future__ import annotations

import os
import struct
import uuid
from datetime import datetime, timezone

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


_CHANNEL_MEDIA_BUCKET = "test-channel-media-3567"


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


async def _seed_default_role(session, org_id):
    from app.models.participation import ParticipationRole

    role = ParticipationRole(id=uuid.uuid4(), org_id=org_id, key="approver", label="Approver", is_default=True)
    session.add(role)
    await session.commit()
    return role.id


async def _upload_n_images(client, org_id, draft_id, n: int, *, size=(800, 1000)):
    responses = []
    for i in range(n):
        raw = _jpeg_bytes(*size, color=(10 * i, 50, 80))
        r = await _upload_and_confirm(client, org_id, draft_id, raw, content_type="image/jpeg")
        responses.append(r)
    return responses


async def _approve_gate_directly(session, gate_id):
    from sqlalchemy import select
    from app.models.gate import Gate

    gate = (await session.execute(select(Gate).where(Gate.id == gate_id))).scalar_one()
    gate.status = "approved"
    gate.resolver_id = uuid.uuid4()
    gate.resolved_at = datetime.now(timezone.utc)
    await session.commit()


# ─── MP4(ISOBMFF) 최소 유효 픽스처 — test_3554_instagram_reels.py와 동형 ────────


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


# ─── ③ 어댑터 선언 — 순수 유닛 ─────────────────────────────────────────────────


@pytest.mark.anyio
async def test_facebook_single_image_non_square_passes_aspect_normalization():
    """페드루 PO 리뷰(PR#3925) — image_aspect_max 수정의 양성 대조. 3547 단일-이미지
    경로(캐러셀 아님, 이미지 1장)로 비정사각(1080×1350) 이미지를 올려 200이 나는지
    직접 확認 — 수정 前엔(image_aspect_max=0.0) 이 값도 422였다(뮤테이션에서 재확認)."""
    from app.main import app

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org_id, project_id = await _seed_org(s)
            human_id = await _seed_human(s, org_id, project_id)
            connection_id = await _seed_connection(s, org_id, channel="facebook")
            story_id = await _seed_story(s, org_id, project_id)

        _setup_org_scoped_app(app, Session, org_id, user_id=human_id, agent=False)
        async with _client_for(app) as client:
            draft_id = await _create_draft(client, org_id=org_id, connection_id=connection_id, story_id=story_id)
            r = await _upload_and_confirm(
                client, org_id, draft_id, _jpeg_bytes(1080, 1350), content_type="image/jpeg",
            )
        assert r.status_code == 201, r.text
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()


def test_facebook_adapter_declares_carousel_and_video_spec():
    from app.services.channel_adapters import CHANNEL_ADAPTERS

    fb = CHANNEL_ADAPTERS["facebook"]
    assert fb.image_max_count == 10
    assert fb.video_max_bytes == 100 * 1024 * 1024
    assert fb.video_max_seconds == 90.0
    assert fb.video_min_seconds == 3.0
    assert fb.video_aspect_target == pytest.approx(9 / 16)
    assert fb.video_aspect_tolerance == 0.05
    assert fb.video_codecs == ("avc1", "hvc1", "hev1")


def test_facebook_sandbox_adapter_declares_same_spec():
    from app.services.channel_adapters import CHANNEL_ADAPTERS

    fb_sandbox = CHANNEL_ADAPTERS["facebook_sandbox"]
    assert fb_sandbox.image_max_count == 10
    assert fb_sandbox.video_max_bytes == 100 * 1024 * 1024
    assert fb_sandbox.video_codecs == ("avc1", "hvc1", "hev1")


def test_facebook_publish_module_declares_carousel_and_reels_functions():
    import app.services.facebook_publish as facebook_publish
    import app.services.facebook_sandbox_publish as facebook_sandbox_publish

    assert hasattr(facebook_publish, "create_carousel_container")
    assert hasattr(facebook_publish, "create_reels_container")
    assert hasattr(facebook_sandbox_publish, "create_carousel_container")
    assert hasattr(facebook_sandbox_publish, "create_reels_container")


@pytest.mark.anyio
async def test_connection_response_exposes_facebook_carousel_and_video_spec():
    """story #3559 관례 — 어댑터 선언이 코드 변경 0으로 연결 응답에 자동 노출."""
    from app.main import app

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org_id, project_id = await _seed_org(s)
            human_id = await _seed_human(s, org_id, project_id)
            await _seed_connection(s, org_id, channel="facebook")

        _setup_org_scoped_app(app, Session, org_id, user_id=human_id, agent=False)
        async with _client_for(app) as client:
            r = await client.get(f"/api/v2/organizations/{org_id}/channel-connections")
        assert r.status_code == 200, r.text
        row = r.json()[0]
        assert row["image_max_count"] == 10
        assert row["video_max_bytes"] == 100 * 1024 * 1024
        assert row["video_codecs"] == ["avc1", "hvc1", "hev1"]
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()


# ─── ① 다중 사진 — 실 facebook_publish.py 유닛(mock httpx) ──────────────────────


class _FakeResponse:
    def __init__(self, body, status_code=200):
        self.status_code = status_code
        self._body = body

    def json(self):
        return self._body

    @property
    def text(self):
        return str(self._body)


@pytest.mark.anyio
async def test_create_carousel_container_builds_photos_then_feed():
    from app.services.facebook_publish import create_carousel_container

    responses = iter([
        {"id": "photo-1"}, {"id": "photo-2"}, {"id": "photo-3"}, {"id": "post-999", "post_id": "page_post-999"},
    ])
    calls = []

    class _FakeClient:
        async def post(self, url, *, params):
            calls.append((url, params))
            return _FakeResponse(next(responses))

    post_id = await create_carousel_container(
        _FakeClient(), access_token="tok", threads_user_id="page-1", text="캡션",
        image_urls=["https://x/1.jpg", "https://x/2.jpg", "https://x/3.jpg"],
    )
    assert post_id == "page_post-999"
    assert len(calls) == 4
    for url, params in calls[:3]:
        assert url.endswith("/page-1/photos")
        assert params["published"] == "false"
    feed_url, feed_params = calls[3]
    assert feed_url.endswith("/page-1/feed")
    assert feed_params["message"] == "캡션"
    import json as _json
    assert _json.loads(feed_params["attached_media"]) == [
        {"media_fbid": "photo-1"}, {"media_fbid": "photo-2"}, {"media_fbid": "photo-3"},
    ]


@pytest.mark.anyio
async def test_create_carousel_container_child_failure_never_creates_feed_post():
    """원자성 — 자식 하나 실패하면 /feed(=실제 발행) 호출 자체가 안 일어난다."""
    from app.services.facebook_publish import create_carousel_container
    from app.services.threads_publish import ThreadsPublishError

    calls = []

    class _FakeClient:
        async def post(self, url, *, params):
            calls.append((url, params))
            if len(calls) == 2:
                return _FakeResponse({}, status_code=502)
            return _FakeResponse({"id": "photo-1"})

    with pytest.raises(ThreadsPublishError):
        await create_carousel_container(
            _FakeClient(), access_token="tok", threads_user_id="page-1", text="",
            image_urls=["https://x/1.jpg", "https://x/2.jpg", "https://x/3.jpg"],
        )
    assert len(calls) == 2
    assert all(url.endswith("/photos") for url, _ in calls), "/feed(발행) 콜이 일어났다(원자성 위반)"


# ─── ② 릴스 — 실 facebook_publish.py 유닛(mock httpx) ──────────────────────────


@pytest.mark.anyio
async def test_create_reels_container_start_upload_finish_sequence():
    from app.services.facebook_publish import create_reels_container

    calls = []

    class _FakeClient:
        async def post(self, url, *, params=None, headers=None):
            calls.append((url, params, headers))
            if len(calls) == 1:
                return _FakeResponse({"video_id": "video-42", "upload_url": "https://upload.example/video-42"})
            if len(calls) == 2:
                return _FakeResponse({})
            return _FakeResponse({"id": "video-42"})

    video_id = await create_reels_container(
        _FakeClient(), access_token="tok", threads_user_id="page-1", text="캡션",
        video_url="https://storage.example/video.mp4", cover_url="https://storage.example/cover.jpg",
    )
    assert video_id == "video-42"
    assert len(calls) == 3
    start_url, start_params, _ = calls[0]
    assert start_url.endswith("/page-1/video_reels")
    assert start_params["upload_phase"] == "start"
    upload_url, _, upload_headers = calls[1]
    assert upload_url == "https://upload.example/video-42"
    assert upload_headers["file_url"] == "https://storage.example/video.mp4"
    finish_url, finish_params, _ = calls[2]
    assert finish_url.endswith("/page-1/video_reels")
    assert finish_params["upload_phase"] == "finish"
    assert finish_params["video_id"] == "video-42"
    assert finish_params["video_state"] == "PUBLISHED"
    assert finish_params["thumb"] == "https://storage.example/cover.jpg"


@pytest.mark.anyio
async def test_create_reels_container_requires_video_url():
    from app.services.facebook_publish import create_reels_container
    from app.services.threads_publish import ThreadsPublishError

    with pytest.raises(ThreadsPublishError):
        await create_reels_container(
            None, access_token="tok", threads_user_id="page-1", text="", video_url=None,
        )


@pytest.mark.anyio
async def test_get_container_status_branches_by_response_status_field():
    from app.services.facebook_publish import get_container_status

    class _FakeClient:
        def __init__(self, body):
            self._body = body

        async def get(self, url, *, params):
            return _FakeResponse(self._body)

    # 사진/피드 post id — status 필드 자체가 없다 → 계속 즉시 FINISHED(회귀 0).
    status, _ = await get_container_status(_FakeClient({"id": "page_post-1"}), access_token="tok", creation_id="page_post-1")
    assert status == "FINISHED"

    # 릴스 video_id — 진짜 처리 상태를 반영.
    status, _ = await get_container_status(
        _FakeClient({"status": {"video_status": "processing"}}), access_token="tok", creation_id="video-42",
    )
    assert status == "IN_PROGRESS"

    status, _ = await get_container_status(
        _FakeClient({"status": {"video_status": "ready"}}), access_token="tok", creation_id="video-42",
    )
    assert status == "FINISHED"

    status, _ = await get_container_status(
        _FakeClient({"status": {"video_status": "error"}}), access_token="tok", creation_id="video-42",
    )
    assert status == "ERROR"


@pytest.mark.anyio
async def test_get_container_status_400_code_100_treated_as_finished():
    """400+error.code==100 = "이 필드/객체 조합 자체가 없음"(사진/피드 post에 status를
    물었을 때의 정상 반응, ⚠️미확認) — 그 경우만 FINISHED."""
    from app.services.facebook_publish import get_container_status

    class _FakeErrorClient:
        async def get(self, url, *, params):
            return _FakeResponse({"error": {"code": 100, "message": "Unsupported get request"}}, status_code=400)

    status, _ = await get_container_status(_FakeErrorClient(), access_token="tok", creation_id="page_post-1")
    assert status == "FINISHED"


@pytest.mark.anyio
async def test_get_container_status_other_non_200_is_in_progress_not_fail_open():
    """뮤테이션 대상 — 비-200을 전부 FINISHED로 되돌리면(fail-open) 이 테스트가
    RED여야 한다. 429(rate limit)·5xx(진짜 원인 불명)는 "모른다"를 "끝났다"로
    넘기면 안 된다 — IN_PROGRESS로 다음 tick 재폴링."""
    from app.services.facebook_publish import get_container_status

    class _FakeRateLimitClient:
        async def get(self, url, *, params):
            return _FakeResponse({"error": {"code": 4, "message": "rate limited"}}, status_code=429)

    class _FakeServerErrorClient:
        async def get(self, url, *, params):
            return _FakeResponse({}, status_code=500)

    status, _ = await get_container_status(_FakeRateLimitClient(), access_token="tok", creation_id="video-42")
    assert status == "IN_PROGRESS"

    status, _ = await get_container_status(_FakeServerErrorClient(), access_token="tok", creation_id="video-42")
    assert status == "IN_PROGRESS"


# ─── 종단 — facebook_sandbox 초안 발행 ────────────────────────────────────────


@pytest.mark.anyio
async def test_publish_endpoint_dispatches_to_carousel_for_facebook_sandbox():
    from app.main import app

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org_id, project_id = await _seed_org(s)
            await _seed_default_role(s, org_id)
            human_id = await _seed_human(s, org_id, project_id)
            connection_id = await _seed_connection(s, org_id, channel="facebook_sandbox")
            story_id = await _seed_story(s, org_id, project_id)

        _setup_org_scoped_app(app, Session, org_id, user_id=human_id, agent=False)
        async with _client_for(app) as client:
            draft_id = await _create_draft(client, org_id=org_id, connection_id=connection_id, story_id=story_id)
            responses = await _upload_n_images(client, org_id, draft_id, 3)
            for r in responses:
                assert r.status_code == 201, r.text
            version_id = responses[-1].json()["version_id"]

            r_submit = await client.post(
                f"/api/v2/organizations/{org_id}/channel-posts/drafts/{draft_id}/submit",
                json={"version_id": version_id},
            )
            assert r_submit.status_code == 200, r_submit.text
            gate_id = r_submit.json()["gate_id"]

        async with Session() as s:
            await _approve_gate_directly(s, uuid.UUID(gate_id))

        async with _client_for(app) as client:
            r1 = await client.post(f"/api/v2/organizations/{org_id}/channel-posts/drafts/{draft_id}/publish")
            assert r1.status_code == 200, r1.text
            assert r1.json()["processing"] is True

            r2 = await client.post(f"/api/v2/organizations/{org_id}/channel-posts/drafts/{draft_id}/publish")
        assert r2.status_code == 200, r2.text
        body = r2.json()
        assert body["processing"] is False
        # facebook_sandbox_publish.py::publish_container는 그대로 통과(no-op) —
        # create_carousel_container가 반환한 id 그대로가 최종 external_id.
        assert body["external_id"] is not None and body["external_id"].startswith("sandbox-fb-carousel-")
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()


@pytest.mark.anyio
async def test_sandbox_carousel_child_failure_marker_blocks_publish():
    from app.main import app

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org_id, project_id = await _seed_org(s)
            await _seed_default_role(s, org_id)
            human_id = await _seed_human(s, org_id, project_id)
            connection_id = await _seed_connection(s, org_id, channel="facebook_sandbox")
            story_id = await _seed_story(s, org_id, project_id)

        _setup_org_scoped_app(app, Session, org_id, user_id=human_id, agent=False)
        async with _client_for(app) as client:
            draft_id = await _create_draft(
                client, org_id=org_id, connection_id=connection_id, story_id=story_id,
                text="[sandbox:carousel-child-2-failed]",
            )
            responses = await _upload_n_images(client, org_id, draft_id, 3)
            for r in responses:
                assert r.status_code == 201, r.text
            version_id = responses[-1].json()["version_id"]

            r_submit = await client.post(
                f"/api/v2/organizations/{org_id}/channel-posts/drafts/{draft_id}/submit",
                json={"version_id": version_id},
            )
            gate_id = r_submit.json()["gate_id"]

        async with Session() as s:
            await _approve_gate_directly(s, uuid.UUID(gate_id))

        async with _client_for(app) as client:
            r_publish = await client.post(f"/api/v2/organizations/{org_id}/channel-posts/drafts/{draft_id}/publish")
        assert r_publish.status_code >= 400, r_publish.text
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()


@pytest.mark.anyio
async def test_publish_endpoint_dispatches_to_reels_for_facebook_sandbox():
    from app.main import app

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org_id, project_id = await _seed_org(s)
            await _seed_default_role(s, org_id)
            human_id = await _seed_human(s, org_id, project_id)
            connection_id = await _seed_connection(s, org_id, channel="facebook_sandbox")
            story_id = await _seed_story(s, org_id, project_id)

        _setup_org_scoped_app(app, Session, org_id, user_id=human_id, agent=False)
        async with _client_for(app) as client:
            draft_id = await _create_draft(client, org_id=org_id, connection_id=connection_id, story_id=story_id)
            raw = _build_mp4(duration_seconds=6.0, **_VALID_9_16)
            r_video = await _upload_and_confirm_video(client, org_id, draft_id, raw)
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
            r1 = await client.post(f"/api/v2/organizations/{org_id}/channel-posts/drafts/{draft_id}/publish")
            assert r1.status_code == 200, r1.text
            assert r1.json()["processing"] is True

            r2 = await client.post(f"/api/v2/organizations/{org_id}/channel-posts/drafts/{draft_id}/publish")
        assert r2.status_code == 200, r2.text
        body = r2.json()
        assert body["processing"] is False
        assert body["external_id"] is not None and body["external_id"].startswith("sandbox-fb-reels-")
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()


@pytest.mark.anyio
async def test_sandbox_reels_processing_failed_marker():
    from app.services.facebook_sandbox_publish import create_reels_container
    from app.services.threads_publish import ThreadsPublishError

    with pytest.raises(ThreadsPublishError) as exc:
        await create_reels_container(
            None, access_token="tok", threads_user_id="page-1", text="[sandbox:reels-processing-failed]",
            video_url="https://x/video.mp4",
        )
    assert exc.value.code == "SANDBOX_FACEBOOK_REELS_PROCESSING_FAILED"


@pytest.mark.anyio
async def test_sandbox_reels_codec_rejected_marker():
    from app.services.facebook_sandbox_publish import create_reels_container
    from app.services.threads_publish import ThreadsPublishError

    with pytest.raises(ThreadsPublishError) as exc:
        await create_reels_container(
            None, access_token="tok", threads_user_id="page-1", text="[sandbox:reels-codec-rejected]",
            video_url="https://x/video.mp4",
        )
    assert exc.value.code == "SANDBOX_FACEBOOK_REELS_CODEC_REJECTED"


# ─── 뮤테이션 2건(story 確定 그대로, 기존 공유 봉인 로직을 facebook 채널에서 확認) ──


@pytest.mark.anyio
async def test_facebook_carousel_reorder_breaks_seal():
    """뮤테이션 대상① — compute_image_seal_hash가 순서를 무시하도록(예: 정렬 후
    합성) 바뀌면 이 테스트가 RED여야 한다."""
    from app.services.channel_post_images import compute_image_seal_hash

    h1 = compute_image_seal_hash(["sha-a", "sha-b", "sha-c"])
    h2 = compute_image_seal_hash(["sha-c", "sha-b", "sha-a"])
    assert h1 != h2


@pytest.mark.anyio
async def test_facebook_reels_composite_seal_includes_cover_hash():
    """뮤테이션 대상② — channel_post_images.py:452의 실 호출부
    (`compute_image_seal_hash([existing_video.original_sha256, final_sha256])`)가
    커버 해시를 빼면(예: `composite_sha256 = final_sha256`만, 즉 커버 자기 해시뿐)
    이 테스트가 RED여야 한다.

    판별 설계 — **같은 커버·다른 영상**인 두 draft를 비교한다(다른 커버·같은
    영상이면 final_sha256(커버 자기 해시)만 봐도 이미 다르게 나와 버그를 못
    잡는다, 앞선 시도에서 실측 확認한 함정). video_sha256이 실제로 합성에
    안 들어가면 두 draft의 composite가 **똑같아진다**(영상이 달라도 안 반영) —
    그게 이 뮤테이션이 노리는 결함."""
    from app.main import app
    from sqlalchemy import select
    from app.models.channel_post_version import ChannelPostVersion

    same_cover = _jpeg_bytes(720, 1280, color=(77, 77, 77))

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org_id, project_id = await _seed_org(s)
            human_id = await _seed_human(s, org_id, project_id)
            connection_id = await _seed_connection(s, org_id, channel="facebook_sandbox")
            story_id = await _seed_story(s, org_id, project_id)

        _setup_org_scoped_app(app, Session, org_id, user_id=human_id, agent=False)
        version_ids = []
        async with _client_for(app) as client:
            for duration in (5.0, 8.0):  # 서로 다른 영상(길이 다름 → sha256 다름).
                draft_id = await _create_draft(client, org_id=org_id, connection_id=connection_id, story_id=story_id)
                raw_video = _build_mp4(duration_seconds=duration, **_VALID_9_16)
                r_video = await _upload_and_confirm_video(client, org_id, draft_id, raw_video)
                assert r_video.status_code == 201, r_video.text

                r_cover = await _upload_and_confirm(
                    client, org_id, draft_id, same_cover, content_type="image/jpeg",
                )
                assert r_cover.status_code == 201, r_cover.text
                version_ids.append(r_cover.json()["version_id"])

        async with Session() as s:
            shas = []
            for vid in version_ids:
                sha = (await s.execute(
                    select(ChannelPostVersion.image_sha256).where(ChannelPostVersion.id == uuid.UUID(vid))
                )).scalar_one()
                shas.append(sha)
        assert shas[0] is not None and shas[1] is not None
        assert shas[0] != shas[1], "커버가 같아도 영상이 다르면 합성 봉인도 달라야 한다(영상 해시 누락 의심)"
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()
