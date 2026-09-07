"""story #3666(Phase2·마케팅운영, 페드루 PO 確定 2026-09-07) — MCP/플러그인 에이전트
전용 원콜 이미지 첨부 입구(`POST .../channel-posts/drafts/{draft_id}/assets/import-image`,
`image_base64`+`content_type` in → `confirm_channel_post_image_upload`까지 한 호출).

실물 갭: 미르코가 배포 52 표본(3656 소재/훅 그룹 성과 비교)을 MCP로 준비하려 했으나
`create_channel_post_draft`가 image를 안 받고, 기존 이미지 첨부는 3단계(upload-url 발급
→서명 PUT→confirm)라 Bash/HTTP 클라이언트가 없는 에이전트가 스스로 못 탔다.

세팅 헬퍼·픽스처는 `test_620beefc_channel_post_image_upload.py`에서 그대로 재사용(중복
재발명 0) — autouse 픽스처만 pytest 관례상 재선언(story #3562 전례와 동일)."""
from __future__ import annotations

import base64
import os
import uuid

import pytest

from tests.test_620beefc_channel_post_image_upload import (
    _client_for,
    _create_draft,
    _jpeg_bytes,
    _png_bytes,
    _seed_connection,
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
def _configure_secrets(monkeypatch):
    import importlib
    from cryptography.fernet import Fernet

    import app.core.config as config_module
    monkeypatch.setattr(config_module.settings, "channel_credential_encryption_key", Fernet.generate_key().decode())

    import app.services.channel_credential_crypto as crypto_module
    importlib.reload(crypto_module)
    yield
    importlib.reload(crypto_module)


_CHANNEL_MEDIA_BUCKET = "test-channel-media-3666"


@pytest.fixture(autouse=True)
def _local_channel_media_storage(monkeypatch, tmp_path):
    import app.services.channel_post_images as cpi_module

    monkeypatch.setenv("STORAGE_PROVIDER", "local")
    monkeypatch.setenv("STORAGE_LOCAL_ROOT", str(tmp_path / ".storage"))
    monkeypatch.setattr(cpi_module, "CHANNEL_MEDIA_BUCKET", _CHANNEL_MEDIA_BUCKET)
    monkeypatch.setattr(cpi_module, "_PUBLIC_BASE", f"https://storage.googleapis.com/{_CHANNEL_MEDIA_BUCKET}/")
    yield


async def _import_image(client, org_id, draft_id, raw: bytes, *, content_type: str):
    return await client.post(
        f"/api/v2/organizations/{org_id}/channel-posts/drafts/{draft_id}/assets/import-image",
        json={"image_base64": base64.b64encode(raw).decode("ascii"), "content_type": content_type},
    )


@pytest.mark.anyio
async def test_import_image_base64_attaches_and_confirms_in_one_call():
    """AC1 — 최저 지능 에이전트 AC: 도구 설명만으로(base64+content_type만) 3단계
    upload-url/PUT/confirm 없이 한 호출로 이미지가 첨부된다. confirm과 동형 응답
    (final_width·was_converted 등)이 그대로 나온다(새 응답 계약 0)."""
    from app.main import app

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org_id, project_id = await _seed_org(s)
            human_id = await _seed_human(s, org_id, project_id)
            connection_id = await _seed_connection(s, org_id)
            story_id = await _seed_story(s, org_id, project_id)

        _setup_org_scoped_app(app, Session, org_id, user_id=human_id, agent=False)
        async with _client_for(app) as client:
            draft_id = await _create_draft(client, org_id=org_id, connection_id=connection_id, story_id=story_id)
            raw = _png_bytes(800, 600)
            r = await _import_image(client, org_id, draft_id, raw, content_type="image/png")
        assert r.status_code == 201, r.text
        body = r.json()
        assert body["was_converted"] is False
        assert body["original_width"] == 800
        assert body["final_bytes"] == len(raw)
        assert body["version"] == 2  # v1=텍스트만, v2=이미지 첨부(새 버전, confirm과 동형).
        assert body["image_url"] is not None
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()


@pytest.mark.anyio
async def test_import_image_same_bytes_twice_same_sha256():
    """AC2 — 3656(소재/훅 그룹 성과 비교)의 «같은 소재→같은 asset_sha256s» 전제 실측:
    같은 원본 bytes를 두 초안(같은 소재, 다른 draft — 훅 A/B 비교 시나리오와 동형)에
    각각 원콜로 첨부해도 confirm이 계산하는 `original_sha256`(story #3645
    asset_sha256s의 원자재)은 완전히 같다. 응답에 sha256이 직접 안 실려(계약 무변경)
    DB 행을 직접 읽어 확認한다."""
    from app.main import app
    from app.models.channel_post_image import ChannelPostImage
    from sqlalchemy import select

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org_id, project_id = await _seed_org(s)
            human_id = await _seed_human(s, org_id, project_id)
            connection_id = await _seed_connection(s, org_id)
            story_id_a = await _seed_story(s, org_id, project_id, title="포스트 A(훅1)")
            story_id_b = await _seed_story(s, org_id, project_id, title="포스트 B(훅2)")

        _setup_org_scoped_app(app, Session, org_id, user_id=human_id, agent=False)
        raw = _jpeg_bytes(640, 480)
        async with _client_for(app) as client:
            draft_a = await _create_draft(client, org_id=org_id, connection_id=connection_id, story_id=story_id_a)
            draft_b = await _create_draft(client, org_id=org_id, connection_id=connection_id, story_id=story_id_b)
            r_a = await _import_image(client, org_id, draft_a, raw, content_type="image/jpeg")
            r_b = await _import_image(client, org_id, draft_b, raw, content_type="image/jpeg")
        assert r_a.status_code == 201, r_a.text
        assert r_b.status_code == 201, r_b.text

        async with Session() as s:
            rows = (await s.execute(
                select(ChannelPostImage.original_sha256).where(
                    ChannelPostImage.draft_id.in_([uuid.UUID(draft_a), uuid.UUID(draft_b)]),
                )
            )).scalars().all()
        assert len(rows) == 2
        assert rows[0] == rows[1]
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()


@pytest.mark.anyio
async def test_import_image_invalid_base64_returns_400():
    """content_type이 image/*가 아니거나 base64가 깨졌으면 confirm까지 안 가고
    즉시 400(VALIDATION_ERROR) — import_image_artifact(visual_artifacts.py)와
    동형 계약."""
    from app.main import app

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org_id, project_id = await _seed_org(s)
            human_id = await _seed_human(s, org_id, project_id)
            connection_id = await _seed_connection(s, org_id)
            story_id = await _seed_story(s, org_id, project_id)

        _setup_org_scoped_app(app, Session, org_id, user_id=human_id, agent=False)
        async with _client_for(app) as client:
            draft_id = await _create_draft(client, org_id=org_id, connection_id=connection_id, story_id=story_id)

            r_bad_type = await client.post(
                f"/api/v2/organizations/{org_id}/channel-posts/drafts/{draft_id}/assets/import-image",
                json={"image_base64": base64.b64encode(b"not-an-image").decode(), "content_type": "text/plain"},
            )
            assert r_bad_type.status_code == 400, r_bad_type.text
            assert (r_bad_type.json().get("error") or r_bad_type.json())["code"] == "VALIDATION_ERROR"

            r_bad_b64 = await client.post(
                f"/api/v2/organizations/{org_id}/channel-posts/drafts/{draft_id}/assets/import-image",
                json={"image_base64": "not-valid-base64!!!", "content_type": "image/png"},
            )
            assert r_bad_b64.status_code == 400, r_bad_b64.text
            assert (r_bad_b64.json().get("error") or r_bad_b64.json())["code"] == "VALIDATION_ERROR"
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()


@pytest.mark.anyio
async def test_import_image_undecodable_bytes_returns_422_same_as_confirm():
    """content_type은 image/*로 통과해도 실제로 디코드 불가능한 바이트면(진짜 이미지가
    아닌 쓰레기 bytes) confirm과 동일하게 422 CHANNEL_IMAGE_UNDECODABLE — 에러 매핑을
    `_confirm_image_upload_or_raise`로 공유한다는 것의 직접 증거(신규 매핑 사본 0)."""
    from app.main import app

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org_id, project_id = await _seed_org(s)
            human_id = await _seed_human(s, org_id, project_id)
            connection_id = await _seed_connection(s, org_id)
            story_id = await _seed_story(s, org_id, project_id)

        _setup_org_scoped_app(app, Session, org_id, user_id=human_id, agent=False)
        async with _client_for(app) as client:
            draft_id = await _create_draft(client, org_id=org_id, connection_id=connection_id, story_id=story_id)
            r = await _import_image(client, org_id, draft_id, b"garbage-not-a-real-image-payload", content_type="image/png")
        assert r.status_code == 422, r.text
        assert (r.json().get("error") or r.json())["code"] == "CHANNEL_IMAGE_UNDECODABLE"
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()
