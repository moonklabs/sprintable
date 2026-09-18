"""story #3536(BE·결함, 페드루 PO 確定 2026-09-06) — 이미지 필수 채널(Instagram)에
이미지 없는 초안이 상신·승인까지 통과하고 발행에서야 죽는 것을 상신 단계에서 막는다
(422 `CHANNEL_IMAGE_REQUIRED`) + 그 실패가 어댑터 「영구 조건」 코드로 오면
`classify_failure_kind`가 needs_check(재시도 0·dead_letter)로 보내게 한다(기존
transient «기다리면 됨» 오분류 정정).

세팅 헬퍼는 test_620beefc_channel_post_image_upload.py와 동형(중복 재발명 금지)."""
from __future__ import annotations

import os
import uuid
from datetime import datetime, timedelta, timezone

import pytest

from tests.test_620beefc_channel_post_image_upload import (
    _approve_gate_directly, _client_for, _create_draft, _png_bytes, _seed_connection,
    _seed_default_role, _seed_human, _seed_org, _seed_story, _session_factory,
    _setup_org_scoped_app, _upload_and_confirm,
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
def _local_channel_media_storage_for_image_upload(monkeypatch, tmp_path):
    """test_620beefc_channel_post_image_upload.py와 동형(중복 재발명 금지) — 버킷 이름은
    반드시 그 파일의 `_CHANNEL_MEDIA_BUCKET`과 같아야 한다(다르면 PUT과 confirm이
    서로 다른 버킷을 봐서 404가 난다, test_3320_instagram_connector.py와 동일 관례)."""
    import app.services.channel_post_images as cpi_module
    from tests.test_620beefc_channel_post_image_upload import _CHANNEL_MEDIA_BUCKET

    monkeypatch.setenv("STORAGE_PROVIDER", "local")
    monkeypatch.setenv("STORAGE_LOCAL_ROOT", str(tmp_path / ".storage-3536"))
    monkeypatch.setattr(cpi_module, "CHANNEL_MEDIA_BUCKET", _CHANNEL_MEDIA_BUCKET)
    monkeypatch.setattr(cpi_module, "_PUBLIC_BASE", f"https://storage.googleapis.com/{_CHANNEL_MEDIA_BUCKET}/")
    yield


async def _submit(client, org_id, draft_id, *, scheduled_at: datetime | None = None):
    body = {}
    if scheduled_at is not None:
        body["scheduled_at"] = scheduled_at.isoformat()
    return await client.post(
        f"/api/v2/organizations/{org_id}/channel-posts/drafts/{draft_id}/submit", json=body,
    )


@pytest.mark.anyio
async def test_submit_instagram_draft_without_image_returns_422():
    """AC2 — 이미지 없는 IG 초안은 상신 자체가 막힌다(게이트 생성 前, 승인 게이트
    낭비 방지)."""
    from app.main import app

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org_id, project_id = await _seed_org(s)
            await _seed_default_role(s, org_id)
            human_id = await _seed_human(s, org_id, project_id)
            connection_id = await _seed_connection(s, org_id, channel="instagram")
            story_id = await _seed_story(s, org_id, project_id)

        _setup_org_scoped_app(app, Session, org_id, user_id=human_id, agent=False)
        try:
            async with _client_for(app) as client:
                draft_id = await _create_draft(client, org_id=org_id, connection_id=connection_id, story_id=story_id)
                r_submit = await _submit(client, org_id, draft_id)
                assert r_submit.status_code == 422, r_submit.text
                error = r_submit.json().get("error") or r_submit.json()
                assert error["code"] == "CHANNEL_IMAGE_REQUIRED"
        finally:
            app.dependency_overrides.clear()
    finally:
        await engine.dispose()


@pytest.mark.anyio
async def test_submit_instagram_draft_with_image_succeeds():
    """이미지가 있으면 정상 통과(회귀 0)."""
    from app.main import app

    raw = _png_bytes(800, 800)

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org_id, project_id = await _seed_org(s)
            await _seed_default_role(s, org_id)
            human_id = await _seed_human(s, org_id, project_id)
            connection_id = await _seed_connection(s, org_id, channel="instagram")
            story_id = await _seed_story(s, org_id, project_id)

        _setup_org_scoped_app(app, Session, org_id, user_id=human_id, agent=False)
        try:
            async with _client_for(app) as client:
                draft_id = await _create_draft(client, org_id=org_id, connection_id=connection_id, story_id=story_id)
                r_upload = await _upload_and_confirm(client, org_id, draft_id, raw, content_type="image/png")
                assert r_upload.status_code == 201, r_upload.text

                r_submit = await _submit(client, org_id, draft_id)
                assert r_submit.status_code == 200, r_submit.text
        finally:
            app.dependency_overrides.clear()
    finally:
        await engine.dispose()


@pytest.mark.anyio
async def test_submit_threads_draft_without_image_succeeds_unaffected():
    """회귀 — image_required=False(Threads 등)는 이미지 없어도 그대로 통과."""
    from app.main import app

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org_id, project_id = await _seed_org(s)
            await _seed_default_role(s, org_id)
            human_id = await _seed_human(s, org_id, project_id)
            connection_id = await _seed_connection(s, org_id, channel="threads")
            story_id = await _seed_story(s, org_id, project_id)

        _setup_org_scoped_app(app, Session, org_id, user_id=human_id, agent=False)
        try:
            async with _client_for(app) as client:
                draft_id = await _create_draft(client, org_id=org_id, connection_id=connection_id, story_id=story_id)
                r_submit = await _submit(client, org_id, draft_id)
                assert r_submit.status_code == 200, r_submit.text
        finally:
            app.dependency_overrides.clear()
    finally:
        await engine.dispose()


@pytest.mark.anyio
async def test_channel_connection_response_exposes_image_required():
    """AC1 — GET channel-connections 응답에 image_required가 그대로 실린다(instagram
    True·threads False)."""
    from app.main import app

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org_id, project_id = await _seed_org(s)
            human_id = await _seed_human(s, org_id, project_id)
            ig_connection_id = await _seed_connection(s, org_id, channel="instagram")
            threads_connection_id = await _seed_connection(s, org_id, channel="threads")

        _setup_org_scoped_app(app, Session, org_id, user_id=human_id, agent=False)
        try:
            async with _client_for(app) as client:
                r = await client.get(f"/api/v2/organizations/{org_id}/channel-connections")
                assert r.status_code == 200, r.text
                by_id = {row["id"]: row for row in r.json()}
                assert by_id[str(ig_connection_id)]["image_required"] is True
                assert by_id[str(threads_connection_id)]["image_required"] is False
        finally:
            app.dependency_overrides.clear()
    finally:
        await engine.dispose()


async def _fake_create_container_raises_image_required(client, *, access_token, threads_user_id, text, image_url=None):
    from app.services.threads_publish import ThreadsPublishError

    raise ThreadsPublishError(
        "INSTAGRAM_IMAGE_REQUIRED", "Instagram 발행은 이미지가 필수입니다(피드 이미지 1장)", status_code=422,
    )


async def _fake_get_publishing_limit(client, *, access_token, threads_user_id):
    return (0, 100, 24 * 60 * 60)


async def _seed_scheduled_instagram_command(session, client, *, org_id, connection_id, story_id, human_id):
    """이미지 있는 IG 초안으로 상신(#3536 사전체크 통과)+승인 뒤, 발행 시점 provider가
    그래도(레이스·서버·클라이언트 판정 불일치 등 방어선 시나리오) INSTAGRAM_IMAGE_
    REQUIRED로 거부하는 상황을 워커까지 직접 재현하기 위해 scheduled command를
    수동으로 심는다(test_3414_publication_command_cron_retry.py::test_cron_
    deterministic_failure...와 동형 기법 — story #3562로 분할)."""
    from app.models.publication_command import PublicationCommand

    raw = _png_bytes(800, 800)
    draft_id = await _create_draft(client, org_id=org_id, connection_id=connection_id, story_id=story_id)
    r_upload = await _upload_and_confirm(client, org_id, draft_id, raw, content_type="image/png")
    assert r_upload.status_code == 201, r_upload.text
    r_submit = await _submit(client, org_id, draft_id, scheduled_at=datetime.now(timezone.utc) + timedelta(minutes=1))
    assert r_submit.status_code == 200, r_submit.text
    gate_id = uuid.UUID(r_submit.json()["gate_id"])
    version_id = uuid.UUID(r_submit.json()["version_id"])
    await _approve_gate_directly(session, gate_id)

    now = datetime.now(timezone.utc)
    cmd = PublicationCommand(
        id=uuid.uuid4(), org_id=org_id, gate_id=gate_id, destination=connection_id,
        approved_version=version_id, operation="publish",
        scheduled_at=now - timedelta(minutes=1), status="pending", requested_by_member_id=human_id,
    )
    session.add(cmd)
    await session.commit()
    return cmd.id


@pytest.mark.anyio
async def test_instagram_permanent_provider_failure_classified_as_needs_check_dead_letter(monkeypatch):
    """AC3 — 어댑터가 INSTAGRAM_IMAGE_REQUIRED(영구 조건)로 실패하면 needs_check로
    분류돼 즉시 dead_letter(재시도 0·next_attempt_at null). 뮤테이션 자가검증 —
    _PERMANENT_PROVIDER_CONDITION_CODES에서 이 코드를 지우면(실 소스 대입) 같은
    실패가 CHANNEL_PUBLISH_PROVIDER_ERROR(transient)로 떨어져 pending+next_attempt_at
    이 채워지는 것으로 되돌아간다."""
    import app.services.instagram_publish as instagram_publish_module
    from app.models.publication_command import PublicationCommand
    from app.services.publication_command import process_due_publication_commands
    from sqlalchemy import select

    monkeypatch.setattr(instagram_publish_module, "create_container", _fake_create_container_raises_image_required)
    monkeypatch.setattr(instagram_publish_module, "get_publishing_limit", _fake_get_publishing_limit)

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
            async with _client_for(app) as client, Session() as s:
                cmd_id = await _seed_scheduled_instagram_command(
                    s, client, org_id=org_id, connection_id=connection_id, story_id=story_id, human_id=human_id,
                )
        finally:
            app.dependency_overrides.clear()

        now = datetime.now(timezone.utc)
        async with Session() as s:
            await process_due_publication_commands(s, now=now)

        async with Session() as s:
            cmd_row = (await s.execute(select(PublicationCommand).where(PublicationCommand.id == cmd_id))).scalar_one()
            assert cmd_row.status == "dead_letter", cmd_row.status
            assert cmd_row.failure_kind == "needs_check", cmd_row.failure_kind
            assert cmd_row.next_attempt_at is None
            assert cmd_row.attempt_count == 1
    finally:
        await engine.dispose()
