"""story 620beefc(Phase1·마케팅운영, 페드루 PO 決定 2026-09-04) — 텍스트 발행 회귀
(이미지 미첨부 경로 완전 무변경)·어댑터 이미지 규격 선언 노출(AC2)·업로드-URL create_only
서명(페드루 리뷰 블로커 B4). story #3579(2026-09-06, 페드루 PO 確定) 후속으로
`test_620beefc_channel_post_image.py`(25 테스트)에서 3-way 분할 — 원본 파일이 러너
정규화 60초 가드 경계대역(48~57s, PR #3925/#3926에서 174s/141s까지 관측)에 있어
러너가 조금만 느려져도 가드에 걸림. 세팅 헬퍼·픽스처는
`test_620beefc_channel_post_image_upload.py`에서 그대로 재사용(중복 재발명 0) —
autouse 픽스처(`_dispose_global_engine_after_test`·`_configure_secrets`·
`_local_channel_media_storage`)만 pytest 관례상 파일마다 재선언(import로는 전파 안 됨,
story #3562 전례와 동일).

이 파일 담당 — 이미지 없는 초안 발행이 기존 TEXT 동기 경로 그대로 도는지(회귀 0)·
연결 응답이 Threads/Instagram 이미지 규격을 정확히 노출하는지·업로드-URL이
create_only 서명만 요청하고 필요 헤더를 노출하는지(보안 블로커 B4)."""
from __future__ import annotations

import os
import uuid
from unittest.mock import AsyncMock, patch

import pytest

from tests.test_620beefc_channel_post_image_upload import (
    _approve_gate_directly,
    _client_for,
    _create_draft,
    _request_upload_url,
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


# ─── 텍스트 발행 회귀(이미지 미첨부 경로 완전 무변경) ────────────────────────

@pytest.mark.anyio
async def test_text_only_publish_unaffected_by_image_branch():
    """이미지 없는 초안은 has_image=False 분기를 안 타 기존 TEXT 동기 경로 그대로 —
    create_container에 image_url=None이 넘어가고 같은 호출 안에서 즉시 publish까지
    끝난다(비동기 대기 없음, 회귀 0)."""
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
            draft_id = await _create_draft(client, org_id=org_id, connection_id=connection_id, story_id=story_id)
            r_submit = await client.post(
                f"/api/v2/organizations/{org_id}/channel-posts/drafts/{draft_id}/submit", json={},
            )
            gate_id = uuid.UUID(r_submit.json()["gate_id"])
            await _approve_gate_directly(s, gate_id)

            captured = {}

            async def _fake_create_container(client_, *, access_token, threads_user_id, text, image_url=None):
                captured["image_url"] = image_url
                return "container-text-only"

            with (
                patch.object(tp, "get_publishing_limit", AsyncMock(return_value=(0, 100, 3600))),
                patch.object(tp, "create_container", AsyncMock(side_effect=_fake_create_container)),
                patch.object(tp, "publish_container", AsyncMock(return_value="media-text-only")),
                patch.object(tp, "get_permalink", AsyncMock(return_value=None)),
            ):
                r = await client.post(f"/api/v2/organizations/{org_id}/channel-posts/drafts/{draft_id}/publish")
        assert r.status_code == 200, r.text
        body = r.json()
        assert body["processing"] is False
        assert body["external_id"] == "media-text-only"
        assert captured["image_url"] is None
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()


# ─── AC2 — 어댑터 이미지 규격 선언 노출 ───────────────────────────────────────

@pytest.mark.anyio
async def test_connection_response_exposes_threads_image_spec():
    from app.main import app

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org_id, project_id = await _seed_org(s)
            human_id = await _seed_human(s, org_id, project_id)
            await _seed_connection(s, org_id)

        _setup_org_scoped_app(app, Session, org_id, user_id=human_id, agent=False)
        async with _client_for(app) as client:
            r = await client.get(f"/api/v2/organizations/{org_id}/channel-connections")
        assert r.status_code == 200, r.text
        rows = r.json()
        assert len(rows) == 1
        row = rows[0]
        assert row["image_formats"] == ["image/jpeg", "image/png"]
        assert row["image_max_bytes"] == 8 * 1024 * 1024
        assert row["image_aspect_max"] == 10.0
        # story #3530 — Threads는 하한 미선언(회귀 0, 0.0=«선언 안 함»).
        assert row["image_aspect_min"] == 0.0
        assert row["image_width_min"] == 320
        assert row["image_width_max"] == 1440
        assert row["image_color_space"] == "sRGB"
        assert row["image_max_count"] == 1
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()


# story #3530(BE #3872이 어댑터엔 이미 선언했으나 연결 응답엔 안 실었던 갭) —
# instagram은 하한(0.8)이 실제로 응답에 실려야 에디터가 「비율 1:1.25 ~ 1.91:1」
# 태그를 그릴 수 있다.
@pytest.mark.anyio
async def test_connection_response_exposes_instagram_aspect_min():
    from app.main import app

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org_id, project_id = await _seed_org(s)
            human_id = await _seed_human(s, org_id, project_id)
            await _seed_connection(s, org_id, channel="instagram")

        _setup_org_scoped_app(app, Session, org_id, user_id=human_id, agent=False)
        async with _client_for(app) as client:
            r = await client.get(f"/api/v2/organizations/{org_id}/channel-connections")
        assert r.status_code == 200, r.text
        row = r.json()[0]
        assert row["image_aspect_min"] == 0.8
        assert row["image_aspect_max"] == 1.91
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()


# ─── 페드루 리뷰 블로커 B4(보안) — create_only 서명 ──────────────────────────

@pytest.mark.anyio
async def test_upload_url_requests_create_only_signed_url_and_exposes_required_headers():
    """story 620beefc(페드루 리뷰 블로커 B4) — create_only=True 없이는 TTL(10분) 안에
    같은 서명 URL로 원본을 재PUT할 수 있어, confirm()이 이미 읽어 해시·봉인한 뒤 실제
    GCS 객체가 다른 바이트로 바뀔 수 있다(발행 바이트≠봉인 바이트). provider.
    signed_write_url이 실제로 create_only=True를 받는지, 응답에 provider가 요구하는
    헤더가 그대로 실리는지 직접 검증한다(story #3249 assets.py 선례와 동형 계약).
    LocalStorageProvider는 create_only PUT 수신을 구현 안 해(fail-closed) 이 축은
    provider를 목으로 대체해 signed_write_url 호출 인자 자체를 검증한다."""
    from app.main import app
    from unittest.mock import AsyncMock, MagicMock, patch

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org_id, project_id = await _seed_org(s)
            human_id = await _seed_human(s, org_id, project_id)
            connection_id = await _seed_connection(s, org_id)
            story_id = await _seed_story(s, org_id, project_id)

        _setup_org_scoped_app(app, Session, org_id, user_id=human_id, agent=False)
        fake_provider = MagicMock()
        fake_provider.signed_write_url = AsyncMock(return_value="https://storage.googleapis.com/fake-signed-url")
        fake_provider.required_write_headers = MagicMock(return_value={"x-goog-if-generation-match": "0"})

        import app.services.channel_post_images as cpi_mod
        async with _client_for(app) as client:
            draft_id = await _create_draft(client, org_id=org_id, connection_id=connection_id, story_id=story_id)
            with patch.object(cpi_mod, "get_storage_provider", return_value=fake_provider):
                r = await _request_upload_url(client, org_id, draft_id, content_type="image/png")
        assert r.status_code == 200, r.text
        body = r.json()
        assert body["required_put_headers"] == {"x-goog-if-generation-match": "0"}

        _, kwargs = fake_provider.signed_write_url.call_args
        assert kwargs["create_only"] is True
        fake_provider.required_write_headers.assert_called_once_with(create_only=True)
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()
