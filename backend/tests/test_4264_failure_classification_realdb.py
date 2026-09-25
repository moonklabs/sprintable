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
    "INSTAGRAM_REPLY_MISSING_ID", "FACEBOOK_REPLY_MISSING_ID", "FACEBOOK_CREATE_CAROUSEL_PARENT_MISSING_ID",
    "THREADS_PUBLISH_CONTAINER_FAILED", "INSTAGRAM_PUBLISH_CONTAINER_FAILED", "FACEBOOK_CREATE_POST_FAILED",
    "FACEBOOK_CREATE_CAROUSEL_PARENT_FAILED", "FACEBOOK_REELS_FINISH_FAILED", "X_POST_TWEET_FAILED",
    "YOUTUBE_UPLOAD_PUT_FAILED", "FACEBOOK_REPLY_FAILED", "INSTAGRAM_REPLY_FAILED", "STIBEE_PUBLISH_PROVIDER_ERROR",
    "SITE_POST_PROVIDER_ERROR", "YOUTUBE_VIDEO_STATUS_FAILED",
]
# 공급자에 보이는 글을 만드는 쓰기 호출 **전** 단계 — 자동 재시도 안전(까디르 codex P1 · PO 17:33Z: transient는 명시 목록만).
RETRY_SAFE = [
    "THREADS_CREATE_CONTAINER_FAILED", "THREADS_CREATE_CONTAINER_MISSING_ID", "THREADS_CONTAINER_STATUS_FAILED",
    "THREADS_CONTAINER_STATUS_MISSING_FIELD", "THREADS_PUBLISHING_LIMIT_FAILED", "THREADS_PUBLISHING_LIMIT_MISSING_FIELDS",
    "THREADS_REPLY_CREATE_CONTAINER_FAILED", "THREADS_REPLY_CREATE_CONTAINER_MISSING_ID",
    "INSTAGRAM_CREATE_CONTAINER_FAILED", "INSTAGRAM_CREATE_CONTAINER_MISSING_ID",
    "INSTAGRAM_CREATE_CAROUSEL_CHILD_FAILED", "INSTAGRAM_CREATE_CAROUSEL_CHILD_MISSING_ID",
    "INSTAGRAM_CREATE_CAROUSEL_PARENT_FAILED", "INSTAGRAM_CREATE_CAROUSEL_PARENT_MISSING_ID",
    "INSTAGRAM_CREATE_REELS_CONTAINER_FAILED", "INSTAGRAM_CREATE_REELS_CONTAINER_MISSING_ID",
    "INSTAGRAM_CONTAINER_STATUS_FAILED", "INSTAGRAM_CONTAINER_STATUS_MISSING_FIELD",
    "INSTAGRAM_PUBLISHING_LIMIT_FAILED", "INSTAGRAM_PUBLISHING_LIMIT_MISSING_FIELDS",
    "FACEBOOK_CREATE_CAROUSEL_CHILD_FAILED", "FACEBOOK_CREATE_CAROUSEL_CHILD_MISSING_ID",
    "FACEBOOK_REELS_START_FAILED", "FACEBOOK_REELS_START_MISSING_FIELDS", "FACEBOOK_REELS_UPLOAD_FAILED",
    "X_MEDIA_INIT_FAILED", "X_MEDIA_INIT_MISSING_ID", "X_MEDIA_APPEND_FAILED", "X_MEDIA_FINALIZE_FAILED", "X_MEDIA_STATUS_FAILED",
    "YOUTUBE_UPLOAD_SESSION_INIT_FAILED", "YOUTUBE_UPLOAD_SESSION_MISSING_LOCATION",
    "THREADS_DELETE_MEDIA_FAILED", "FACEBOOK_DELETE_POST_FAILED",  # 회수(삭제) — 다시 해도 같은 결과
    "SANDBOX_PROVIDER_ERROR", "SANDBOX_INSTAGRAM_PROVIDER_ERROR",  # sandbox 컨테이너 생성 단계(실 코드와 같은 부류)
    "SANDBOX_FACEBOOK_CAROUSEL_CHILD_FAILED", "SANDBOX_INSTAGRAM_CAROUSEL_CHILD_FAILED",  # sandbox 캐러셀 자식(부모 게시 전)
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
    # 읽기 경로(인사이트 · 댓글 수집 공급자 5xx)가 쓰는 코드 — transient 유지. 발행 경로는 이 코드를 안 낸다(아래 헬퍼 테스트).
    "CHANNEL_PUBLISH_PROVIDER_ERROR": "transient", "CHANNEL_RATE_LIMITED": "transient",
    "CHANNEL_PUBLISH_IN_PROGRESS": "needs_check", "CHANNEL_IMAGE_CONTAINER_FAILED": "needs_check",
    # 뜻이 둘이거나(광고 멈추기 실패 = 지출 중일 수 있음) 일반 공급자 오류(4xx · 5xx · 타임아웃이 섞임) — 모름.
    "META_ADS_CAMPAIGN_STATUS_UPDATE_FAILED": "needs_check", "NEWSLETTER_SEND_PROVIDER_ERROR": "needs_check",
    "ADS_BOOST_PROVIDER_ERROR": "needs_check", "SOMETHING_UNKNOWN": "needs_check", None: "needs_check",
    "CHANNEL_PUBLISH_PROVIDER_CODE_MISSING": "needs_check",
}


def test_one_table_classifies_every_code():
    """뮤테이션: «200 id 없음» 모음을 transient로 되돌리면(모음에서 빼면) 첫 단언이 RED."""
    from app.services.publication_command import classify_failure_kind

    assert {c: classify_failure_kind(c) for c in MAYBE_SENT} == dict.fromkeys(MAYBE_SENT, "needs_check")
    assert {c: classify_failure_kind(c) for c in RETRY_SAFE} == dict.fromkeys(RETRY_SAFE, "transient")
    assert {c: classify_failure_kind(c) for c in NOT_SENT} == dict.fromkeys(NOT_SENT, "not_sent")
    assert {c: classify_failure_kind(c) for c in UNCHANGED} == UNCHANGED


def test_the_two_sets_do_not_overlap_and_match_the_module():
    from app.services import publication_command as pc

    assert pc._MAYBE_SENT_CODES == frozenset(MAYBE_SENT)
    assert pc._NOT_SENT_CODES == frozenset(NOT_SENT)
    assert pc._RETRY_SAFE_CODES == frozenset(RETRY_SAFE)
    assert not pc._MAYBE_SENT_CODES & pc._NOT_SENT_CODES
    assert not pc._RETRY_SAFE_CODES & (pc._MAYBE_SENT_CODES | pc._NOT_SENT_CODES)
    # 4272(develop) — 공급자 쓰기 호출 전 코드 없는 예외(`PRE_CALL_ERROR_CODE`)도 «안 나감» 증거가 있는 재시도 안전 부류.
    assert pc._TRANSIENT_CODES == frozenset(
        {"CHANNEL_PUBLISH_PROVIDER_ERROR", "CHANNEL_RATE_LIMITED", pc.PRE_CALL_ERROR_CODE, *RETRY_SAFE}
    ), "transient는 명시 목록만(까디르 codex P1)"


def test_provider_codes_pass_through_and_an_unknown_one_is_needs_check_not_auto_retry():
    """까디르 codex P1(PO 17:33Z) — 예전 정답(«모르는 코드 → 일반 공급자 오류» = transient = 자동 재시도)을 뒤집는다. 모르는 코드는
    나갔는지 모르니 기본값 needs_check. 뮤테이션: 헬퍼를 예전처럼 모르는 코드 → CHANNEL_PUBLISH_PROVIDER_ERROR로 되돌리면 RED."""
    from app.services.publication_command import (
        PROVIDER_CODE_MISSING,
        classify_failure_kind,
        provider_error_code,
    )

    assert provider_error_code("X_POST_TWEET_MISSING_ID") == "X_POST_TWEET_MISSING_ID"
    assert provider_error_code("STIBEE_PLAN_RESTRICTED") == "STIBEE_PLAN_RESTRICTED"
    assert provider_error_code("THREADS_CREATE_CONTAINER_FAILED") == "THREADS_CREATE_CONTAINER_FAILED"
    assert provider_error_code("SOMETHING_UNKNOWN") == "SOMETHING_UNKNOWN"
    assert provider_error_code(None) == PROVIDER_CODE_MISSING
    assert classify_failure_kind(provider_error_code("SOMETHING_UNKNOWN")) == "needs_check"
    assert classify_failure_kind(provider_error_code(None)) == "needs_check"
    assert classify_failure_kind(provider_error_code("THREADS_CREATE_CONTAINER_FAILED")) == "transient"


def test_the_blog_write_failure_is_may_have_gone_out_and_the_unpublish_retry_stays():
    """블로그 글 쓰기 호출의 non-2xx는 글이 이미 생겼을 수 있다(needs_check) · 회수(삭제) 재시도는 그대로 transient."""
    from app.services.publication_command import classify_failure_kind
    from app.services.site_posts import _blog_publish_error_code

    class ProviderDown(Exception):
        status_code = 502

    assert classify_failure_kind(_blog_publish_error_code(ProviderDown(), writing=True)) == "needs_check"
    assert classify_failure_kind(_blog_publish_error_code(ProviderDown())) == "transient"


# ── ③ 게시 뒤 조회 실패 — 게시 성공 · id 보존 · permalink만 비움(까디르 codex P1 · PO 17:33Z) ──────────────────────


def _mock_client(routes):
    import httpx

    def handler(request: httpx.Request) -> httpx.Response:
        for (method, needle), response in routes.items():
            if request.method == method and needle in str(request.url):
                return response
        return httpx.Response(500, text="unrouted")

    return httpx.AsyncClient(transport=httpx.MockTransport(handler))


@pytest.mark.anyio
async def test_an_x_tweet_whose_detail_lookup_fails_is_still_published_with_its_id():
    """뮤테이션: `publish_x_thread`의 조회 try를 걷으면 예외가 새 호출부가 실패로 적고 재시도가 같은 tweet을 또 올린다 — RED."""
    import httpx

    from app.services.x_publish import publish_x_thread

    client = _mock_client({
        ("POST", "/2/tweets"): httpx.Response(201, json={"data": {"id": "t1"}}),
        ("GET", "/2/tweets/t1"): httpx.Response(503, text="down"),
    })
    results = await publish_x_thread(client, access_token="tok", texts=["hello"])
    assert results == [{"sequence": 1, "external_id": "t1", "permalink": None}]


@pytest.mark.anyio
async def test_a_threads_reply_whose_permalink_lookup_fails_keeps_its_id():
    import httpx

    from app.services.threads_publish import reply

    client = _mock_client({
        ("POST", "/threads_publish"): httpx.Response(200, json={"id": "r1"}),
        ("POST", "/threads"): httpx.Response(200, json={"id": "c1"}),
        ("GET", "/r1"): httpx.Response(500, text="down"),
    })
    assert await reply(client, access_token="tok", threads_user_id="u1", reply_to_id="p1", text="thanks") == ("r1", None)


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


# ── ⑤ «나갔는지 모름»으로 멈춘 명령에 새 발행 요청 — 어댑터 0 · 409(유나 4632 CHANGES · PO 처방) ──────────────────────


def _not_sent_code():
    from app.services import publication_command as pc

    return min(pc._NOT_SENT_CODES)


@pytest.mark.anyio
@pytest.mark.parametrize("first_code, first_kind, second_calls", [
    ("X_POST_TWEET_MISSING_ID", "needs_check", 0),
    ("THREADS_CREATE_CONTAINER_FAILED", "transient", 1),
    (None, "not_sent", 1),
])
async def test_a_second_publish_on_a_needs_check_command_is_refused_without_calling_the_adapter(
    monkeypatch, first_code, first_kind, second_calls,
):
    """첫 발행이 needs_check로 멈춘 뒤 `POST …/publish`를 또 누르면 409 CHANNEL_POST_NEEDS_CHECK · 어댑터 호출 0 · 명령 그대로.
    transient · not_sent로 멈춘 명령은 종전대로 다시 부른다(1). 뮤테이션: 라우터의 `raise_if_needs_check`를 빼면 첫 줄이 호출
    1 · 응답 503으로 RED."""
    from sqlalchemy import select

    from app.models.publication_command import PublicationCommand
    from app.routers import channel_posts as router_module
    from app.services.channel_posts import ChannelPublishProviderError

    code = first_code or _not_sent_code()
    calls = {"n": 0}

    async def _raises(*_args, **_kwargs):
        calls["n"] += 1
        raise ChannelPublishProviderError(provider_code=code, provider_message="stub")

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
                url = f"/api/v2/organizations/{org_id}/channel-posts/drafts/{draft_id}/publish"
                await client.post(url)
                async with Session() as s:
                    first = (await s.execute(select(PublicationCommand).where(PublicationCommand.org_id == org_id))).scalar_one()
                assert first.failure_kind == first_kind
                before = (first.status, first.attempt_count, first.reason_code)
                calls["n"] = 0
                r = await client.post(url, headers={"Accept-Language": "ko"})
        finally:
            app.dependency_overrides.clear()
        assert calls["n"] == second_calls
        if second_calls:
            assert r.status_code != 409, r.text
            return
        assert r.status_code == 409, r.text
        detail = r.json()["error"]
        assert detail["code"] == "CHANNEL_POST_NEEDS_CHECK"
        assert detail["command_id"] == str(first.id)
        assert (detail["failure_kind"], detail["command_status"]) == ("needs_check", "dead_letter")
        assert detail["message"].startswith("채널에 이미 나갔을 수 있어서 다시 보내지 않았어요")
        async with Session() as s:
            after = (await s.execute(select(PublicationCommand).where(PublicationCommand.org_id == org_id))).scalar_one()
        assert (after.status, after.attempt_count, after.reason_code) == before, "거절이 명령을 건드렸다"
    finally:
        await engine.dispose()


@pytest.mark.anyio
async def test_recipe_auto_publish_does_not_resend_a_needs_check_command(monkeypatch):
    """레시피 ⓓ 승인이 자동 발행하는 길도 같은 문 — 같은 승인본의 명령이 needs_check로 멈춰 있으면 어댑터 0 · 게이트 결과
    `publish_failed:needs_check`(«다시 승인» 안내가 아니다) · 명령 그대로. 뮤테이션: `publish_recipe_approved_draft`의 가드를 빼면
    어댑터 호출 1 · outcome published로 RED."""
    from sqlalchemy import select

    import app.services.channel_posts as channel_posts_module
    import tests.test_4142_recipe_async_video_publish_command_realdb as t4142
    from app.main import app
    from app.models.channel_post_version import ChannelPostVersion
    from app.models.gate import Gate
    from app.models.publication_command import PublicationCommand
    from app.services.gate_service import transition_gate
    from app.services.publication_command import create_or_get_publication_command
    from tests.recipe_reviewed_draft import reviewed_draft_for

    real_adapter = channel_posts_module.publish_channel_post_draft
    calls = {"n": 0}

    async def _counting(*args, **kwargs):
        calls["n"] += 1
        return await real_adapter(*args, **kwargs)

    monkeypatch.setattr(channel_posts_module, "publish_channel_post_draft", _counting)
    engine, Session = await t4142._realdb_session()
    try:
        async with Session() as s:
            org_id, project_id, owner_member_id, _owner_user_id = await t4142._seed_org_with_owner(s, slug="4264nc")
            await t4142._seed_default_role(s, org_id)
            await t4142._seed_system_publisher_teammember_shim(s, org_id, project_id)
            creator_id = await t4142._seed_agent(s, org_id, project_id, name="댄")
            story_id = await t4142._seed_story(s, org_id, project_id)
            await t4142._seed_definition(s)
            connection_id = await t4142._seed_text_sandbox_connection(s, org_id)
            await t4142._seed_recipe_channel_binding(s, org_id, connection_id)
            gate_d_id = await t4142._walk_to_pending_approval_with_abc_approved(
                s, org_id=org_id, story_id=story_id, creator_id=creator_id, owner_member_id=owner_member_id,
            )

        t4142._setup_org_scoped_app(app, Session, org_id, user_id=creator_id, agent=True)
        async with t4142._client_for(app) as client:
            r_draft = await client.post(
                f"/api/v2/organizations/{org_id}/channel-posts/drafts",
                json={"work_item_id": str(story_id), "connection_id": str(connection_id), "text": "4264 needs_check"},
            )
            draft_id = uuid.UUID(r_draft.json()["draft_id"])
            r_submit = await client.post(f"/api/v2/organizations/{org_id}/channel-posts/drafts/{draft_id}/submit", json={})
            assert r_submit.status_code == 200, r_submit.text
            scoped_gate_id = uuid.UUID(r_submit.json()["gate_id"])

        # 같은 승인본의 앞 시도가 «나갔는지 모름»으로 멈춘 상태.
        async with Session() as s:
            version = (await s.execute(
                select(ChannelPostVersion).where(ChannelPostVersion.draft_id == draft_id)
                .order_by(ChannelPostVersion.version.desc()).limit(1)
            )).scalar_one()
            command, _ = await create_or_get_publication_command(
                s, org_id=org_id, gate_id=scoped_gate_id, destination=connection_id,
                approved_version=version.id, requested_by_member_id=owner_member_id, scheduled_at=None,
            )
            command.status, command.failure_kind, command.reason_code = "dead_letter", "needs_check", "X_POST_TWEET_MISSING_ID"
            command.attempt_count = 1
            await s.commit()

        async with Session() as s:
            await transition_gate(
                s, org_id, gate_d_id, "approved", owner_member_id, "ⓓ 발행 승인",
                reviewed_draft=await reviewed_draft_for(s, org_id=org_id, work_item_id=story_id),
            )
            await s.commit()

        assert calls["n"] == 0, "needs_check로 멈춘 명령인데 자동 발행이 어댑터를 또 불렀다"
        async with Session() as s:
            gate_d = await s.get(Gate, gate_d_id)
            row = (await s.execute(select(PublicationCommand).where(PublicationCommand.gate_id == scoped_gate_id))).scalar_one()
        assert gate_d.publish_outcome == "publish_failed:needs_check"
        assert (row.status, row.failure_kind, row.attempt_count) == ("dead_letter", "needs_check", 1)
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()


# ── ④ 승인 필요 · 예산 초과 — 워커와 즉시 발행 라우터가 같은 저장 모양(까디르 codex P2 · PO 17:45Z) ──────────────────


def _blocking_errors():
    from app.services.generation_budget import GenerationBudgetExceededError
    from app.services.site_posts import ExternalPublishGateNotApprovedError

    return [
        (lambda: ExternalPublishGateNotApprovedError(gate_id=None, status="pending"), "EXTERNAL_PUBLISH_APPROVAL_REQUIRED"),
        (lambda: GenerationBudgetExceededError(limit_minor=100, spent_minor=90, estimated_cost_minor=20, remaining_minor=10),
         "GENERATION_BUDGET_EXCEEDED"),
    ]


def _shape(row):
    return (row.status, row.reason_code, row.failure_kind, row.next_attempt_at)


@pytest.mark.parametrize("case", [0, 1])
@pytest.mark.anyio
async def test_approval_and_budget_stops_are_stored_the_same_way_by_the_worker_and_the_router(monkeypatch, case):
    """두 경로 모두 blocked_unapproved + 사유 · 재시도 없음(예전: 워커는 승인 필요 사유 null · 라우터는 dead_letter → «다시 시도»).
    뮤테이션: 라우터를 예전 apply_command_failure로 되돌리면 dead_letter로 RED · 워커 승인 필요 갈래의 사유를 빼면 RED."""
    from sqlalchemy import select

    import app.services.channel_posts as channel_posts_module
    from app.models.publication_command import PublicationCommand
    from app.routers import channel_posts as router_module
    from app.services.publication_command import process_due_publication_commands
    from tests.test_620beefc_channel_post_image_upload import (
        _approve_gate_directly,
        _create_draft,
        _png_bytes,
        _upload_and_confirm,
    )

    make_error, reason = _blocking_errors()[case]

    async def _raises(*_args, **_kwargs):
        raise make_error()

    engine, Session = await _session_factory()
    try:
        # 워커 경로.
        monkeypatch.setattr(channel_posts_module, "publish_channel_post_draft", _raises)
        w = await _world(Session)
        async with Session() as s:
            await process_due_publication_commands(s, now=datetime.now(UTC))
        async with Session() as s:
            worker_row = (await s.execute(select(PublicationCommand).where(PublicationCommand.id == w["cmd_id"]))).scalar_one()

        # 즉시 발행 라우터 경로.
        monkeypatch.setattr(router_module, "publish_channel_post_draft", _raises)
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
                async with Session() as s:
                    await _approve_gate_directly(s, uuid.UUID(r_submit.json()["gate_id"]))
                r = await client.post(f"/api/v2/organizations/{org_id}/channel-posts/drafts/{draft_id}/publish")
        finally:
            app.dependency_overrides.clear()
        assert r.status_code in (403, 422), r.text
        async with Session() as s:
            router_row = (await s.execute(select(PublicationCommand).where(PublicationCommand.org_id == org_id))).scalar_one()

        assert _shape(worker_row) == _shape(router_row) == ("blocked_unapproved", reason, None, None)
    finally:
        await engine.dispose()


@pytest.mark.anyio
async def test_the_insights_board_row_carries_the_same_failure_fields_as_the_channel_post_list():
    """까디르 codex P2(PO 18:51Z) — 성과 보드도 채널 포스트 목록과 같은 실패 필드 넷(같은 이름 · 같은 형식)을 내려야 «나갔을 수 있음» ·
    승인/예산 사유 문장이 같게 뜬다. 뮤테이션: 보드 행에서 필드를 빼면 RED."""
    from datetime import timedelta

    from sqlalchemy import update

    from app.models.publication_command import PublicationCommand
    from app.services.insights_board import list_insights_board
    from tests.test_3766_insights_board_command_status import (
        _seed_channel_publication,
        _seed_command,
        _seed_gate,
    )
    from tests.test_3766_insights_board_command_status import (
        _seed_human as _seed_board_human,
    )
    from tests.test_3766_insights_board_command_status import (
        _seed_org as _seed_board_org,
    )
    from tests.test_3766_insights_board_command_status import (
        _seed_story as _seed_board_story,
    )
    from tests.test_3766_insights_board_command_status import (
        _session_factory as _board_session_factory,
    )

    engine, Session = await _board_session_factory()
    try:
        async with Session() as s:
            org_id, project_id = await _seed_board_org(s)
            story_id = await _seed_board_story(s, org_id, project_id)
            human_id = await _seed_board_human(s, org_id)
            now = datetime.now(UTC)
            gate = await _seed_gate(s, org_id=org_id, work_item_id=story_id)
            cp = await _seed_channel_publication(
                s, org_id=org_id, gate_id=gate.id, channel="threads", published_at=now - timedelta(days=1),
            )
            cmd = await _seed_command(s, org_id=org_id, gate_id=gate.id, requested_by_member_id=human_id, status="dead_letter")
            reset = now + timedelta(hours=3)
            await s.execute(update(PublicationCommand).where(PublicationCommand.id == cmd.id).values(
                failure_kind="needs_check", reason_code="X_POST_TWEET_MISSING_ID", reason_reset_at=reset, next_attempt_at=None,
            ))
            await s.commit()
            result = await list_insights_board(s, org_id=org_id, window="30d")
        row = next(r for r in result["rows"] if r["publication_id"] == cp.id)
        assert (row["command_status"], row["failure_kind"], row["command_reason_code"], row["next_retry_at"]) == (
            "dead_letter", "needs_check", "X_POST_TWEET_MISSING_ID", None,
        )
        assert row["command_reason_reset_at"] == reset.isoformat()
    finally:
        await engine.dispose()
