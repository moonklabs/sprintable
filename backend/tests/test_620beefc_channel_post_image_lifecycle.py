"""story 620beefc(Phase1·마케팅운영, 페드루 PO 決定 2026-09-04) — AC4 봉인 판정 축
세분화(media 변경 재승인)·AC5 비동기 발행 흐름 3갈래(IN_PROGRESS/FINISHED/ERROR).
story #3579(2026-09-06, 페드루 PO 確定) 후속으로 `test_620beefc_channel_post_image.py`
(25 테스트)에서 3-way 분할 — 원본 파일이 러너 정규화 60초 가드 경계대역(48~57s, PR
#3925/#3926에서 174s/141s까지 관측)에 있어 러너가 조금만 느려져도 가드에 걸림. 세팅
헬퍼·픽스처는 `test_620beefc_channel_post_image_upload.py`에서 그대로 재사용(중복
재발명 0) — autouse 픽스처(`_dispose_global_engine_after_test`·`_configure_secrets`·
`_local_channel_media_storage`)만 pytest 관례상 파일마다 재선언(import로는 전파 안 됨,
story #3562 전례와 동일).

이 파일 담당 — 승인 뒤 미디어 교체 시 gate 재개방(MEDIA_CHANGED 사유 구분)·텍스트만
편집 시 이미지 캐리포워드·이미지 첨부 발행이 캐리포워드 이미지를 실제로 쓰는지·이미지
발행이 컨테이너 생성 뒤 즉시 publish 안 하고 대기하는지·IN_PROGRESS/FINISHED/ERROR
tick 3갈래·ERROR 상태 수동 재시도가 새 컨테이너를 만드는지·5분 초과 시 needs_check로
타임아웃·목록에서 processing 종류 노출."""
from __future__ import annotations

import os
import uuid
from datetime import datetime, timedelta, timezone
from unittest.mock import AsyncMock, patch

import pytest

from tests.test_620beefc_channel_post_image_upload import (
    _approve_gate_directly,
    _client_for,
    _create_draft,
    _png_bytes,
    _seed_connection,
    _seed_default_role,
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


_CHANNEL_MEDIA_BUCKET = "test-channel-media-620beefc"


@pytest.fixture(autouse=True)
def _local_channel_media_storage(monkeypatch, tmp_path):
    """`STORAGE_PROVIDER`/`STORAGE_LOCAL_ROOT`는 storage/factory.py가 매 호출 시점에
    read하므로 monkeypatch.setenv만으로 충분. `CHANNEL_MEDIA_BUCKET`/`_PUBLIC_BASE`는
    channel_post_images.py의 모듈 최상위 상수(import 시 1회 평가)라 importlib.reload
    대신 monkeypatch.setattr로 속성만 직접 덮어쓴다(원본 파일과 동일 이유 — reload는
    예외 클래스 정체성을 깨뜨린다)."""
    import app.services.channel_post_images as cpi_module

    monkeypatch.setenv("STORAGE_PROVIDER", "local")
    monkeypatch.setenv("STORAGE_LOCAL_ROOT", str(tmp_path / ".storage"))
    monkeypatch.setattr(cpi_module, "CHANNEL_MEDIA_BUCKET", _CHANNEL_MEDIA_BUCKET)
    monkeypatch.setattr(cpi_module, "_PUBLIC_BASE", f"https://storage.googleapis.com/{_CHANNEL_MEDIA_BUCKET}/")
    yield


# ─── AC4 — 봉인 판정 축 세분화(media) ─────────────────────────────────────────

@pytest.mark.anyio
async def test_media_change_after_approval_reopens_gate_with_media_changed_reason():
    """본문·예약 시각 그대로, 이미지만 승인 뒤 첨부 → gate가 pending으로 되돌아가고
    voided 사유가 MEDIA_CHANGED(CONTENT_CHANGED로 뭉뚱그려지면 안 됨, AC4)."""
    from app.main import app
    from app.models.publication_command import PublicationCommand
    from sqlalchemy import select

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org_id, project_id = await _seed_org(s)
            await _seed_default_role(s, org_id)
            human_id = await _seed_human(s, org_id, project_id)
            connection_id = await _seed_connection(s, org_id)
            story_id = await _seed_story(s, org_id, project_id)

        _setup_org_scoped_app(app, Session, org_id, user_id=human_id, agent=False)
        async with _client_for(app) as client, Session() as s:
            draft_id = await _create_draft(client, org_id=org_id, connection_id=connection_id, story_id=story_id)
            r_submit = await client.post(
                f"/api/v2/organizations/{org_id}/channel-posts/drafts/{draft_id}/submit", json={},
            )
            assert r_submit.status_code == 200, r_submit.text
            gate_id = uuid.UUID(r_submit.json()["gate_id"])
            await _approve_gate_directly(s, gate_id)

            # 승인된 gate에 걸린 pending command 하나(취소 대상 관측용) 직접 심는다 —
            # void_pending_commands_for_gate가 이 행을 MEDIA_CHANGED로 되돌리는지 확인.
            cmd = PublicationCommand(
                id=uuid.uuid4(), org_id=org_id, gate_id=gate_id,
                destination=connection_id, approved_version=uuid.uuid4(),
                status="pending", requested_by_member_id=human_id,
            )
            s.add(cmd)
            await s.commit()

            raw = _png_bytes(400, 400)
            r_img = await _upload_and_confirm(client, org_id, draft_id, raw, content_type="image/png")
            assert r_img.status_code == 201, r_img.text

            from app.models.gate import Gate
            gate = (await s.execute(select(Gate).where(Gate.id == gate_id))).scalar_one()
            await s.refresh(gate)
            assert gate.status == "pending"
            assert gate.reapproval_required is True

            await s.refresh(cmd)
            assert cmd.status == "voided"
            assert cmd.reason_code == "MEDIA_CHANGED"
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()


@pytest.mark.anyio
async def test_text_edit_after_image_attach_carries_image_forward():
    """story 620beefc(페드루 리뷰 블로커 B1) — 이미지 첨부 뒤 순수 텍스트 편집(이미지
    엔드포인트 미경유)이 이미지를 조용히 떨어뜨리지 않는다. image_sha256이 새 버전에도
    캐리포워드될 뿐 아니라(원 버그의 절반 — 이건 처음부터 됐었다), **ChannelPostImage
    행 자체**도 새 version_id로 복제돼야 한다(원 버그의 실체 — publish_channel_post_
    draft가 gate가 아니라 latest.id로 이미지 행을 찾으므로, 행이 옛 version_id에만
    남아 있으면 image_sha256은 세팅돼 있는데도 발행 시점엔 이미지를 못 찾아 조용히
    TEXT로 나가고 썸네일도 사라진다)."""
    from app.main import app
    from app.models.channel_post_image import ChannelPostImage
    from app.models.channel_post_version import ChannelPostVersion
    from sqlalchemy import select

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org_id, project_id = await _seed_org(s)
            human_id = await _seed_human(s, org_id, project_id)
            connection_id = await _seed_connection(s, org_id)
            story_id = await _seed_story(s, org_id, project_id)

        _setup_org_scoped_app(app, Session, org_id, user_id=human_id, agent=False)
        async with _client_for(app) as client, Session() as s:
            draft_id = await _create_draft(client, org_id=org_id, connection_id=connection_id, story_id=story_id)
            raw = _png_bytes(400, 400)
            r_img = await _upload_and_confirm(client, org_id, draft_id, raw, content_type="image/png")
            assert r_img.status_code == 201, r_img.text
            image_version_id = uuid.UUID(r_img.json()["version_id"])

            r_edit = await client.post(
                f"/api/v2/organizations/{org_id}/channel-posts/drafts",
                json={
                    "work_item_id": str(story_id), "connection_id": str(connection_id),
                    "text": "본문만 수정 — 이미지 엔드포인트 안 거침",
                },
            )
            assert r_edit.status_code == 201, r_edit.text
            new_version_id = uuid.UUID(r_edit.json()["version_id"])
            assert new_version_id != image_version_id

            rows = (await s.execute(
                select(ChannelPostVersion).where(ChannelPostVersion.id.in_([image_version_id, new_version_id]))
            )).scalars().all()
            by_id = {v.id: v for v in rows}
            assert by_id[new_version_id].image_sha256 == by_id[image_version_id].image_sha256
            assert by_id[new_version_id].image_sha256 is not None

            # 원 버그의 실체 — 이 assert 없이는 위 두 줄만으로 "고쳐진 것처럼" 보인다.
            new_version_image = (await s.execute(
                select(ChannelPostImage).where(ChannelPostImage.version_id == new_version_id)
            )).scalar_one_or_none()
            assert new_version_image is not None, (
                "ChannelPostImage 행이 새 version_id로 복제 안 됨 — publish 시점에 "
                "latest.id로 조회하면 빈손이라 이미지 없이 TEXT로 나간다(B1 원 버그)"
            )
            original_image = (await s.execute(
                select(ChannelPostImage).where(ChannelPostImage.version_id == image_version_id)
            )).scalar_one()
            assert new_version_image.original_sha256 == original_image.original_sha256
            assert new_version_image.final_sha256 == by_id[new_version_id].image_sha256
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()


@pytest.mark.anyio
async def test_publish_uses_carried_forward_image_not_silently_text_only():
    """story 620beefc(페드루 리뷰 블로커 B1, 발행 레벨 실증) — 이미지 첨부 뒤 텍스트만
    편집한 버전을 실제로 발행하면 IMAGE 컨테이너 경로(image_url 있음)로 나가야 한다 —
    B1이 있었다면 이 발행은 image_url=None인 TEXT 경로로 조용히 샜다."""
    from app.main import app
    from app.services.channel_posts import publish_channel_post_draft
    import app.services.threads_publish as tp

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org_id, project_id = await _seed_org(s)
            await _seed_default_role(s, org_id)
            human_id = await _seed_human(s, org_id, project_id)
            connection_id = await _seed_connection(s, org_id)
            story_id = await _seed_story(s, org_id, project_id)

        _setup_org_scoped_app(app, Session, org_id, user_id=human_id, agent=False)
        async with _client_for(app) as client, Session() as s:
            draft_id = await _create_draft(client, org_id=org_id, connection_id=connection_id, story_id=story_id)
            raw = _png_bytes(400, 400)
            r_img = await _upload_and_confirm(client, org_id, draft_id, raw, content_type="image/png")
            assert r_img.status_code == 201, r_img.text

            # 이미지 엔드포인트를 안 거치는 순수 텍스트 편집(새 버전 — image_sha256만 캐리포워드).
            r_edit = await client.post(
                f"/api/v2/organizations/{org_id}/channel-posts/drafts",
                json={
                    "work_item_id": str(story_id), "connection_id": str(connection_id),
                    "text": "발행 직전 텍스트만 재편집",
                },
            )
            assert r_edit.status_code == 201, r_edit.text

            r_submit = await client.post(
                f"/api/v2/organizations/{org_id}/channel-posts/drafts/{draft_id}/submit", json={},
            )
            assert r_submit.status_code == 200, r_submit.text
            gate_id = uuid.UUID(r_submit.json()["gate_id"])
            await _approve_gate_directly(s, gate_id)

            captured = {}

            async def _fake_create_container(client_, *, access_token, threads_user_id, text, image_url=None):
                captured["image_url"] = image_url
                return "container-carried-forward"

            with (
                patch.object(tp, "get_publishing_limit", AsyncMock(return_value=(0, 100, 3600))),
                patch.object(tp, "create_container", AsyncMock(side_effect=_fake_create_container)),
            ):
                publication = await publish_channel_post_draft(
                    s, org_id=org_id, draft_id=draft_id, published_by_member_id=human_id,
                )
        assert publication.status == "container_created"  # 비동기 IMAGE 경로 — 즉시 published 아님
        assert captured["image_url"] is not None, "B1 재발 — 캐리포워드된 이미지가 발행에 안 실림"
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()


# ─── AC5 — 비동기 발행 흐름 3갈래(IN_PROGRESS/FINISHED/ERROR) ─────────────────

async def _prepare_approved_image_draft(client, s, *, org_id, connection_id, story_id, human_id):
    draft_id = await _create_draft(client, org_id=org_id, connection_id=connection_id, story_id=story_id)
    raw = _png_bytes(400, 400)
    r_img = await _upload_and_confirm(client, org_id, draft_id, raw, content_type="image/png")
    assert r_img.status_code == 201, r_img.text
    r_submit = await client.post(
        f"/api/v2/organizations/{org_id}/channel-posts/drafts/{draft_id}/submit", json={},
    )
    assert r_submit.status_code == 200, r_submit.text
    gate_id = uuid.UUID(r_submit.json()["gate_id"])
    await _approve_gate_directly(s, gate_id)
    return draft_id


@pytest.mark.anyio
async def test_image_publish_creates_container_then_waits_no_immediate_publish_call():
    """컨테이너 생성 직후 publish_container를 즉시 호출하지 않는다(PO 決定 — Meta 권장
    30초 대기) — container_created 그대로 반환, processing=true."""
    from app.main import app
    import app.services.threads_publish as tp

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org_id, project_id = await _seed_org(s)
            await _seed_default_role(s, org_id)
            human_id = await _seed_human(s, org_id, project_id)
            connection_id = await _seed_connection(s, org_id)
            story_id = await _seed_story(s, org_id, project_id)

        _setup_org_scoped_app(app, Session, org_id, user_id=human_id, agent=False)
        async with _client_for(app) as client, Session() as s:
            draft_id = await _prepare_approved_image_draft(
                client, s, org_id=org_id, connection_id=connection_id, story_id=story_id, human_id=human_id,
            )

            publish_container_mock = AsyncMock(side_effect=AssertionError("publish_container는 이 tick에 호출되면 안 된다"))
            with (
                patch.object(tp, "get_publishing_limit", AsyncMock(return_value=(0, 100, 3600))),
                patch.object(tp, "create_container", AsyncMock(return_value="container-img-1")),
                patch.object(tp, "publish_container", publish_container_mock),
            ):
                r = await client.post(f"/api/v2/organizations/{org_id}/channel-posts/drafts/{draft_id}/publish")
            assert r.status_code == 200, r.text
            body = r.json()
            assert body["processing"] is True
            assert body["permalink"] is None
            # story #3525(PO 確定) — publication_id도 permalink 등 셋과 동형(아직
            # 최종 published 행이 없다 — 지어내지 않는다).
            assert body["publication_id"] is None
            publish_container_mock.assert_not_called()
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()


@pytest.mark.anyio
async def test_image_publish_in_progress_tick_does_not_call_publish_container():
    """재진입(다음 tick)에서 컨테이너 status=IN_PROGRESS면 여전히 publish 호출 없이
    반환된다."""
    from app.main import app
    from app.services.channel_posts import publish_channel_post_draft
    import app.services.threads_publish as tp

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org_id, project_id = await _seed_org(s)
            await _seed_default_role(s, org_id)
            human_id = await _seed_human(s, org_id, project_id)
            connection_id = await _seed_connection(s, org_id)
            story_id = await _seed_story(s, org_id, project_id)

        _setup_org_scoped_app(app, Session, org_id, user_id=human_id, agent=False)
        async with _client_for(app) as client, Session() as s:
            draft_id = await _prepare_approved_image_draft(
                client, s, org_id=org_id, connection_id=connection_id, story_id=story_id, human_id=human_id,
            )
            with (
                patch.object(tp, "get_publishing_limit", AsyncMock(return_value=(0, 100, 3600))),
                patch.object(tp, "create_container", AsyncMock(return_value="container-img-2")),
            ):
                await client.post(f"/api/v2/organizations/{org_id}/channel-posts/drafts/{draft_id}/publish")

            publish_container_mock = AsyncMock(side_effect=AssertionError("IN_PROGRESS tick엔 publish_container 호출 금지"))
            with (
                patch.object(tp, "get_publishing_limit", AsyncMock(return_value=(0, 100, 3600))),
                patch.object(tp, "get_container_status", AsyncMock(return_value=("IN_PROGRESS", None))),
                patch.object(tp, "publish_container", publish_container_mock),
            ):
                publication = await publish_channel_post_draft(
                    s, org_id=org_id, draft_id=draft_id, published_by_member_id=human_id,
                )
            assert publication.status == "container_created"
            publish_container_mock.assert_not_called()
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()


@pytest.mark.anyio
async def test_image_publish_finished_tick_completes():
    """FINISHED가 되면 그제서야 publish_container로 진행해 published로 끝난다."""
    from app.main import app
    from app.services.channel_posts import publish_channel_post_draft
    import app.services.threads_publish as tp

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org_id, project_id = await _seed_org(s)
            await _seed_default_role(s, org_id)
            human_id = await _seed_human(s, org_id, project_id)
            connection_id = await _seed_connection(s, org_id)
            story_id = await _seed_story(s, org_id, project_id)

        _setup_org_scoped_app(app, Session, org_id, user_id=human_id, agent=False)
        async with _client_for(app) as client, Session() as s:
            draft_id = await _prepare_approved_image_draft(
                client, s, org_id=org_id, connection_id=connection_id, story_id=story_id, human_id=human_id,
            )
            with (
                patch.object(tp, "get_publishing_limit", AsyncMock(return_value=(0, 100, 3600))),
                patch.object(tp, "create_container", AsyncMock(return_value="container-img-3")),
            ):
                await client.post(f"/api/v2/organizations/{org_id}/channel-posts/drafts/{draft_id}/publish")

            with (
                patch.object(tp, "get_publishing_limit", AsyncMock(return_value=(0, 100, 3600))),
                patch.object(tp, "get_container_status", AsyncMock(return_value=("FINISHED", None))),
                patch.object(tp, "publish_container", AsyncMock(return_value="media-img-3")),
                patch.object(tp, "get_permalink", AsyncMock(return_value="https://threads.net/p/xyz")),
            ):
                publication = await publish_channel_post_draft(
                    s, org_id=org_id, draft_id=draft_id, published_by_member_id=human_id,
                )
            assert publication.status == "published"
            assert publication.external_id == "media-img-3"
            assert publication.permalink == "https://threads.net/p/xyz"
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()


@pytest.mark.anyio
async def test_image_publish_error_status_needs_check_no_auto_retry():
    """ERROR면 결정적 실패로 즉시 dead_letter(needs_check, 백오프 재시도 없음)."""
    from app.main import app
    from app.services.channel_posts import publish_channel_post_draft, ChannelImageContainerFailedError
    from app.services.publication_command import classify_failure_kind, FAILURE_KIND_NEEDS_CHECK
    import app.services.threads_publish as tp

    assert classify_failure_kind("CHANNEL_IMAGE_CONTAINER_FAILED") == FAILURE_KIND_NEEDS_CHECK

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org_id, project_id = await _seed_org(s)
            await _seed_default_role(s, org_id)
            human_id = await _seed_human(s, org_id, project_id)
            connection_id = await _seed_connection(s, org_id)
            story_id = await _seed_story(s, org_id, project_id)

        _setup_org_scoped_app(app, Session, org_id, user_id=human_id, agent=False)
        async with _client_for(app) as client, Session() as s:
            draft_id = await _prepare_approved_image_draft(
                client, s, org_id=org_id, connection_id=connection_id, story_id=story_id, human_id=human_id,
            )
            with (
                patch.object(tp, "get_publishing_limit", AsyncMock(return_value=(0, 100, 3600))),
                patch.object(tp, "create_container", AsyncMock(return_value="container-img-4")),
            ):
                await client.post(f"/api/v2/organizations/{org_id}/channel-posts/drafts/{draft_id}/publish")

            with (
                patch.object(tp, "get_publishing_limit", AsyncMock(return_value=(0, 100, 3600))),
                patch.object(tp, "get_container_status", AsyncMock(return_value=("ERROR", "INVALID_ASPEC_RATIO"))),
            ):
                with pytest.raises(ChannelImageContainerFailedError):
                    await publish_channel_post_draft(
                        s, org_id=org_id, draft_id=draft_id, published_by_member_id=human_id,
                    )

            # story 620beefc(페드루 리뷰 블로커 B2) — external_container_id가 지워져야
            # 사람의 AC5 재시도가 죽은 컨테이너를 다시 poll하지 않고 완전히 새 컨테이너를
            # 만든다(안 지우면 ERROR/EXPIRED 컨테이너를 영구히 반복 poll하는 실패 루프).
            from app.models.channel_publication import ChannelPublication
            from sqlalchemy import select as sa_select

            pub = (await s.execute(
                sa_select(ChannelPublication).where(ChannelPublication.org_id == org_id)
            )).scalar_one()
            assert pub.status == "failed"
            assert pub.external_container_id is None
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()


@pytest.mark.anyio
async def test_image_publish_error_retry_creates_brand_new_container():
    """story 620beefc(페드루 리뷰 블로커 B2, 회복 경로 실증) — ERROR 뒤 external_
    container_id가 지워진 상태에서 재시도하면(다음 publish_channel_post_draft 호출)
    create_container를 다시 호출해 완전히 새 creation_id를 받는다 — 죽은 컨테이너를
    또 poll하지 않는다."""
    from app.main import app
    from app.services.channel_posts import publish_channel_post_draft, ChannelImageContainerFailedError
    import app.services.threads_publish as tp

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org_id, project_id = await _seed_org(s)
            await _seed_default_role(s, org_id)
            human_id = await _seed_human(s, org_id, project_id)
            connection_id = await _seed_connection(s, org_id)
            story_id = await _seed_story(s, org_id, project_id)

        _setup_org_scoped_app(app, Session, org_id, user_id=human_id, agent=False)
        async with _client_for(app) as client, Session() as s:
            draft_id = await _prepare_approved_image_draft(
                client, s, org_id=org_id, connection_id=connection_id, story_id=story_id, human_id=human_id,
            )
            with (
                patch.object(tp, "get_publishing_limit", AsyncMock(return_value=(0, 100, 3600))),
                patch.object(tp, "create_container", AsyncMock(return_value="container-dead")),
            ):
                await client.post(f"/api/v2/organizations/{org_id}/channel-posts/drafts/{draft_id}/publish")

            with (
                patch.object(tp, "get_publishing_limit", AsyncMock(return_value=(0, 100, 3600))),
                patch.object(tp, "get_container_status", AsyncMock(return_value=("EXPIRED", None))),
            ):
                with pytest.raises(ChannelImageContainerFailedError):
                    await publish_channel_post_draft(
                        s, org_id=org_id, draft_id=draft_id, published_by_member_id=human_id,
                    )

            create_container_retry = AsyncMock(return_value="container-fresh")
            with (
                patch.object(tp, "get_publishing_limit", AsyncMock(return_value=(0, 100, 3600))),
                patch.object(tp, "create_container", create_container_retry),
            ):
                publication = await publish_channel_post_draft(
                    s, org_id=org_id, draft_id=draft_id, published_by_member_id=human_id,
                )
            assert publication.status == "container_created"
            assert publication.external_container_id == "container-fresh"
            create_container_retry.assert_called_once()
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()


@pytest.mark.anyio
async def test_image_publish_in_progress_beyond_5min_times_out_as_needs_check():
    """story 620beefc(페드루 리뷰 블로커 B3) — IN_PROGRESS 상한 없이는 command가
    attempt_count/backoff 어느 것도 안 건드리는 "처리 中" 분기(pending, +30초)로만
    계속 재큐잉돼 진짜 무한루프가 된다(dead_letter로 절대 못 빠짐). row.created_at을
    5분보다 오래 전으로 직접 되돌려(최초 컨테이너 생성 시각의 근사) 그 시나리오를
    재현 — ChannelImageContainerFailedError(needs_check)로 떨어져야 한다."""
    from datetime import timedelta
    from app.main import app
    from app.models.channel_publication import ChannelPublication
    from app.services.channel_posts import publish_channel_post_draft, ChannelImageContainerFailedError
    from sqlalchemy import select as sa_select
    import app.services.threads_publish as tp

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org_id, project_id = await _seed_org(s)
            await _seed_default_role(s, org_id)
            human_id = await _seed_human(s, org_id, project_id)
            connection_id = await _seed_connection(s, org_id)
            story_id = await _seed_story(s, org_id, project_id)

        _setup_org_scoped_app(app, Session, org_id, user_id=human_id, agent=False)
        async with _client_for(app) as client, Session() as s:
            draft_id = await _prepare_approved_image_draft(
                client, s, org_id=org_id, connection_id=connection_id, story_id=story_id, human_id=human_id,
            )
            with (
                patch.object(tp, "get_publishing_limit", AsyncMock(return_value=(0, 100, 3600))),
                patch.object(tp, "create_container", AsyncMock(return_value="container-stuck")),
            ):
                await client.post(f"/api/v2/organizations/{org_id}/channel-posts/drafts/{draft_id}/publish")

            pub = (await s.execute(
                sa_select(ChannelPublication).where(ChannelPublication.org_id == org_id)
            )).scalar_one()
            pub.created_at = datetime.now(timezone.utc) - timedelta(minutes=6)
            await s.commit()

            with (
                patch.object(tp, "get_publishing_limit", AsyncMock(return_value=(0, 100, 3600))),
                patch.object(tp, "get_container_status", AsyncMock(return_value=("IN_PROGRESS", None))),
            ):
                with pytest.raises(ChannelImageContainerFailedError) as exc_info:
                    await publish_channel_post_draft(
                        s, org_id=org_id, draft_id=draft_id, published_by_member_id=human_id,
                    )
            assert exc_info.value.container_status == "TIMEOUT"

            await s.refresh(pub)
            assert pub.status == "failed"
            assert pub.external_container_id is None
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()


@pytest.mark.anyio
async def test_processing_kind_awaiting_container_exposed_in_list():
    """AC5·§17-15 — command_status=pending ∧ publication_status=container_created →
    processing_kind='awaiting_container' 목록 응답에 노출."""
    from app.main import app
    import app.services.threads_publish as tp

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org_id, project_id = await _seed_org(s)
            await _seed_default_role(s, org_id)
            human_id = await _seed_human(s, org_id, project_id)
            connection_id = await _seed_connection(s, org_id)
            story_id = await _seed_story(s, org_id, project_id)

        _setup_org_scoped_app(app, Session, org_id, user_id=human_id, agent=False)
        async with _client_for(app) as client, Session() as s:
            draft_id = await _prepare_approved_image_draft(
                client, s, org_id=org_id, connection_id=connection_id, story_id=story_id, human_id=human_id,
            )
            with (
                patch.object(tp, "get_publishing_limit", AsyncMock(return_value=(0, 100, 3600))),
                patch.object(tp, "create_container", AsyncMock(return_value="container-img-5")),
            ):
                await client.post(f"/api/v2/organizations/{org_id}/channel-posts/drafts/{draft_id}/publish")

            r_list = await client.get(f"/api/v2/organizations/{org_id}/channel-posts/drafts")
        assert r_list.status_code == 200, r_list.text
        item = next(it for it in r_list.json() if it["draft_id"] == draft_id)
        assert item["command_status"] == "pending"
        assert item["publication_status"] == "container_created"
        assert item["processing_kind"] == "awaiting_container"
        assert item["thumbnail_url"] is not None
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()


