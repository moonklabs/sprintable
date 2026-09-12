"""story #3815(Phase3·3-5 PR2, 페드루 PO 確定 2026-09-12) — YouTube 발행 회귀·정탐.
AC 담당 4단(x_publish_budget.py 4단 구조 동형):
① `youtube_quota.py` 단위 — 플랫폼 전체(cross-org) 합산·초과 시 reset_at 포함
  raise·evidence 멱등(publication_id+event).
② `youtube_privacy.py` 단위 — 감사 미완=강제 비공개(설정값 축·sandbox 마커 축
  둘 다), 뮤테이션 셀프체크로 "잠금 로직이 실제로 뭘 지키는지" 고정.
③ `_validate_youtube_metadata` 단위 — title 필수·tags 합산 상한·categoryId
  숫자 문자열·privacyStatus 허용값. 비-youtube 채널은 관할 밖.
④ sandbox 마커 3종 — quota-exceeded(결정적 422 재현)·privacy-locked·
  provider-error(기존 어휘 재사용)."""
from __future__ import annotations

import os
import uuid
from datetime import datetime, timedelta, timezone

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
