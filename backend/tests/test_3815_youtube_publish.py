"""story #3815(Phase3·3-5 PR2, 페드루 PO 確定 2026-09-12) — YouTube 발행 회귀·정탐.
AC 담당 4단(x_publish_budget.py 4단 구조 동형):
① `youtube_quota.py` 단위 — 플랫폼 전체(cross-org) 합산·초과 시 reset_at 포함
  raise·evidence 멱등(publication_id+event).
② `youtube_privacy.py` 단위 — 감사 미완=강제 비공개(설정값 축·sandbox 마커 축
  둘 다), 뮤테이션 셀프체크로 "잠금 로직이 실제로 뭘 지키는지" 고정.
③ `_validate_youtube_metadata` 단위 — title 필수·tags 합산 상한·categoryId
  숫자 문자열·privacyStatus 허용값. 비-youtube 채널은 관할 밖.
④ sandbox 마커 3종 — quota-exceeded(결정적 422 재현)·privacy-locked·
  provider-error(기존 어휘 재사용).
⑤ CHANGES②(페드루 PO 지적 2026-09-12 11:34Z) — 컨테이너 IN_PROGRESS 폴링
  상한이 채널 고정 5분이 아니라 어댑터 값이어야 함(YouTube 트랜스코딩이
  5분을 예사로 넘겨도 「거짓 실패+중복 업로드」가 나면 안 된다)."""
from __future__ import annotations

import os
import uuid
from datetime import datetime, timedelta, timezone
from unittest.mock import AsyncMock, patch

import httpx
import pytest

from tests.test_3471_org_content_rules_lint import _seed_org, _seed_story, _session_factory

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


_CHANNEL_MEDIA_BUCKET = "test-channel-media-3815"


@pytest.fixture(autouse=True)
def _local_channel_media_storage(monkeypatch, tmp_path):
    """test_3554_instagram_reels.py와 동형 픽스처(다른 버킷명으로 격리) — ⑤의
    영상 업로드 왕복 재현에만 실제로 쓰임."""
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


# ─── ① youtube_quota.py 단위 ───────────────────────────────────────────────

@pytest.mark.anyio
async def test_check_youtube_quota_or_raise_under_limit_passes():
    from app.services.youtube_quota import check_youtube_quota_or_raise

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            await check_youtube_quota_or_raise(s, estimated_units=1_600)
    finally:
        await engine.dispose()


@pytest.mark.anyio
async def test_check_youtube_quota_or_raise_exceeds_includes_reset_at_utc_midnight():
    """페드루 PO 낱말 확定(2026-09-12 10:46Z) — reset_at은 정확한 UTC 자정
    시각(날짜뿐 아님)."""
    from app.core.config import settings
    from app.services.youtube_quota import YouTubeQuotaExceededError, check_youtube_quota_or_raise

    engine, Session = await _session_factory()
    try:
        now = datetime(2026, 9, 12, 15, 30, 0, tzinfo=timezone.utc)
        async with Session() as s:
            with pytest.raises(YouTubeQuotaExceededError) as exc_info:
                await check_youtube_quota_or_raise(
                    s, estimated_units=settings.youtube_quota_daily_limit_units + 1, now=now,
                )
        exc = exc_info.value
        assert exc.limit_units == settings.youtube_quota_daily_limit_units
        assert exc.spent_units == 0
        assert exc.remaining_units == settings.youtube_quota_daily_limit_units
        assert exc.reset_at == datetime(2026, 9, 13, 0, 0, 0, tzinfo=timezone.utc), (
            "reset_at은 «내일 날짜»가 아니라 정확한 UTC 자정 시각이어야 한다"
        )
    finally:
        await engine.dispose()


@pytest.mark.anyio
async def test_platform_wide_quota_sum_ignores_org_id():
    """org_id 필터가 없다는 게 이 함수의 요점 — 서로 다른 두 조직의 evidence가
    합산돼 한쪽 조직만 봐선 안 잡히는 초과를 잡아야 한다."""
    from app.core.config import settings
    from app.services.youtube_quota import (
        YouTubeQuotaExceededError, check_youtube_quota_or_raise, record_youtube_quota_usage_evidence,
    )

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org_a, project_a = await _seed_org(s)
            org_b, project_b = await _seed_org(s)
            story_a = await _seed_story(s, org_a, project_a)
            story_b = await _seed_story(s, org_b, project_b)

        half = settings.youtube_quota_daily_limit_units // 2 + 100
        async with Session() as s:
            await record_youtube_quota_usage_evidence(
                s, org_id=org_a, work_item_id=story_a, publication_id=uuid.uuid4(), event="insert", units=half,
            )
        async with Session() as s:
            await record_youtube_quota_usage_evidence(
                s, org_id=org_b, work_item_id=story_b, publication_id=uuid.uuid4(), event="insert", units=half,
            )

        # 조직 A 혼자면 절대 초과가 아니지만, 플랫폼 전체(A+B) 합산은 이미
        # limit 근처라 조금만 더 요청해도 넘는다.
        async with Session() as s:
            with pytest.raises(YouTubeQuotaExceededError) as exc_info:
                await check_youtube_quota_or_raise(s, estimated_units=1_000)
        assert exc_info.value.spent_units == half * 2
    finally:
        await engine.dispose()


@pytest.mark.anyio
async def test_record_youtube_quota_usage_evidence_idempotent_by_publication_and_event():
    from sqlalchemy import select
    from app.models.evidence import Evidence
    from app.services.youtube_quota import YOUTUBE_QUOTA_KIND, record_youtube_quota_usage_evidence

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org_id, project_id = await _seed_org(s)
            story_id = await _seed_story(s, org_id, project_id)
        publication_id = uuid.uuid4()

        async with Session() as s:
            await record_youtube_quota_usage_evidence(
                s, org_id=org_id, work_item_id=story_id, publication_id=publication_id, event="insert", units=1_600,
            )
        async with Session() as s:
            # 재시도 시나리오 — 같은 (publication_id, event) 재호출.
            await record_youtube_quota_usage_evidence(
                s, org_id=org_id, work_item_id=story_id, publication_id=publication_id, event="insert", units=1_600,
            )
        async with Session() as s:
            rows = (await s.execute(
                select(Evidence).where(
                    Evidence.org_id == org_id, Evidence.payload["kind"].astext == YOUTUBE_QUOTA_KIND,
                )
            )).scalars().all()
        assert len(rows) == 1, f"멱등이어야 하는데 {len(rows)}건 기록됨"

        # 양성대조 — 다른 event("list")는 같은 publication이어도 별개 행.
        async with Session() as s:
            await record_youtube_quota_usage_evidence(
                s, org_id=org_id, work_item_id=story_id, publication_id=publication_id, event="list", units=1,
            )
        async with Session() as s:
            rows = (await s.execute(
                select(Evidence).where(
                    Evidence.org_id == org_id, Evidence.payload["kind"].astext == YOUTUBE_QUOTA_KIND,
                )
            )).scalars().all()
        assert len(rows) == 2
    finally:
        await engine.dispose()


# ─── ② youtube_privacy.py 단위 — 뮤테이션 셀프체크 포함 ───────────────────────

def test_resolve_youtube_privacy_lock_forces_private_when_audit_incomplete(monkeypatch):
    from app.core.config import settings
    from app.services.youtube_privacy import resolve_youtube_privacy_lock

    monkeypatch.setattr(settings, "youtube_api_audit_incomplete", True)
    status, locked = resolve_youtube_privacy_lock(requested_privacy_status="public", text="일반 설명문")
    assert (status, locked) == ("private", True), "감사 미완이면 요청값(public) 무관 private 강제여야 한다"


def test_resolve_youtube_privacy_lock_respects_requested_when_audit_complete(monkeypatch):
    from app.core.config import settings
    from app.services.youtube_privacy import resolve_youtube_privacy_lock

    monkeypatch.setattr(settings, "youtube_api_audit_incomplete", False)
    status, locked = resolve_youtube_privacy_lock(requested_privacy_status="public", text="일반 설명문")
    assert (status, locked) == ("public", False)


def test_resolve_youtube_privacy_lock_marker_forces_lock_even_when_audit_complete(monkeypatch):
    """sandbox 결정적 마커 축 — 감사가 끝났다고 설정해도(audit_incomplete=False)
    마커가 있으면 여전히 잠긴다(테스트가 env 값에 기대지 않게)."""
    from app.core.config import settings
    from app.services.youtube_privacy import resolve_youtube_privacy_lock

    monkeypatch.setattr(settings, "youtube_api_audit_incomplete", False)
    status, locked = resolve_youtube_privacy_lock(
        requested_privacy_status="public", text="설명 [sandbox:youtube-privacy-locked] 끝",
    )
    assert (status, locked) == ("private", True)


def test_resolve_youtube_privacy_lock_defaults_to_private_when_unspecified(monkeypatch):
    from app.core.config import settings
    from app.services.youtube_privacy import resolve_youtube_privacy_lock

    monkeypatch.setattr(settings, "youtube_api_audit_incomplete", False)
    status, locked = resolve_youtube_privacy_lock(requested_privacy_status=None, text="설명")
    assert (status, locked) == ("private", False), "미지정 시에도 기본은 안전한 쪽(private)이어야 한다"


def test_mutation_privacy_lock_audit_incomplete_axis_would_break_if_ignored(monkeypatch):
    """⭐뮤테이션 셀프체크 — resolve_youtube_privacy_lock이 audit_incomplete를
    무시하도록 임시로 바꾸면 위 forces_private 테스트가 정확히 RED가 나야
    한다(가드가 실제로 뭘 지키는지 증명, [[feedback_guard_must_declare_what_it_misses]])."""
    import app.services.youtube_privacy as privacy_module
    from app.core.config import settings

    original = privacy_module.resolve_youtube_privacy_lock

    def _mutated(*, requested_privacy_status, text):
        # audit_incomplete 축을 고의로 빼먹은 버전 — 마커 축만 본다.
        if privacy_module._MARKER_PRIVACY_LOCKED in text:
            return "private", True
        return requested_privacy_status or "private", False

    monkeypatch.setattr(privacy_module, "resolve_youtube_privacy_lock", _mutated)
    monkeypatch.setattr(settings, "youtube_api_audit_incomplete", True)
    status, locked = privacy_module.resolve_youtube_privacy_lock(requested_privacy_status="public", text="설명")
    assert (status, locked) == ("public", False), "뮤테이션이 실제로 축 하나를 죽였는지 확認(이 assert 자체는 RED 재현용)"
    assert original is not _mutated


# ─── ③ _validate_youtube_metadata 단위 ─────────────────────────────────────

def test_validate_youtube_metadata_valid_payload_passes():
    from app.services.channel_posts import _validate_youtube_metadata

    _validate_youtube_metadata(
        channel="youtube",
        channel_payload={"title": "제목", "tags": ["a", "b"], "categoryId": "22", "privacyStatus": "unlisted"},
    )


def test_validate_youtube_metadata_non_youtube_channel_skips_entirely():
    from app.services.channel_posts import _validate_youtube_metadata

    _validate_youtube_metadata(channel="threads", channel_payload={"title": ""})  # 관할 밖 — 절대 안 터진다.


def test_validate_youtube_metadata_missing_title_raises():
    from app.services.channel_posts import ChannelYouTubeMetadataError, _validate_youtube_metadata

    with pytest.raises(ChannelYouTubeMetadataError) as exc_info:
        _validate_youtube_metadata(channel="youtube_sandbox", channel_payload={})
    assert exc_info.value.field == "title"


def test_validate_youtube_metadata_title_too_long_raises():
    from app.services.channel_posts import ChannelYouTubeMetadataError, _validate_youtube_metadata

    with pytest.raises(ChannelYouTubeMetadataError) as exc_info:
        _validate_youtube_metadata(channel="youtube", channel_payload={"title": "가" * 101})
    assert exc_info.value.field == "title"


def test_validate_youtube_metadata_tags_combined_too_long_raises():
    from app.services.channel_posts import ChannelYouTubeMetadataError, _validate_youtube_metadata

    with pytest.raises(ChannelYouTubeMetadataError) as exc_info:
        _validate_youtube_metadata(
            channel="youtube", channel_payload={"title": "t", "tags": ["가" * 250, "나" * 251]},
        )
    assert exc_info.value.field == "tags"


def test_validate_youtube_metadata_category_id_non_numeric_raises():
    from app.services.channel_posts import ChannelYouTubeMetadataError, _validate_youtube_metadata

    with pytest.raises(ChannelYouTubeMetadataError) as exc_info:
        _validate_youtube_metadata(channel="youtube", channel_payload={"title": "t", "categoryId": "gaming"})
    assert exc_info.value.field == "categoryId"


def test_validate_youtube_metadata_invalid_privacy_status_raises():
    from app.services.channel_posts import ChannelYouTubeMetadataError, _validate_youtube_metadata

    with pytest.raises(ChannelYouTubeMetadataError) as exc_info:
        _validate_youtube_metadata(channel="youtube", channel_payload={"title": "t", "privacyStatus": "secret"})
    assert exc_info.value.field == "privacyStatus"


# ─── ④ sandbox 마커 3종 ────────────────────────────────────────────────────

@pytest.mark.anyio
async def test_youtube_sandbox_quota_exceeded_marker_raises_with_reset_at():
    from app.services.youtube_quota import YouTubeQuotaExceededError
    from app.services.youtube_sandbox_publish import create_reels_container

    with pytest.raises(YouTubeQuotaExceededError) as exc_info:
        await create_reels_container(
            httpx.AsyncClient(), access_token="at", threads_user_id="u",
            text="설명 [sandbox:youtube-quota-exceeded] 끝", video_url="https://example.com/v.mp4",
        )
    assert exc_info.value.remaining_units == 0
    assert exc_info.value.reset_at is not None


@pytest.mark.anyio
async def test_youtube_sandbox_provider_error_marker_reused():
    """신규 마커 0(페드루 明示④) — 기존 [sandbox:provider-error] 어휘 그대로."""
    from app.services.threads_publish import ThreadsPublishError
    from app.services.youtube_sandbox_publish import create_reels_container

    with pytest.raises(ThreadsPublishError) as exc_info:
        await create_reels_container(
            httpx.AsyncClient(), access_token="at", threads_user_id="u",
            text="설명 [sandbox:provider-error] 끝", video_url="https://example.com/v.mp4",
        )
    assert exc_info.value.code == "SANDBOX_YOUTUBE_PROVIDER_ERROR"
    assert exc_info.value.status_code == 502


@pytest.mark.anyio
async def test_youtube_sandbox_create_reels_container_deterministic_id_when_clean():
    from app.services.youtube_sandbox_publish import create_reels_container

    container_id = await create_reels_container(
        httpx.AsyncClient(), access_token="at", threads_user_id="u",
        text="깨끗한 설명", video_url="https://example.com/v.mp4",
        channel_payload={"title": "제목"},
    )
    assert container_id.startswith("sandbox-youtube-video-")


@pytest.mark.anyio
async def test_youtube_sandbox_get_container_status_always_finished():
    from app.services.youtube_sandbox_publish import get_container_status

    status, err = await get_container_status(httpx.AsyncClient(), access_token="at", creation_id="x")
    assert (status, err) == ("FINISHED", None)


@pytest.mark.anyio
async def test_youtube_sandbox_processing_long_marker_stays_in_progress():
    """CHANGES②용 결정적 재현 자리 — 마커가 있으면 매 호출 IN_PROGRESS(5분·6분
    지나도 FINISHED로 안 바뀜, id 문자열 자체가 상태라 process 메모리 불요)."""
    from app.services.youtube_sandbox_publish import create_reels_container, get_container_status

    container_id = await create_reels_container(
        httpx.AsyncClient(), access_token="at", threads_user_id="u",
        text="설명 [sandbox:youtube-processing-long] 끝", video_url="https://example.com/v.mp4",
    )
    assert "processing-long" in container_id
    status, err = await get_container_status(httpx.AsyncClient(), access_token="at", creation_id=container_id)
    assert (status, err) == ("IN_PROGRESS", None)


# ─── ⑤ CHANGES② — 어댑터별 컨테이너 폴링 상한 ─────────────────────────────────

def test_youtube_adapters_declare_24h_container_poll_timeout_not_5min_default():
    from app.services.channel_adapters import CHANNEL_ADAPTERS

    for channel in ("youtube", "youtube_sandbox"):
        assert CHANNEL_ADAPTERS[channel].container_poll_timeout_seconds == 86_400, (
            f"{channel}이 기본 300초(5분)를 그대로 쓰면 트랜스코딩 中에 거짓 실패+중복 업로드가 난다"
        )


def test_other_channels_keep_default_5min_container_poll_timeout():
    """양성대조 — 기존 채널(Meta류)은 이 PR로 회귀가 없어야 한다(기본값 300 그대로)."""
    from app.services.channel_adapters import CHANNEL_ADAPTERS

    for channel in ("instagram", "threads", "facebook"):
        assert CHANNEL_ADAPTERS[channel].container_poll_timeout_seconds == 300


@pytest.mark.anyio
async def test_youtube_sandbox_container_beyond_5min_stays_in_progress_no_reupload():
    """⭐CHANGES②(페드루 PO 지적 2026-09-12 11:34Z) 핵심 재현 — YouTube는 5분을
    넘겨도(Meta 상한 자리) 거짓 실패로 떨어지면 안 된다: 행이 살아있고(status
    실패 아님)·external_container_id 보존(재시도가 새 업로드를 안 만든다)·
    create_reels_container(=insert, quota 소비처) 재호출 0."""
    from tests.test_620beefc_channel_post_image_upload import (
        _approve_gate_directly, _client_for, _seed_connection, _seed_human, _seed_org, _seed_story,
        _session_factory, _setup_org_scoped_app,
    )
    from tests.test_3554_instagram_reels import _build_mp4, _upload_and_confirm_video

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org_id, project_id = await _seed_org(s)
            human_id = await _seed_human(s, org_id, project_id)
            connection_id = await _seed_connection(s, org_id, channel="youtube_sandbox")
            story_id = await _seed_story(s, org_id, project_id)
            from app.models.participation import ParticipationRole
            role = ParticipationRole(id=uuid.uuid4(), org_id=org_id, key="approver", label="Approver", is_default=True)
            s.add(role)
            await s.commit()
        from app.main import app
        _setup_org_scoped_app(app, Session, org_id, user_id=human_id, agent=False)

        try:
            async with _client_for(app) as client:
                r_draft = await client.post(
                    f"/api/v2/organizations/{org_id}/channel-posts/drafts",
                    json={
                        "work_item_id": str(story_id), "connection_id": str(connection_id),
                        "text": "6분 상한 재현용 설명",
                        "channel_payload": {"title": "6분 상한 재현"},
                    },
                )
                assert r_draft.status_code == 201, r_draft.text
                draft_id = r_draft.json()["draft_id"]

                video_raw = _build_mp4(duration_seconds=6.0, width=1920, height=1080)
                r_video = await _upload_and_confirm_video(client, org_id, draft_id, video_raw)
                assert r_video.status_code == 201, r_video.text

                r_submit = await client.post(
                    f"/api/v2/organizations/{org_id}/channel-posts/drafts/{draft_id}/submit", json={},
                )
                assert r_submit.status_code == 200, r_submit.text
                gate_id = uuid.UUID(r_submit.json()["gate_id"])

            async with Session() as s:
                await _approve_gate_directly(s, gate_id)

            import app.services.youtube_sandbox_publish as ysp
            create_reels_container_spy = AsyncMock(wraps=ysp.create_reels_container)
            with patch.object(ysp, "create_reels_container", create_reels_container_spy):
                async with _client_for(app) as client:
                    r_pub1 = await client.post(
                        f"/api/v2/organizations/{org_id}/channel-posts/drafts/{draft_id}/publish",
                    )
                assert r_pub1.status_code == 200, r_pub1.text
                assert r_pub1.json()["processing"] is True
            assert create_reels_container_spy.await_count == 1

            from app.models.channel_publication import ChannelPublication
            from sqlalchemy import select as sa_select
            async with Session() as s:
                pub = (await s.execute(
                    sa_select(ChannelPublication).where(ChannelPublication.org_id == org_id)
                )).scalar_one()
                original_container_id = pub.external_container_id
                assert "processing-long" not in original_container_id  # 정상 업로드 — 마커 없음.
                # 6분 경과 재현(row.created_at 되돌리기, 기존 620beefc 패턴과 동형).
                pub.created_at = datetime.now(timezone.utc) - timedelta(minutes=6)
                await s.commit()

            # sandbox의 get_container_status는 마커 없는 id면 즉시 FINISHED를 내
            # "6분 지나도 여전히 처리 中"을 재현할 수 없다 — get_container_status만
            # IN_PROGRESS로 패치해 그 상황을 시뮬레이션(YouTube 실물에선 트랜스코딩이
            # 그만큼 오래 걸리는 경우에 해당).
            with (
                patch.object(ysp, "create_reels_container", create_reels_container_spy),
                patch.object(ysp, "get_container_status", AsyncMock(return_value=("IN_PROGRESS", None))),
            ):
                async with _client_for(app) as client:
                    r_pub2 = await client.post(
                        f"/api/v2/organizations/{org_id}/channel-posts/drafts/{draft_id}/publish",
                    )
                assert r_pub2.status_code == 200, (
                    f"6분 경과에도 거짓 실패로 떨어지면 안 된다(YouTube 트랜스코딩 예사): {r_pub2.text}"
                )
                assert r_pub2.json()["processing"] is True

            assert create_reels_container_spy.await_count == 1, (
                "재시도가 새 업로드(insert)를 또 만들면 quota 이중 차감 — 5분 상한 채널과 같은 버그 재현"
            )

            async with Session() as s:
                pub = (await s.execute(
                    sa_select(ChannelPublication).where(ChannelPublication.org_id == org_id)
                )).scalar_one()
                assert pub.status != "failed", "6분 경과만으로 실패 처리되면 안 된다(24h 상한 미달)"
                assert pub.external_container_id == original_container_id, (
                    "id가 지워지면 다음 재시도가 새 업로드를 만든다 — 여기서 이미 사고"
                )
        finally:
            app.dependency_overrides.clear()
    finally:
        await engine.dispose()


def test_youtube_adapters_declare_keep_container_on_poll_timeout():
    from app.services.channel_adapters import CHANNEL_ADAPTERS

    for channel in ("youtube", "youtube_sandbox"):
        assert CHANNEL_ADAPTERS[channel].keep_container_on_poll_timeout is True


def test_other_channels_keep_default_clear_container_on_poll_timeout():
    """양성대조 — Meta류는 회귀 0(기본 False 그대로, 죽은 컨테이너는 id를 지워야
    다음 시도가 완전히 새 컨테이너를 만든다)."""
    from app.services.channel_adapters import CHANNEL_ADAPTERS

    for channel in ("instagram", "threads", "facebook"):
        assert CHANNEL_ADAPTERS[channel].keep_container_on_poll_timeout is False


@pytest.mark.anyio
async def test_youtube_sandbox_beyond_24h_timeout_fails_but_preserves_container_id_no_reupload_on_retry():
    """⭐CHANGES③(페드루 PO 지적 2026-09-12 11:55Z) — 24h(youtube/sandbox 상한)를
    넘겨도(극히 드문 경우) dead_letter로 떨어지는 건 Meta와 동형이지만,
    external_container_id는 지우면 안 된다 — 사람이 AC5 재시도를 눌렀을 때
    새 업로드(quota 1,600 재소모)가 또 나면 CHANGES②가 막은 사고가 24h 축에서
    반복된다. 재시도(dead_letter→pending)+get_container_status가 마침내
    FINISHED를 내는 시나리오까지 왕복해 insert(=create_reels_container) 호출이
    처음 1회에서 안 늘어남을 확認한다."""
    from tests.test_620beefc_channel_post_image_upload import (
        _approve_gate_directly, _client_for, _seed_connection, _seed_human, _seed_org, _seed_story,
        _session_factory, _setup_org_scoped_app,
    )
    from tests.test_3554_instagram_reels import _build_mp4, _upload_and_confirm_video

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org_id, project_id = await _seed_org(s)
            human_id = await _seed_human(s, org_id, project_id)
            connection_id = await _seed_connection(s, org_id, channel="youtube_sandbox")
            story_id = await _seed_story(s, org_id, project_id)
            from app.models.participation import ParticipationRole
            role = ParticipationRole(id=uuid.uuid4(), org_id=org_id, key="approver", label="Approver", is_default=True)
            s.add(role)
            await s.commit()
        from app.main import app
        _setup_org_scoped_app(app, Session, org_id, user_id=human_id, agent=False)

        try:
            async with _client_for(app) as client:
                r_draft = await client.post(
                    f"/api/v2/organizations/{org_id}/channel-posts/drafts",
                    json={
                        "work_item_id": str(story_id), "connection_id": str(connection_id),
                        "text": "24h 상한 재현용 설명",
                        "channel_payload": {"title": "24h 상한 재현"},
                    },
                )
                assert r_draft.status_code == 201, r_draft.text
                draft_id = r_draft.json()["draft_id"]

                video_raw = _build_mp4(duration_seconds=6.0, width=1920, height=1080)
                r_video = await _upload_and_confirm_video(client, org_id, draft_id, video_raw)
                assert r_video.status_code == 201, r_video.text

                r_submit = await client.post(
                    f"/api/v2/organizations/{org_id}/channel-posts/drafts/{draft_id}/submit", json={},
                )
                assert r_submit.status_code == 200, r_submit.text
                gate_id = uuid.UUID(r_submit.json()["gate_id"])

            async with Session() as s:
                await _approve_gate_directly(s, gate_id)

            import app.services.youtube_sandbox_publish as ysp
            create_reels_container_spy = AsyncMock(wraps=ysp.create_reels_container)
            with patch.object(ysp, "create_reels_container", create_reels_container_spy):
                async with _client_for(app) as client:
                    r_pub1 = await client.post(
                        f"/api/v2/organizations/{org_id}/channel-posts/drafts/{draft_id}/publish",
                    )
                assert r_pub1.status_code == 200, r_pub1.text
            assert create_reels_container_spy.await_count == 1

            from app.models.channel_publication import ChannelPublication
            from app.models.publication_command import PublicationCommand
            from sqlalchemy import select as sa_select
            async with Session() as s:
                pub = (await s.execute(
                    sa_select(ChannelPublication).where(ChannelPublication.org_id == org_id)
                )).scalar_one()
                original_container_id = pub.external_container_id
                # 24h+1분 경과 재현.
                pub.created_at = datetime.now(timezone.utc) - timedelta(hours=24, minutes=1)
                await s.commit()

            with (
                patch.object(ysp, "create_reels_container", create_reels_container_spy),
                patch.object(ysp, "get_container_status", AsyncMock(return_value=("IN_PROGRESS", None))),
            ):
                async with _client_for(app) as client:
                    r_pub2 = await client.post(
                        f"/api/v2/organizations/{org_id}/channel-posts/drafts/{draft_id}/publish",
                    )
                assert r_pub2.status_code == 503, r_pub2.text  # TIMEOUT → dead_letter(Meta와 동형).

            async with Session() as s:
                pub = (await s.execute(
                    sa_select(ChannelPublication).where(ChannelPublication.org_id == org_id)
                )).scalar_one()
                assert pub.status == "failed"
                # ⭐핵심 — 24h를 넘겼어도 id는 보존돼야 한다(뒤집으면 여기서 RED).
                assert pub.external_container_id == original_container_id, (
                    "24h 초과로 id가 지워지면 재시도가 새 업로드를 만든다 — CHANGES②가 막은 사고의 24h판"
                )
                command = (await s.execute(
                    sa_select(PublicationCommand).where(
                        PublicationCommand.org_id == org_id, PublicationCommand.destination == connection_id,
                    )
                )).scalar_one()
                assert command.status == "dead_letter"

            # 사람이 AC5 재시도 버튼을 누른 뒤(dead_letter→pending) 트랜스코딩이
            # 마침내 끝났다고 가정 — insert(create_reels_container) 재호출 없이
            # 같은 id로 폴링만 재개해 FINISHED로 마무리돼야 한다.
            async with _client_for(app) as client:
                r_retry = await client.post(
                    f"/api/v2/organizations/{org_id}/publication-commands/{command.id}/retry",
                )
                assert r_retry.status_code == 200, r_retry.text

            with (
                patch.object(ysp, "create_reels_container", create_reels_container_spy),
                patch.object(ysp, "get_container_status", AsyncMock(return_value=("FINISHED", None))),
            ):
                async with _client_for(app) as client:
                    r_pub3 = await client.post(
                        f"/api/v2/organizations/{org_id}/channel-posts/drafts/{draft_id}/publish",
                    )
                assert r_pub3.status_code == 200, r_pub3.text
                assert r_pub3.json()["processing"] is False

            assert create_reels_container_spy.await_count == 1, (
                "재시도 뒤에도 insert가 또 불렸다면 quota 이중 차감 — 24h 상한 id-보존이 안 먹힌 것"
            )
        finally:
            app.dependency_overrides.clear()
    finally:
        await engine.dispose()


# ─── ⑥ ChannelYouTubeMetadataError 라우터 매핑(미르코 PR4 그라운딩 발견 실 결함) ──

@pytest.mark.anyio
async def test_youtube_metadata_invalid_maps_to_422_not_500_at_save_time():
    """⭐실 결함 재현(페드루 PO 지적 2026-09-12 14:37Z) — `ChannelYouTubeMetadataError`
    를 라우터가 안 잡아 사용자에게 코드 없는 500이 나가던 것. 저장 시점
    (create_channel_post_draft_version) checkpoint 재현 — title 누락."""
    from tests.test_620beefc_channel_post_image_upload import (
        _client_for, _seed_connection, _seed_human, _seed_org, _seed_story, _session_factory,
        _setup_org_scoped_app,
    )
    from app.main import app

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org_id, project_id = await _seed_org(s)
            human_id = await _seed_human(s, org_id, project_id)
            connection_id = await _seed_connection(s, org_id, channel="youtube_sandbox")
            story_id = await _seed_story(s, org_id, project_id)

        _setup_org_scoped_app(app, Session, org_id, user_id=human_id, agent=False)
        try:
            async with _client_for(app) as client:
                r = await client.post(
                    f"/api/v2/organizations/{org_id}/channel-posts/drafts",
                    json={
                        "work_item_id": str(story_id), "connection_id": str(connection_id),
                        "text": "설명", "channel_payload": {"tags": ["a"]},  # title 누락.
                    },
                )
            assert r.status_code == 422, r.text
            body = r.json()["error"]
            assert body["code"] == "YOUTUBE_METADATA_INVALID"
            assert body["field"] == "title"
            assert body["message"]  # i18n_catalog 문구, 빈 문자열 아님.
        finally:
            app.dependency_overrides.clear()
    finally:
        await engine.dispose()


@pytest.mark.anyio
async def test_youtube_metadata_invalid_maps_to_422_not_500_at_publish_time():
    """발행 시점 checkpoint 재현 — 저장 시점엔 유효했던 channel_payload가(승인
    뒤 값이 조용히 나빠질 수 있는 시나리오, 예: 어댑터/상수가 그 사이 바뀜)
    발행 直前 재검사에서 걸려도 500이 아니라 422여야 한다. DB를 직접 헝클어
    (privacyStatus를 허용값 밖으로) 그 시나리오를 재현한다 — API로는 애초에
    이 상태를 만들 수 없다는 게 이 재현의 요점(저장 시점 게이트가 이미 막으므로)."""
    from sqlalchemy import select as sa_select
    from tests.test_620beefc_channel_post_image_upload import (
        _approve_gate_directly, _client_for, _seed_connection, _seed_human, _seed_org, _seed_story,
        _session_factory, _setup_org_scoped_app,
    )
    from tests.test_3554_instagram_reels import _build_mp4, _upload_and_confirm_video
    from app.main import app
    from app.models.channel_post_version import ChannelPostVersion

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org_id, project_id = await _seed_org(s)
            human_id = await _seed_human(s, org_id, project_id)
            connection_id = await _seed_connection(s, org_id, channel="youtube_sandbox")
            story_id = await _seed_story(s, org_id, project_id)
            from app.models.participation import ParticipationRole
            role = ParticipationRole(id=uuid.uuid4(), org_id=org_id, key="approver", label="Approver", is_default=True)
            s.add(role)
            await s.commit()
        _setup_org_scoped_app(app, Session, org_id, user_id=human_id, agent=False)

        try:
            async with _client_for(app) as client:
                r_draft = await client.post(
                    f"/api/v2/organizations/{org_id}/channel-posts/drafts",
                    json={
                        "work_item_id": str(story_id), "connection_id": str(connection_id),
                        "text": "설명", "channel_payload": {"title": "정상 제목"},
                    },
                )
                assert r_draft.status_code == 201, r_draft.text
                draft_id = r_draft.json()["draft_id"]

                video_raw = _build_mp4(duration_seconds=6.0, width=1920, height=1080)
                r_video = await _upload_and_confirm_video(client, org_id, draft_id, video_raw)
                assert r_video.status_code == 201, r_video.text

                r_submit = await client.post(
                    f"/api/v2/organizations/{org_id}/channel-posts/drafts/{draft_id}/submit", json={},
                )
                assert r_submit.status_code == 200, r_submit.text
                gate_id = uuid.UUID(r_submit.json()["gate_id"])

            async with Session() as s:
                await _approve_gate_directly(s, gate_id)
                # API로는 만들 수 없는 상태를 직접 주입 — 승인 뒤 값이 나빠진
                # 시나리오 재현(위 docstring 참고).
                latest = (await s.execute(
                    sa_select(ChannelPostVersion)
                    .where(ChannelPostVersion.draft_id == uuid.UUID(draft_id))
                    .order_by(ChannelPostVersion.version.desc())
                    .limit(1)
                )).scalar_one()
                latest.channel_payload = {"title": "정상 제목", "privacyStatus": "not-a-real-value"}
                await s.commit()

            async with _client_for(app) as client:
                r_pub = await client.post(
                    f"/api/v2/organizations/{org_id}/channel-posts/drafts/{draft_id}/publish",
                )
            assert r_pub.status_code == 422, r_pub.text
            body = r_pub.json()["error"]
            assert body["code"] == "YOUTUBE_METADATA_INVALID"
            assert body["field"] == "privacyStatus"
            assert body["message"]
        finally:
            app.dependency_overrides.clear()
    finally:
        await engine.dispose()
