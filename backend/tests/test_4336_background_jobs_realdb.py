"""story #4336 PR2 ①(PO 04:32Z) — 영상 확정 작업화 · 공용 작업 줄(`background_jobs`) · 이미지 확정 요청 예산.

- 영상 확정 요청은 싼 검사(DB · HEAD)까지 하고 202 + 작업 — 새 버전은 아직 없다. 워커가 돌면 완료 · 결과(영상)가 작업 상태 보기로 온다.
- 작업 상태는 요청한 사람만(다른 사람 · 다른 조직 = 404).
- 워커: 남은 틱 예산 < 종류 최악 소요면 시작 안 함 · 시한 초과는 일시 실패(재시도 · MAX_ATTEMPTS번째면 failed) · 죽은 워커가 남긴 in_progress는
  리스 뒤 다시 집음 · publication-commands 틱이 부른다.
- 이미지 확정: 스토리지 호출이 시한을 넘으면 504 CHANNEL_ASSET_STORAGE_TIMEOUT(코드 있는 본문) — 요청이 끝없이 매달리지 않는다.
"""
from __future__ import annotations

import asyncio
import time
import uuid
from datetime import datetime, timedelta, timezone
from unittest.mock import patch

import pytest

from tests.test_3554_instagram_reels import (  # noqa: F401 — autouse 픽스처 포함
    _REAL_DB_URL,
    _VALID_9_16,
    _build_mp4,
    _client_for,
    _configure_secrets,
    _create_draft,
    _dispose_global_engine_after_test,
    _instagram_sandbox_video_config,
    _local_channel_media_storage,
    _local_channel_media_storage_object_path_fix,
    _object_path_for_video,
    _put_raw_object,
    _seed_connection,
    _seed_human,
    _seed_org,
    _seed_story,
    _session_factory,
    _setup_org_scoped_app,
    anyio_backend,
    run_background_jobs_once,
)

pytestmark = [
    pytest.mark.destructive_schema,
    pytest.mark.skipif(not _REAL_DB_URL, reason="real Postgres 필요"),
]


async def _world(Session, app):
    async with Session() as s:
        org_id, project_id = await _seed_org(s)
        human_id = await _seed_human(s, org_id, project_id)
        connection_id = await _seed_connection(s, org_id, channel="instagram_sandbox")
        story_id = await _seed_story(s, org_id, project_id)
    _setup_org_scoped_app(app, Session, org_id, user_id=human_id, agent=False)
    return org_id, project_id, human_id, connection_id, story_id


async def _queue_video(client, org_id, draft_id, raw):
    object_path = _object_path_for_video(org_id, draft_id)
    await _put_raw_object(object_path, raw, content_type="video/mp4")
    r = await client.post(
        f"/api/v2/organizations/{org_id}/channel-posts/drafts/{draft_id}/assets/video/confirm", json={"object_path": object_path},
    )
    return r, object_path


async def _job(Session, job_id):
    from sqlalchemy import select

    from app.models.background_job import BackgroundJob

    async with Session() as s:
        return (await s.execute(select(BackgroundJob).where(BackgroundJob.id == uuid.UUID(job_id)))).scalar_one()


@pytest.mark.anyio
async def test_video_confirm_answers_202_then_the_worker_finishes_it():
    """요청 = 202 + 작업(pending) · 새 버전 0. 워커 한 번 → completed · 작업 상태 보기에 영상 · 새 버전 1."""
    from sqlalchemy import func, select

    from app.main import app
    from app.models.channel_post_video import ChannelPostVideo

    engine, Session = await _session_factory()
    try:
        org_id, _, _, connection_id, story_id = await _world(Session, app)
        async with _client_for(app) as client:
            draft_id = await _create_draft(client, org_id=org_id, connection_id=connection_id, story_id=story_id)
            r, _ = await _queue_video(client, org_id, draft_id, _build_mp4(duration_seconds=6.0, **_VALID_9_16))
            assert r.status_code == 202, r.text
            queued = r.json()
            assert (queued["kind"], queued["status"], queued["result"], queued["error"]) == ("channel_video_confirm", "pending", None, None)
            async with Session() as s:
                assert (await s.execute(select(func.count()).select_from(ChannelPostVideo))).scalar_one() == 0

            counts = await run_background_jobs_once(app)
            assert counts["completed"] == 1, counts
            done = (await client.get(f"/api/v2/organizations/{org_id}/background-jobs/{queued['id']}")).json()
        assert done["status"] == "completed"
        video = done["result"]["video"]
        assert (video["width"], video["height"], video["codec"]) == (720, 1280, "avc1")
        async with Session() as s:
            assert (await s.execute(select(func.count()).select_from(ChannelPostVideo))).scalar_one() == 1
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()


@pytest.mark.anyio
async def test_a_rejected_video_fails_the_job_with_the_same_body_and_cleans_the_object():
    """검증 거부(길이 초과) → failed + 요청이 받았을 본문(422 · CHANNEL_VIDEO_DURATION_EXCEEDED · 숫자) · 업로드 객체 정리(#3589)."""
    from app.main import app
    from app.services.channel_post_images import CHANNEL_MEDIA_BUCKET
    from app.services.storage import get_storage_provider

    engine, Session = await _session_factory()
    try:
        org_id, _, _, connection_id, story_id = await _world(Session, app)
        async with _client_for(app) as client:
            draft_id = await _create_draft(client, org_id=org_id, connection_id=connection_id, story_id=story_id)
            r, object_path = await _queue_video(client, org_id, draft_id, _build_mp4(duration_seconds=95.0, **_VALID_9_16))
            await run_background_jobs_once(app)
            job = (await client.get(f"/api/v2/organizations/{org_id}/background-jobs/{r.json()['id']}")).json()
        assert job["status"] == "failed"
        assert job["error"]["status_code"] == 422
        assert job["error"]["detail"]["code"] == "CHANNEL_VIDEO_DURATION_EXCEEDED"
        assert job["error"]["detail"]["max_seconds"] == 90.0
        assert await get_storage_provider().head_object(CHANNEL_MEDIA_BUCKET, object_path) is None
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()


@pytest.mark.anyio
async def test_only_the_requester_can_read_the_job():
    from app.main import app

    engine, Session = await _session_factory()
    try:
        org_id, project_id, _, connection_id, story_id = await _world(Session, app)
        async with _client_for(app) as client:
            draft_id = await _create_draft(client, org_id=org_id, connection_id=connection_id, story_id=story_id)
            r, _ = await _queue_video(client, org_id, draft_id, _build_mp4(duration_seconds=6.0, **_VALID_9_16))
        job_id = r.json()["id"]
        async with Session() as s:
            other_human = await _seed_human(s, org_id, project_id)
        _setup_org_scoped_app(app, Session, org_id, user_id=other_human, agent=False)
        async with _client_for(app) as client:
            other = await client.get(f"/api/v2/organizations/{org_id}/background-jobs/{job_id}")
            missing = await client.get(f"/api/v2/organizations/{org_id}/background-jobs/{uuid.uuid4()}")
        assert other.status_code == 404, other.text
        assert missing.status_code == 404
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()


@pytest.mark.anyio
async def test_worker_skips_a_job_that_does_not_fit_the_remaining_budget():
    """남은 틱 예산이 영상 확정 최악 소요보다 작으면 시작하지 않는다(다음 틱) — 도중에 끊기지 않게."""
    from app.dependencies.database import get_db
    from app.main import app
    from app.services.background_jobs import process_due_background_jobs
    from app.services.channel_post_videos import VIDEO_CONFIRM_WORST_SECONDS

    engine, Session = await _session_factory()
    try:
        org_id, _, _, connection_id, story_id = await _world(Session, app)
        async with _client_for(app) as client:
            draft_id = await _create_draft(client, org_id=org_id, connection_id=connection_id, story_id=story_id)
            r, _ = await _queue_video(client, org_id, draft_id, _build_mp4(duration_seconds=6.0, **_VALID_9_16))
        agen = app.dependency_overrides[get_db]()
        session = await agen.__anext__()
        try:
            counts = await process_due_background_jobs(session, deadline_monotonic=time.monotonic() + VIDEO_CONFIRM_WORST_SECONDS - 5)
        finally:
            await agen.aclose()
        assert counts["completed"] == 0 and counts["deferred"] == 1, counts
        job = await _job(Session, r.json()["id"])
        assert (job.status, job.attempt_count) == ("pending", 0)
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()


@pytest.mark.anyio
async def test_a_storage_timeout_retries_then_fails_after_max_attempts():
    """시한 초과는 거부가 아니라 일시 실패 — pending + next_attempt_at · 객체는 남김. MAX_ATTEMPTS번째면 failed(BACKGROUND_JOB_FAILED)."""
    from sqlalchemy import update

    import app.services.channel_post_videos as videos
    from app.main import app
    from app.models.background_job import BackgroundJob
    from app.services.background_jobs import FAILED_CODE, MAX_ATTEMPTS
    from app.services.channel_post_images import CHANNEL_MEDIA_BUCKET
    from app.services.storage import get_storage_provider
    from app.services.storage.deadline import StorageCallTimeoutError

    provider_cls = type(get_storage_provider())

    async def _timed_out_download(self, container, object_path):
        raise StorageCallTimeoutError("download", videos.VIDEO_DOWNLOAD_SECONDS)

    engine, Session = await _session_factory()
    try:
        org_id, _, _, connection_id, story_id = await _world(Session, app)
        async with _client_for(app) as client:
            draft_id = await _create_draft(client, org_id=org_id, connection_id=connection_id, story_id=story_id)
            r, object_path = await _queue_video(client, org_id, draft_id, _build_mp4(duration_seconds=6.0, **_VALID_9_16))
        job_id = r.json()["id"]
        with patch.object(provider_cls, "download_object", _timed_out_download):
            for attempt in range(1, MAX_ATTEMPTS + 1):
                await run_background_jobs_once(app)
                job = await _job(Session, job_id)
                assert job.attempt_count == attempt
                if attempt < MAX_ATTEMPTS:
                    assert job.status == "pending" and job.next_attempt_at is not None, (attempt, job.status)
                    async with Session() as s:  # 백오프를 건너뛰어 다음 판을 바로
                        await s.execute(update(BackgroundJob).where(BackgroundJob.id == job.id).values(next_attempt_at=None))
                        await s.commit()
        assert job.status == "failed"
        assert job.error["detail"]["code"] == FAILED_CODE
        # 일시 실패 동안 객체는 지우지 않았다(다시 시도할 수 있게).
        assert await get_storage_provider().head_object(CHANNEL_MEDIA_BUCKET, object_path) is not None
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()


@pytest.mark.anyio
async def test_a_stale_in_progress_job_is_picked_up_again():
    from sqlalchemy import update

    from app.main import app
    from app.models.background_job import BackgroundJob
    from app.services.background_jobs import LEASE_SECONDS

    engine, Session = await _session_factory()
    try:
        org_id, _, _, connection_id, story_id = await _world(Session, app)
        async with _client_for(app) as client:
            draft_id = await _create_draft(client, org_id=org_id, connection_id=connection_id, story_id=story_id)
            r, _ = await _queue_video(client, org_id, draft_id, _build_mp4(duration_seconds=6.0, **_VALID_9_16))
        job_id = uuid.UUID(r.json()["id"])
        async with Session() as s:
            await s.execute(update(BackgroundJob).where(BackgroundJob.id == job_id).values(
                status="in_progress", attempt_count=1,
                claimed_at=datetime.now(timezone.utc) - timedelta(seconds=LEASE_SECONDS + 5),
            ))
            await s.commit()
        counts = await run_background_jobs_once(app)
        assert counts["completed"] == 1, counts
        assert (await _job(Session, str(job_id))).status == "completed"
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()


@pytest.mark.anyio
async def test_the_publication_commands_tick_runs_background_jobs():
    import app.routers.cron as cron_module
    from app.dependencies.database import get_worker_db
    from app.dependencies.database import get_db
    from app.main import app

    engine, Session = await _session_factory()
    try:
        org_id, _, _, connection_id, story_id = await _world(Session, app)
        async with _client_for(app) as client:
            draft_id = await _create_draft(client, org_id=org_id, connection_id=connection_id, story_id=story_id)
            r, _ = await _queue_video(client, org_id, draft_id, _build_mp4(duration_seconds=6.0, **_VALID_9_16))
            app.dependency_overrides[get_worker_db] = app.dependency_overrides[get_db]
            with patch.object(cron_module, "verify_cron", lambda request: None):
                tick = await client.post("/api/v2/internal/cron/publication-commands")
        assert tick.status_code == 200, tick.text
        body = tick.json()
        counts = (body.get("data") or body)["background_jobs"]
        assert counts["completed"] == 1, body
        assert (await _job(Session, r.json()["id"])).status == "completed"
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()


@pytest.mark.anyio
async def test_image_confirm_answers_504_when_a_storage_call_overruns():
    """이미지 확정은 요청 안에 두되 호출마다 시한 — 받기가 시한을 넘으면 504 CHANNEL_ASSET_STORAGE_TIMEOUT(코드 있는 본문)."""
    import app.services.channel_post_images as images
    from app.main import app
    from tests.test_620beefc_channel_post_image_upload import _jpeg_bytes

    engine, Session = await _session_factory()
    try:
        org_id, _, _, connection_id, story_id = await _world(Session, app)
        provider_cls = type(images.get_storage_provider())
        original_download = provider_cls.download_object

        async def _slow_download(self, container, object_path):
            await asyncio.sleep(1.0)
            return await original_download(self, container, object_path)

        async with _client_for(app) as client:
            draft_id = await _create_draft(client, org_id=org_id, connection_id=connection_id, story_id=story_id)
            object_path = f"channel-media/{org_id}/{draft_id}/{uuid.uuid4().hex}.jpg"
            await _put_raw_object(object_path, _jpeg_bytes(1080, 1080), content_type="image/jpeg")
            with patch.object(images, "IMAGE_DOWNLOAD_SECONDS", 0.2), patch.object(provider_cls, "download_object", _slow_download):
                started = time.monotonic()
                r = await client.post(
                    f"/api/v2/organizations/{org_id}/channel-posts/drafts/{draft_id}/assets/confirm", json={"object_path": object_path},
                )
                elapsed = time.monotonic() - started
        assert r.status_code == 504, r.text
        assert r.json()["error"]["code"] == "CHANNEL_ASSET_STORAGE_TIMEOUT"
        assert elapsed < 1.0, elapsed
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()


@pytest.mark.anyio
async def test_another_org_cannot_see_the_job():
    """PO 05:09Z — 조직 B 사용자가 조직 A의 작업 id로 물으면: 자기 조직 경로(/organizations/B/…) = 404(작업이 있는지조차 안 드러남),
    남의 조직 경로(/organizations/A/…) = 403(org 불일치 — 작업과 무관한 같은 문지기). 같은 조직 다른 사람 = 404는
    test_only_the_requester_can_read_the_job. `mcp_toolset._ORG_SCOPED_UNMAPPED_SEGMENTS_WITH_REASON["background-jobs"]`의 문지기가 이 둘이다."""
    from app.main import app

    engine, Session = await _session_factory()
    try:
        org_a, _, _, connection_id, story_id = await _world(Session, app)
        async with _client_for(app) as client:
            draft_id = await _create_draft(client, org_id=org_a, connection_id=connection_id, story_id=story_id)
            r, _ = await _queue_video(client, org_a, draft_id, _build_mp4(duration_seconds=6.0, **_VALID_9_16))
        job_id = r.json()["id"]
        async with Session() as s:
            org_b, project_b = await _seed_org(s)
            human_b = await _seed_human(s, org_b, project_b)
        _setup_org_scoped_app(app, Session, org_b, user_id=human_b, agent=False)
        async with _client_for(app) as client:
            own_path = await client.get(f"/api/v2/organizations/{org_b}/background-jobs/{job_id}")
            nowhere_id = str(uuid.uuid4())
            nowhere = await client.get(f"/api/v2/organizations/{org_b}/background-jobs/{nowhere_id}")
            foreign_path = await client.get(f"/api/v2/organizations/{org_a}/background-jobs/{job_id}")
        assert own_path.status_code == 404, own_path.text
        # «남의 작업»과 «없는 작업»이 구별되지 않는다 — 같은 상태 · 같은 코드 · 보낸 id만 되비침(작업 내용 0).
        assert own_path.json()["error"] == {**nowhere.json()["error"], "message": job_id}
        assert own_path.json()["error"]["code"] == "BACKGROUND_JOB_NOT_FOUND"
        assert foreign_path.status_code == 403, foreign_path.text
        assert "channel_video_confirm" not in own_path.text + foreign_path.text
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()
