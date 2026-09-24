"""story #4264(PO 15:18Z) — 발행 실패 코드 → 부류의 한 표.

- «나갔을 수 있음»(공급자 200/201 뒤 id가 비음) → needs_check · 재시도 0(예전엔 transient → 자동 재시도 = 이중 게시).
- «확실히 안 나감»(HTTP 전 검사 · 명시 거절 코드) → not_sent · 곧바로 dead_letter.
- 기존 connection · transient · needs_check 매핑은 그대로. 일반 4xx · 5xx에서 not_sent를 추론하지 않는다.
- 워커 · 즉시 발행 라우터 · 댓글 답글이 같은 헬퍼(`provider_error_code`)로 어댑터 코드를 푼다.
"""
from __future__ import annotations

import os
import uuid
from datetime import UTC, datetime, timedelta

import pytest

from tests.test_620beefc_channel_post_image_upload import (
    _client_for,
    _seed_connection,
    _seed_default_role,
    _seed_human,
    _seed_org,
    _seed_story,
    _session_factory,
    _setup_org_scoped_app,
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
def _local_channel_media_storage(monkeypatch, tmp_path):
    """test_3536과 같은 로컬 채널 미디어 저장소(이미지 있는 인스타그램 초안을 만드는 하네스를 그대로 쓴다)."""
    import app.services.channel_post_images as cpi_module
    from tests.test_620beefc_channel_post_image_upload import _CHANNEL_MEDIA_BUCKET

    monkeypatch.setenv("STORAGE_PROVIDER", "local")
    monkeypatch.setenv("STORAGE_LOCAL_ROOT", str(tmp_path / ".storage-4264"))
    monkeypatch.setattr(cpi_module, "CHANNEL_MEDIA_BUCKET", _CHANNEL_MEDIA_BUCKET)
    monkeypatch.setattr(cpi_module, "_PUBLIC_BASE", f"https://storage.googleapis.com/{_CHANNEL_MEDIA_BUCKET}/")
    yield


@pytest.fixture(autouse=True)
def _configure_secrets(monkeypatch):
    from cryptography.fernet import Fernet

    import app.core.config as config_module
    from app.services.channel_credential_crypto import _get_multi_fernet

    monkeypatch.setattr(config_module.settings, "channel_credential_encryption_key", Fernet.generate_key().decode())
    _get_multi_fernet.cache_clear()
    yield
    _get_multi_fernet.cache_clear()


MAYBE_SENT = [
    "FACEBOOK_CREATE_POST_MISSING_ID", "X_POST_TWEET_MISSING_ID", "YOUTUBE_UPLOAD_MISSING_VIDEO_ID",
    "THREADS_PUBLISH_CONTAINER_MISSING_ID", "INSTAGRAM_PUBLISH_CONTAINER_MISSING_ID",
    "INSTAGRAM_REPLY_MISSING_ID", "FACEBOOK_REPLY_MISSING_ID",
]
NOT_SENT = [
    "NEWSLETTER_SEND_CONNECTION_UNAVAILABLE", "NEWSLETTER_SEND_CHANNEL_UNSUPPORTED",
    "CHANNEL_POST_DRAFT_NOT_FOUND", "CHANNEL_TEXT_TOO_LONG", "SITE_POST_SEAL_MISSING", "YOUTUBE_QUOTA_EXCEEDED",
    "YOUTUBE_METADATA_INVALID", "EXTERNAL_PUBLISH_APPROVAL_REQUIRED", "GENERATION_BUDGET_EXCEEDED",
    "API_USAGE_BUDGET_EXCEEDED", "INSTAGRAM_IMAGE_REQUIRED", "INSTAGRAM_REELS_VIDEO_REQUIRED",
    "FACEBOOK_REELS_VIDEO_REQUIRED", "CHANNEL_REELS_UNSUPPORTED", "CHANNEL_CAROUSEL_UNSUPPORTED",
    "YOUTUBE_IMAGE_CONTAINER_UNSUPPORTED", "X_MEDIA_SOURCE_FETCH_FAILED", "YOUTUBE_VIDEO_SOURCE_FETCH_FAILED",
    "STIBEE_CONNECTION_INCOMPLETE", "STIBEE_PLAN_RESTRICTED", "STIBEE_SENDER_NOT_VERIFIED",
    "SITE_POST_DESTINATION_INSECURE", "SITE_POST_DRAFT_NOT_FOUND", "SITE_POST_NOT_PUBLISHED",
    "COMMENT_REPLY_NOT_FOUND", "COMMENT_NOT_FOUND", "ADS_BOOST_NOT_STARTED_AT_PROVIDER",
    "META_ADS_CAMPAIGN_CREATE_FAILED", "META_ADS_CAMPAIGN_CREATE_MISSING_FIELD", "META_ADS_ADSET_CREATE_FAILED",
    "META_ADS_ADSET_CREATE_MISSING_FIELD", "META_ADS_AD_CREATE_FAILED", "META_ADS_AD_CREATE_MISSING_FIELD",
]
UNCHANGED = {
    "CHANNEL_TOKEN_EXPIRED": "connection", "CHANNEL_CONNECTION_NOT_ACTIVE": "connection",
    "CHANNEL_PUBLISH_AUTH_REJECTED": "connection", "CHANNEL_CONNECTION_REVOKED": "connection",
    "CHANNEL_CONNECTION_AUTH_ERROR": "connection", "GHOST_AUTH_FAILED": "connection",
    "CHANNEL_PUBLISH_PROVIDER_ERROR": "transient", "CHANNEL_RATE_LIMITED": "transient",
    "CHANNEL_PUBLISH_IN_PROGRESS": "needs_check", "CHANNEL_IMAGE_CONTAINER_FAILED": "needs_check",
    # 뜻이 둘이거나(광고 멈추기 실패 = 지출 중일 수 있음) 일반 공급자 오류(4xx · 5xx · 타임아웃이 섞임) — 모름.
    "META_ADS_CAMPAIGN_STATUS_UPDATE_FAILED": "needs_check", "NEWSLETTER_SEND_PROVIDER_ERROR": "needs_check",
    "ADS_BOOST_PROVIDER_ERROR": "needs_check", "SOMETHING_UNKNOWN": "needs_check", None: "needs_check",
}


def test_one_table_classifies_every_code():
    """뮤테이션: «200 id 없음» 모음을 transient로 되돌리면(모음에서 빼면) 첫 단언이 RED."""
    from app.services.publication_command import classify_failure_kind

    assert {c: classify_failure_kind(c) for c in MAYBE_SENT} == dict.fromkeys(MAYBE_SENT, "needs_check")
    assert {c: classify_failure_kind(c) for c in NOT_SENT} == dict.fromkeys(NOT_SENT, "not_sent")
    assert {c: classify_failure_kind(c) for c in UNCHANGED} == UNCHANGED


def test_the_two_sets_do_not_overlap_and_match_the_module():
    from app.services import publication_command as pc

    assert pc._MAYBE_SENT_CODES == frozenset(MAYBE_SENT)
    assert pc._NOT_SENT_CODES == frozenset(NOT_SENT)
    assert not pc._MAYBE_SENT_CODES & pc._NOT_SENT_CODES


def test_provider_codes_in_the_table_are_passed_through_unknown_stay_generic():
    from app.services.publication_command import provider_error_code

    assert provider_error_code("X_POST_TWEET_MISSING_ID") == "X_POST_TWEET_MISSING_ID"
    assert provider_error_code("STIBEE_PLAN_RESTRICTED") == "STIBEE_PLAN_RESTRICTED"
    assert provider_error_code("SOMETHING_UNKNOWN") == "CHANNEL_PUBLISH_PROVIDER_ERROR"
    assert provider_error_code(None) == "CHANNEL_PUBLISH_PROVIDER_ERROR"


@pytest.mark.anyio
async def test_youtube_quota_as_not_sent_keeps_its_reason_and_reset_time():
    """PO 15:18Z — not_sent 갈래가 사용량 사유 · 리셋 시각을 덮지 않는다(화면의 사용량 문장이 그대로 나온다)."""
    from app.models.publication_command import PublicationCommand
    from app.services.publication_command import apply_command_failure

    command = PublicationCommand(
        id=uuid.uuid4(), org_id=uuid.uuid4(), gate_id=uuid.uuid4(), destination=uuid.uuid4(), approved_version=uuid.uuid4(),
        status="in_progress", attempt_count=0, requested_by_member_id=uuid.uuid4(),
    )
    now = datetime.now(UTC)
    reset = now + timedelta(hours=9)
    await apply_command_failure(None, command, error_code="YOUTUBE_QUOTA_EXCEEDED", last_error="q", now=now, reason_reset_at=reset)
    assert (command.status, command.failure_kind, command.reason_code, command.reason_reset_at) == (
        "dead_letter", "not_sent", "YOUTUBE_QUOTA_EXCEEDED", reset,
    )
    assert command.next_attempt_at is None


# ── 워커 · 즉시 발행 라우터(실 PG) ──────────────────────────────────────────────────────────────────────


async def _fake_create_container_ok_but_no_id(client, *, access_token, threads_user_id, text, image_url=None):
    from app.services.threads_publish import ThreadsPublishError

    raise ThreadsPublishError("INSTAGRAM_PUBLISH_CONTAINER_MISSING_ID", "id missing in response", status_code=200)


async def _fake_get_publishing_limit(client, *, access_token, threads_user_id):
    return (0, 100, 24 * 60 * 60)


async def _world(Session):
    from tests.test_3536_channel_image_required import _seed_scheduled_instagram_command

    async with Session() as s:
        org_id, project_id = await _seed_org(s)
        await _seed_default_role(s, org_id)
        human_id = await _seed_human(s, org_id, project_id)
        connection_id = await _seed_connection(s, org_id, channel="instagram")
        story_id = await _seed_story(s, org_id, project_id)
    from app.main import app

    _setup_org_scoped_app(app, Session, org_id, user_id=human_id, agent=False)
    try:
        async with _client_for(app) as client, Session() as s:
            cmd_id = await _seed_scheduled_instagram_command(
                s, client, org_id=org_id, connection_id=connection_id, story_id=story_id, human_id=human_id,
            )
    finally:
        app.dependency_overrides.clear()
    return {"org_id": org_id, "cmd_id": cmd_id, "human_id": human_id}


@pytest.mark.anyio
async def test_the_worker_does_not_auto_retry_a_publish_that_may_have_gone_out(monkeypatch):
    """«200인데 id 없음» → needs_check · 곧바로 dead_letter · 다음 시도 예약 0(자동 재시도 = 이중 게시였다).
    뮤테이션: 워커를 예전처럼 CHANNEL_PUBLISH_PROVIDER_ERROR로 뭉개면 pending + next_attempt_at으로 RED."""
    from sqlalchemy import select

    import app.services.instagram_publish as instagram_publish_module
    from app.models.publication_command import PublicationCommand
    from app.services.publication_command import process_due_publication_commands

    monkeypatch.setattr(instagram_publish_module, "create_container", _fake_create_container_ok_but_no_id)
    monkeypatch.setattr(instagram_publish_module, "get_publishing_limit", _fake_get_publishing_limit)
    engine, Session = await _session_factory()
    try:
        w = await _world(Session)
        async with Session() as s:
            await process_due_publication_commands(s, now=datetime.now(UTC))
        async with Session() as s:
            row = (await s.execute(select(PublicationCommand).where(PublicationCommand.id == w["cmd_id"]))).scalar_one()
        assert (row.status, row.failure_kind, row.reason_code) == (
            "dead_letter", "needs_check", "INSTAGRAM_PUBLISH_CONTAINER_MISSING_ID",
        )
        assert row.next_attempt_at is None and row.attempt_count == 1
    finally:
        await engine.dispose()


@pytest.mark.anyio
async def test_the_immediate_publish_router_uses_the_same_helper(monkeypatch):
    """즉시 발행 라우터도 provider_code를 같은 헬퍼로 푼다 — 예전엔 아예 안 넘겨 transient였다. 응답 계약(503 ·
    CHANNEL_PUBLISH_PROVIDER_ERROR)은 그대로, 명령 분류만 바뀐다."""
    from sqlalchemy import select

    from app.models.publication_command import PublicationCommand
    from app.routers import channel_posts as router_module
    from app.services.channel_posts import ChannelPublishProviderError

    async def _raises(*_args, **_kwargs):
        raise ChannelPublishProviderError(provider_code="X_POST_TWEET_MISSING_ID", provider_message="id missing")

    monkeypatch.setattr(router_module, "publish_channel_post_draft", _raises)
    from tests.test_620beefc_channel_post_image_upload import (
        _approve_gate_directly,
        _create_draft,
        _png_bytes,
        _upload_and_confirm,
    )

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org_id, project_id = await _seed_org(s)
            await _seed_default_role(s, org_id)
            human_id = await _seed_human(s, org_id, project_id)
            connection_id = await _seed_connection(s, org_id, channel="instagram")
            story_id = await _seed_story(s, org_id, project_id)
        from app.main import app

        _setup_org_scoped_app(app, Session, org_id, user_id=human_id, agent=False)
        try:
            async with _client_for(app) as client:
                draft_id = await _create_draft(client, org_id=org_id, connection_id=connection_id, story_id=story_id)
                assert (await _upload_and_confirm(client, org_id, draft_id, _png_bytes(800, 800), content_type="image/png")).status_code == 201
                r_submit = await client.post(f"/api/v2/organizations/{org_id}/channel-posts/drafts/{draft_id}/submit", json={})
                assert r_submit.status_code == 200, r_submit.text
                async with Session() as s:
                    await _approve_gate_directly(s, uuid.UUID(r_submit.json()["gate_id"]))
                r = await client.post(f"/api/v2/organizations/{org_id}/channel-posts/drafts/{draft_id}/publish")
        finally:
            app.dependency_overrides.clear()
        assert r.status_code == 503, r.text
        async with Session() as s:
            row = (await s.execute(select(PublicationCommand).where(PublicationCommand.org_id == org_id))).scalar_one()
        assert (row.status, row.failure_kind, row.reason_code) == ("dead_letter", "needs_check", "X_POST_TWEET_MISSING_ID")
        assert row.next_attempt_at is None
    finally:
        await engine.dispose()
