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
            await check_youtube_quota_or_raise(s, channel="youtube", estimated_units=1_600)
    finally:
        await engine.dispose()


@pytest.mark.anyio
async def test_check_youtube_quota_or_raise_exceeds_includes_reset_at_pacific_midnight():
    """story #3815(배포 83 픽셀 결함, 페드루 PO 지적 2026-09-12 23:50Z) — 이전엔
    UTC 자정으로 pin했으나(실 YouTube quota는 태평양 시간 자정 리셋, ⚠️미확認 —
    channel_adapters.py quota_reset_timezone 주석 참고) 어댑터 선언(youtube=
    America/Los_Angeles)으로 정정. 2026-09-12는 PDT(UTC-7, DST 기간) 구간이라
    그날 UTC 15:30(태평양 로컬 08:30, 아직 그날 안)의 「오늘」 경계는 태평양
    자정=UTC 07:00 다음날."""
    from app.core.config import settings
    from app.services.youtube_quota import YouTubeQuotaExceededError, check_youtube_quota_or_raise

    engine, Session = await _session_factory()
    try:
        now = datetime(2026, 9, 12, 15, 30, 0, tzinfo=timezone.utc)
        async with Session() as s:
            with pytest.raises(YouTubeQuotaExceededError) as exc_info:
                await check_youtube_quota_or_raise(
                    s, channel="youtube",
                    estimated_units=settings.youtube_quota_daily_limit_units + 1, now=now,
                )
        exc = exc_info.value
        assert exc.limit_units == settings.youtube_quota_daily_limit_units
        assert exc.spent_units == 0
        assert exc.remaining_units == settings.youtube_quota_daily_limit_units
        assert exc.reset_timezone == "America/Los_Angeles"
        assert exc.reset_at == datetime(2026, 9, 13, 7, 0, 0, tzinfo=timezone.utc), (
            "reset_at은 «내일 날짜»가 아니라 태평양 시간(PDT, UTC-7) 자정의 정확한 UTC 시각이어야 한다"
        )
    finally:
        await engine.dispose()


@pytest.mark.anyio
async def test_check_youtube_quota_or_raise_reset_at_crosses_dst_boundary_pst():
    """양성대조 — PST(표준시, UTC-8) 구간(1월)에서도 같은 어댑터 선언이 올바른
    오프셋을 낸다(DST가 하드코딩 상수가 아니라 ZoneInfo가 실제로 반영한다는
    증거 — PDT 케이스만 pin하면 서머타임 전환 버그를 못 잡는다)."""
    from app.core.config import settings
    from app.services.youtube_quota import YouTubeQuotaExceededError, check_youtube_quota_or_raise

    engine, Session = await _session_factory()
    try:
        now = datetime(2026, 1, 12, 15, 30, 0, tzinfo=timezone.utc)
        async with Session() as s:
            with pytest.raises(YouTubeQuotaExceededError) as exc_info:
                await check_youtube_quota_or_raise(
                    s, channel="youtube",
                    estimated_units=settings.youtube_quota_daily_limit_units + 1, now=now,
                )
        exc = exc_info.value
        assert exc.reset_at == datetime(2026, 1, 13, 8, 0, 0, tzinfo=timezone.utc), (
            "PST(UTC-8) 구간의 리셋 경계가 틀렸다 — DST 전환이 반영 안 됐을 가능성"
        )
    finally:
        await engine.dispose()


def test_youtube_usage_exceeded_wording_derives_from_declared_timezone_and_matches_fe():
    """⭐드리프트 가드(story #3815, 배포 83 픽셀 결함, 페드루 PO 지적 2026-09-12
    23:50Z 정정) — 옛 pin은 "UTC 자정→KST 9시"를 계산해 정적 문구와 대조했으나,
    실 리셋 시간대가 America/Los_Angeles(DST 有)로 바뀌어 "9시" 같은 고정
    시각으로는 더 이상 못 박을 수 없다(PDT/PST 전환에 따라 실제로 흔들린다).
    이제 문구는 `{tz_display}` 자리에 `youtube` 채널이 선언한 `quota_reset_
    timezone`(=`America/Los_Angeles`)을 `TIMEZONE_DISPLAY_NAMES`로 조회한 값을
    끼워 넣는다 — reset_at 계산(위 두 테스트)과 문구 조립이 같은 선언값 하나에서
    파생됨을 이 테스트가 고정한다(어댑터 선언을 다른 tz로 바꾸면 이 테스트가
    아니라 TIMEZONE_DISPLAY_NAMES KeyError로 먼저 죽는다 — fail-closed).

    FE `failure-action-badge.tsx`의 `channelPostsFailureYoutubeQuotaExceeded`
    (ko/en)가 이 BE 문구를 그대로 복제한다(dead_letter 배지용, #4238 CHANGES 1과
    동형) — byte-exact 유지."""
    import json
    from pathlib import Path

    from app.services.channel_adapters import get_channel_adapter
    from app.services.i18n_catalog import TIMEZONE_DISPLAY_NAMES, t

    youtube_tz = get_channel_adapter("youtube").quota_reset_timezone
    assert youtube_tz == "America/Los_Angeles", (
        "어댑터 선언이 바뀌었다 — 아래 카탈로그 문장·TIMEZONE_DISPLAY_NAMES도 같이 재확認할 것"
    )
    assert youtube_tz in TIMEZONE_DISPLAY_NAMES, (
        f"{youtube_tz!r}가 TIMEZONE_DISPLAY_NAMES에 없다 — 라우터가 KeyError로 죽는다"
    )

    ko = t("channel_posts.youtube_usage_exceeded", "ko", tz_display=TIMEZONE_DISPLAY_NAMES[youtube_tz]["ko"])
    en = t("channel_posts.youtube_usage_exceeded", "en", tz_display=TIMEZONE_DISPLAY_NAMES[youtube_tz]["en"])
    assert "태평양 시간" in ko
    assert "Pacific Time" in en
    assert "오전 9시" not in ko, "옛 UTC 고정 가정 문구가 남아 있다"
    assert "00:00 UTC" not in en, "옛 UTC 고정 가정 문구가 남아 있다"

    repo_root = Path(__file__).resolve().parents[2]
    fe_ko = json.loads((repo_root / "apps/web/messages/ko.json").read_text())
    fe_en = json.loads((repo_root / "apps/web/messages/en.json").read_text())
    fe_ko_quota = fe_ko["content"]["channelPostsFailureYoutubeQuotaExceeded"]
    fe_en_quota = fe_en["content"]["channelPostsFailureYoutubeQuotaExceeded"]
    assert fe_ko_quota == ko, (
        f"apps/web/messages/ko.json의 content.channelPostsFailureYoutubeQuotaExceeded"
        f"가 BE i18n_catalog 원문과 갈렸다 — 화면 쪽이 바뀌면 이 문구도 같이 바꿀 것"
        f"\nFE: {fe_ko_quota!r}\nBE: {ko!r}"
    )
    assert fe_en_quota == en, (
        f"apps/web/messages/en.json의 content.channelPostsFailureYoutubeQuotaExceeded"
        f"가 BE i18n_catalog 원문과 갈렸다 — 화면 쪽이 바뀌면 이 문구도 같이 바꿀 것"
        f"\nFE: {fe_en_quota!r}\nEN: {en!r}"
    )


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
                await check_youtube_quota_or_raise(s, channel="youtube", estimated_units=1_000)
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
async def test_youtube_sandbox_permalink_uses_invalid_domain_not_real_youtube():
    """발견 즉시 수정(페드루 PO 라이브 실측, 배포 82 회차 2026-09-12 17:12Z) —
    sandbox 발행이 실 도메인(youtube.com)을 공개 URL로 냈다. sandbox 규율은
    `.invalid`(RFC 2606, x_sandbox·ghost_sandbox와 동형)."""
    from app.services.youtube_sandbox_publish import get_permalink

    permalink = await get_permalink(httpx.AsyncClient(), access_token="at", media_id="media-1")
    assert permalink is not None
    assert permalink.startswith("https://youtube-sandbox.invalid/")
    assert "youtube.com" not in permalink


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


# ─── ⑦ privacy_locked 노출(미르코 시드 中 발견 실 결함) ────────────────────────

@pytest.mark.anyio
async def test_privacy_locked_exposed_true_on_publish_response_and_draft_list(monkeypatch):
    """⭐실 결함 재현(페드루 PO 지적 2026-09-13) — migration 0372가 신설한
    `channel_publications.privacy_locked`가 어느 응답에도 안 실려 왔다. FE가
    이 값을 못 읽으면 연결 레벨의 "지금" 감사-미완 플래그로 대리 판정할
    수밖에 없는데, 감사가 끝나 그 플래그가 꺼지면 "그때 잠겼던 과거
    발행물"이 안 잠겼던 것처럼 보인다 — 정확히 0372가 막으려던 사고."""
    from app.core.config import settings
    from tests.test_620beefc_channel_post_image_upload import (
        _approve_gate_directly, _client_for, _seed_connection, _seed_human, _seed_org, _seed_story,
        _session_factory, _setup_org_scoped_app,
    )
    from tests.test_3554_instagram_reels import _build_mp4, _upload_and_confirm_video
    from app.main import app

    monkeypatch.setattr(settings, "youtube_api_audit_incomplete", True)

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
                        "text": "잠금 노출 재현", "channel_payload": {"title": "잠금 노출 재현"},
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

            async with _client_for(app) as client:
                # 첫 호출은 컨테이너 생성만(비동기 관례 — 막 만든 컨테이너를 곧바로
                # poll하지 않는다, processing=true) — 두 번째 호출이 실제 "published"
                # 로 마무리한다(sandbox는 결정적으로 즉시 FINISHED).
                r_pub1 = await client.post(
                    f"/api/v2/organizations/{org_id}/channel-posts/drafts/{draft_id}/publish",
                )
                assert r_pub1.status_code == 200, r_pub1.text
                assert r_pub1.json()["processing"] is True

                r_pub2 = await client.post(
                    f"/api/v2/organizations/{org_id}/channel-posts/drafts/{draft_id}/publish",
                )
                assert r_pub2.status_code == 200, r_pub2.text
                assert r_pub2.json()["processing"] is False
                assert r_pub2.json()["privacy_locked"] is True, "publish 완료 응답에 privacy_locked이 안 실림"

                r_list = await client.get(f"/api/v2/organizations/{org_id}/channel-posts/drafts")
                assert r_list.status_code == 200, r_list.text
                item = next(row for row in r_list.json() if row["draft_id"] == draft_id)
                assert item["privacy_locked"] is True, "목록/단건 응답에 privacy_locked이 안 실림"
        finally:
            app.dependency_overrides.clear()
    finally:
        await engine.dispose()


@pytest.mark.anyio
async def test_privacy_locked_false_for_non_youtube_channel():
    """양성대조 — youtube/youtube_sandbox 축이 없는 채널(threads)은 privacy_locked
    이 항상 False(server_default 그대로, 새 열이 기존 채널 회귀 0)."""
    from tests.test_620beefc_channel_post_image_upload import (
        _approve_gate_directly, _client_for, _create_draft, _seed_connection, _seed_human, _seed_org,
        _seed_story, _session_factory, _setup_org_scoped_app,
    )
    from app.main import app

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org_id, project_id = await _seed_org(s)
            human_id = await _seed_human(s, org_id, project_id)
            connection_id = await _seed_connection(s, org_id, channel="threads")
            story_id = await _seed_story(s, org_id, project_id)
            from app.models.participation import ParticipationRole
            role = ParticipationRole(id=uuid.uuid4(), org_id=org_id, key="approver", label="Approver", is_default=True)
            s.add(role)
            await s.commit()
        _setup_org_scoped_app(app, Session, org_id, user_id=human_id, agent=False)

        try:
            async with _client_for(app) as client:
                draft_id = await _create_draft(client, org_id=org_id, connection_id=connection_id, story_id=story_id)
                r_submit = await client.post(
                    f"/api/v2/organizations/{org_id}/channel-posts/drafts/{draft_id}/submit", json={},
                )
                assert r_submit.status_code == 200, r_submit.text
                gate_id = uuid.UUID(r_submit.json()["gate_id"])

            async with Session() as s:
                await _approve_gate_directly(s, gate_id)

            import app.services.threads_publish as tp
            with (
                patch.object(tp, "get_publishing_limit", AsyncMock(return_value=(0, 100, 3600))),
                patch.object(tp, "create_container", AsyncMock(return_value="container-1")),
                patch.object(tp, "publish_container", AsyncMock(return_value="media-1")),
                patch.object(tp, "get_permalink", AsyncMock(return_value="https://threads.net/p/1")),
            ):
                async with _client_for(app) as client:
                    r_pub = await client.post(
                        f"/api/v2/organizations/{org_id}/channel-posts/drafts/{draft_id}/publish",
                    )
            assert r_pub.status_code == 200, r_pub.text
            assert r_pub.json()["privacy_locked"] is False

            async with _client_for(app) as client:
                r_list = await client.get(f"/api/v2/organizations/{org_id}/channel-posts/drafts")
            item = next(row for row in r_list.json() if row["draft_id"] == draft_id)
            assert item["privacy_locked"] is False
        finally:
            app.dependency_overrides.clear()
    finally:
        await engine.dispose()


# ─── 배포 82 라이브 회차 실 결함 — dead_letter reason_code/reason_reset_at 노출 ──


@pytest.mark.anyio
async def test_youtube_quota_exceeded_publish_persists_reason_code_and_reset_at_on_command():
    """⭐실 결함 재현(페드루 PO 지적 2026-09-12, 배포 82 라이브 회차) — publish가
    422 YOUTUBE_QUOTA_EXCEEDED로 끝나면 command가 dead_letter로 떨어지는데(
    failure_kind가 _CONNECTION_BLOCKED_CODES/_TRANSIENT_CODES 매핑표 밖이라
    needs_check→dead_letter fail-closed) `apply_command_failure()`가 이
    error_code를 `command.reason_code`에 한 번도 안 옮겨, BE는 사유(사용량
    소진·리셋 시각)를 이미 아는데 목록 응답(`command_reason_code`)은 계속
    null이었다 — 화면이 "채널에서 확인이 필요합니다"류 일반 문구만 보여줄
    수밖에 없던 원인. 처방 뒤엔 목록 응답에 정확한 값이 실려야 한다."""
    from tests.test_620beefc_channel_post_image_upload import (
        _approve_gate_directly, _client_for, _seed_connection, _seed_human, _seed_org, _seed_story,
        _session_factory, _setup_org_scoped_app,
    )
    from tests.test_3554_instagram_reels import _build_mp4, _upload_and_confirm_video
    from app.main import app

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

        from app.services.youtube_quota import _platform_quota_day_window
        before = datetime.now(timezone.utc)
        _, expected_reset_at = _platform_quota_day_window(before, "America/Los_Angeles")

        try:
            async with _client_for(app) as client:
                r_draft = await client.post(
                    f"/api/v2/organizations/{org_id}/channel-posts/drafts",
                    json={
                        "work_item_id": str(story_id), "connection_id": str(connection_id),
                        "text": "설명 [sandbox:youtube-quota-exceeded] 끝",
                        "channel_payload": {"title": "quota 재현"},
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

            async with _client_for(app) as client:
                r_pub = await client.post(
                    f"/api/v2/organizations/{org_id}/channel-posts/drafts/{draft_id}/publish",
                )
                assert r_pub.status_code == 422, r_pub.text
                pub_body = r_pub.json()
                assert pub_body["error"]["code"] == "YOUTUBE_QUOTA_EXCEEDED", pub_body

                r_list = await client.get(f"/api/v2/organizations/{org_id}/channel-posts/drafts")
                assert r_list.status_code == 200, r_list.text
                item = next(row for row in r_list.json() if row["draft_id"] == draft_id)
                assert item["command_status"] == "dead_letter", item
                assert item["command_reason_code"] == "YOUTUBE_QUOTA_EXCEEDED", (
                    "BE는 사유를 아는데 command 행엔 안 남았다 — 화면이 일반 dead_letter "
                    f"문구로 떨어지는 원인 그대로(item={item})"
                )
                assert item["command_reason_reset_at"] is not None, "reset_at이 행에 안 남았다"
                actual_reset_at = datetime.fromisoformat(item["command_reason_reset_at"].replace("Z", "+00:00"))
                assert actual_reset_at == expected_reset_at, (
                    f"reset_at이 태평양 시간 자정 경계와 다르다: {actual_reset_at} != {expected_reset_at}"
                )
        finally:
            app.dependency_overrides.clear()
    finally:
        await engine.dispose()


@pytest.mark.anyio
async def test_non_quota_failure_leaves_reason_code_and_reset_at_null_no_regression():
    """양성대조 — 발행이 성공하면(실패 자체가 없음) command_reason_code/
    command_reason_reset_at 둘 다 null 그대로(apply_command_failure를 안
    거치므로 지어낼 값 자체가 없다)."""
    from tests.test_620beefc_channel_post_image_upload import (
        _approve_gate_directly, _client_for, _create_draft, _seed_connection, _seed_human, _seed_org,
        _seed_story, _session_factory, _setup_org_scoped_app,
    )
    from app.main import app

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org_id, project_id = await _seed_org(s)
            human_id = await _seed_human(s, org_id, project_id)
            connection_id = await _seed_connection(s, org_id, channel="threads")
            story_id = await _seed_story(s, org_id, project_id)
            from app.models.participation import ParticipationRole
            role = ParticipationRole(id=uuid.uuid4(), org_id=org_id, key="approver", label="Approver", is_default=True)
            s.add(role)
            await s.commit()
        _setup_org_scoped_app(app, Session, org_id, user_id=human_id, agent=False)

        try:
            async with _client_for(app) as client:
                draft_id = await _create_draft(client, org_id=org_id, connection_id=connection_id, story_id=story_id)
                r_submit = await client.post(
                    f"/api/v2/organizations/{org_id}/channel-posts/drafts/{draft_id}/submit", json={},
                )
                assert r_submit.status_code == 200, r_submit.text
                gate_id = uuid.UUID(r_submit.json()["gate_id"])

            async with Session() as s:
                await _approve_gate_directly(s, gate_id)

            import app.services.threads_publish as tp
            with (
                patch.object(tp, "get_publishing_limit", AsyncMock(return_value=(0, 100, 3600))),
                patch.object(tp, "create_container", AsyncMock(return_value="container-1")),
                patch.object(tp, "publish_container", AsyncMock(return_value="media-1")),
                patch.object(tp, "get_permalink", AsyncMock(return_value="https://threads.net/p/1")),
            ):
                async with _client_for(app) as client:
                    r_pub = await client.post(
                        f"/api/v2/organizations/{org_id}/channel-posts/drafts/{draft_id}/publish",
                    )
            assert r_pub.status_code == 200, r_pub.text

            async with _client_for(app) as client:
                r_list = await client.get(f"/api/v2/organizations/{org_id}/channel-posts/drafts")
            item = next(row for row in r_list.json() if row["draft_id"] == draft_id)
            assert item["command_reason_code"] is None
            assert item["command_reason_reset_at"] is None
        finally:
            app.dependency_overrides.clear()
    finally:
        await engine.dispose()


@pytest.mark.anyio
async def test_apply_command_failure_persists_reason_code_for_arbitrary_mapped_outside_error_code():
    """⭐페드루 PO steer①(2026-09-12 17:34Z) — "지정 코드만 막으면 클래스가
    남는다": reason_code는 error_code 그대로 **항상**(YOUTUBE_QUOTA_EXCEEDED
    전용 분기가 아니라) 옮겨야 다음에 오는 새 코드(다른 채널 quota·다른 422)도
    화면이 「모른다」로 안 떨어진다. CHANNEL_TEXT_TOO_LONG(발행 시점 UTM 재검사,
    페드루 PO 確定 2026-09-03 — text_f8f7cb0f 선례와 동형 재현)으로 실측 —
    이 코드는 YOUTUBE_QUOTA_EXCEEDED와 무관한, 완전히 다른 실패 축이다.
    뮤테이션 대상: apply_command_failure의 `command.reason_code = error_code`를
    "YOUTUBE_QUOTA_EXCEEDED 전용 분기"로 되돌리면 이 테스트가 RED여야 한다."""
    from tests.test_620beefc_channel_post_image_upload import (
        _approve_gate_directly, _client_for, _seed_connection, _seed_human, _seed_org, _seed_story,
        _session_factory, _setup_org_scoped_app,
    )
    from app.main import app

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org_id, project_id = await _seed_org(s)
            human_id = await _seed_human(s, org_id, project_id)
            connection_id = await _seed_connection(s, org_id, channel="threads")
            story_id = await _seed_story(s, org_id, project_id)
            from app.models.participation import ParticipationRole
            role = ParticipationRole(id=uuid.uuid4(), org_id=org_id, key="approver", label="Approver", is_default=True)
            s.add(role)
            await s.commit()
        _setup_org_scoped_app(app, Session, org_id, user_id=human_id, agent=False)

        long_text = "가" * 480  # 단독으로는 한도(500) 밑 — draft 저장 시점 검사를 통과한다.
        long_link = "https://sprintable.ai/ko/blog/" + "x" * 60  # UTM 부착 뒤 발행 시점 재검사에서 넘는다.

        try:
            async with _client_for(app) as client:
                r_draft = await client.post(
                    f"/api/v2/organizations/{org_id}/channel-posts/drafts",
                    json={
                        "work_item_id": str(story_id), "connection_id": str(connection_id),
                        "text": long_text, "link_url": long_link,
                    },
                )
                assert r_draft.status_code == 201, r_draft.text
                draft_id = r_draft.json()["draft_id"]

                r_submit = await client.post(
                    f"/api/v2/organizations/{org_id}/channel-posts/drafts/{draft_id}/submit", json={},
                )
                assert r_submit.status_code == 200, r_submit.text
                gate_id = uuid.UUID(r_submit.json()["gate_id"])

            async with Session() as s:
                await _approve_gate_directly(s, gate_id)

            async with _client_for(app) as client:
                r_pub = await client.post(
                    f"/api/v2/organizations/{org_id}/channel-posts/drafts/{draft_id}/publish",
                )
                assert r_pub.status_code == 422, r_pub.text
                assert r_pub.json()["error"]["code"] == "CHANNEL_TEXT_TOO_LONG"

                r_list = await client.get(f"/api/v2/organizations/{org_id}/channel-posts/drafts")
                item = next(row for row in r_list.json() if row["draft_id"] == draft_id)
                assert item["command_status"] == "dead_letter", item
                assert item["command_reason_code"] == "CHANNEL_TEXT_TOO_LONG", (
                    f"매핑표 밖 코드가 reason_code에 안 옮겨졌다(item={item})"
                )
                # 이 코드는 "언제 풀리는지" 계산 근거가 없다(사람이 본문을 줄여야
                # 풀리는 종류) — reason_reset_at은 여전히 null이어야 한다.
                assert item["command_reason_reset_at"] is None
        finally:
            app.dependency_overrides.clear()
    finally:
        await engine.dispose()


@pytest.mark.anyio
async def test_scheduled_youtube_quota_exceeded_via_cron_worker_matches_immediate_publish_router():
    """⭐페드루 PO steer①(2026-09-12 17:34Z) "두 경로 합류=한 곳에서만" — 예약
    발행(cron 워커, `_process_one_command`)에서 YOUTUBE_QUOTA_EXCEEDED가 나면
    예전엔 `STATUS_BLOCKED_UNAPPROVED`("blocked_unapproved")를 독자적으로
    채웠는데, 이 값은 FE `CommandStatus` 유니온에 아예 없어(자체 발견) 스케줄
    발행 경로에서만 배지가 안 뜨는 결함이었다. 이제 워커도 `apply_command_
    failure`를 거쳐 즉시-발행 라우터와 완전히 같은 결과(dead_letter+reason_code
    +reason_reset_at)를 내야 한다."""
    from tests.test_620beefc_channel_post_image_upload import (
        _approve_gate_directly, _client_for, _seed_connection, _seed_human, _seed_org, _seed_story,
        _session_factory, _setup_org_scoped_app,
    )
    from tests.test_3554_instagram_reels import _build_mp4, _upload_and_confirm_video
    from app.services.publication_command import process_due_publication_commands
    from app.main import app

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
                        "text": "설명 [sandbox:youtube-quota-exceeded] 끝",
                        "channel_payload": {"title": "quota 예약 재현"},
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

            # 3414 cron-retry 선례(test_cron_worker_generation_budget_exceeded_still_
            # sets_generation_reason_code)와 동형 — submit/approve는 command 행을
            # 스스로 안 만든다(그 행은 /publish 호출이 만든다). 워커만 태우려면
            # command 행을 직접 구성(approved_version=이 draft의 최신 ChannelPostVersion.id).
            async with Session() as s:
                from app.models.publication_command import PublicationCommand
                from app.models.channel_post_version import ChannelPostVersion
                from sqlalchemy import select as _select
                version_id = (await s.execute(
                    _select(ChannelPostVersion.id)
                    .where(ChannelPostVersion.draft_id == uuid.UUID(draft_id))
                    .order_by(ChannelPostVersion.version.desc())
                    .limit(1)
                )).scalar_one()
                cmd = PublicationCommand(
                    id=uuid.uuid4(), org_id=org_id, gate_id=gate_id, destination=connection_id,
                    approved_version=version_id, operation="publish",
                    scheduled_at=datetime.now(timezone.utc) - timedelta(minutes=1), status="pending",
                    requested_by_member_id=human_id,
                )
                s.add(cmd)
                await s.commit()

            async with Session() as s:
                await process_due_publication_commands(s)

            async with _client_for(app) as client:
                r_list = await client.get(f"/api/v2/organizations/{org_id}/channel-posts/drafts")
            item = next(row for row in r_list.json() if row["draft_id"] == draft_id)
            assert item["command_status"] == "dead_letter", (
                f"예약 경로가 즉시-발행 라우터와 다른 terminal 상태를 냈다(item={item})"
            )
            assert item["command_reason_code"] == "YOUTUBE_QUOTA_EXCEEDED"
            assert item["command_reason_reset_at"] is not None
        finally:
            app.dependency_overrides.clear()
    finally:
        await engine.dispose()
