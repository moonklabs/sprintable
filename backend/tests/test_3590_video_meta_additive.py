"""story #3590(Phase2·BE→FE·소형, 페드루 PO 確定 2026-09-06) — 유나 §17-23 ⑤-1
정정: 릴스 메타 줄(길이·해상도·코덱·용량)이 업로드 직후엔 섰지만 재진입
(단건 재조회)에서는 draft 상세가 `video_url`만 실어 사라지던 결함의 BE 몫.

`ChannelPostVideoMeta{duration_seconds,width,height,codec,original_bytes}`가
`ChannelPostVideoResponse`(confirm 응답)와 정확히 같은 필드명·타입으로
`ChannelPostDraftListItem.video_meta`에 additive — video_url과 동형 관례
(단건 전용·같은 video_row 재사용, 추가 쿼리 0).

원래 test_3559_video_fields_additive.py에 얹었었는데 페드루 PO 리뷰(2026-09-06
14:37Z) — 그 파일 weights가 이미 40.0s(story #3579 60초 가드 경계대역 시작점)
라 재측정 없이 2건을 더 얹으면 안 된다는 조건으로 이 파일로 분리했다. 세팅
헬퍼는 test_3559_video_fields_additive.py 그대로 재사용(중복 재발명 금지)."""
from __future__ import annotations

import os

import pytest

from tests.test_620beefc_channel_post_image_upload import (
    _client_for,
    _create_draft,
    _seed_connection,
    _seed_human,
    _seed_org,
    _seed_story,
    _session_factory,
    _setup_org_scoped_app,
)
from tests.test_3559_video_fields_additive import (
    _VALID_9_16,
    _build_mp4,
    _upload_and_confirm_video,
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


_CHANNEL_MEDIA_BUCKET = "test-channel-media-3590"


@pytest.fixture(autouse=True)
def _local_channel_media_storage(monkeypatch, tmp_path):
    """test_3559_video_fields_additive.py와 동형 픽스처(다른 버킷명으로 격리)."""
    import app.services.channel_post_images as cpi_module

    monkeypatch.setenv("STORAGE_PROVIDER", "local")
    monkeypatch.setenv("STORAGE_LOCAL_ROOT", str(tmp_path / ".storage"))
    monkeypatch.setattr(cpi_module, "CHANNEL_MEDIA_BUCKET", _CHANNEL_MEDIA_BUCKET)
    monkeypatch.setattr(cpi_module, "_PUBLIC_BASE", f"https://storage.googleapis.com/{_CHANNEL_MEDIA_BUCKET}/")
    yield


@pytest.fixture(autouse=True)
def _local_channel_media_storage_object_path_fix(monkeypatch):
    """test_3559_video_fields_additive.py와 동형 — `_upload_and_confirm_video`가
    내부에서 쓰는 `test_620beefc_channel_post_image_upload._put_raw_object`가
    그 모듈 자신의 `_CHANNEL_MEDIA_BUCKET`(호출 시점 값)을 읽으므로, 이 파일의
    버킷명과 동기화하지 않으면 PUT과 confirm(head_object)이 서로 다른 버킷을
    봐 404가 난다."""
    import tests.test_620beefc_channel_post_image_upload as base_test_module

    monkeypatch.setattr(base_test_module, "_CHANNEL_MEDIA_BUCKET", _CHANNEL_MEDIA_BUCKET)
    yield


@pytest.mark.anyio
async def test_draft_detail_video_meta_present_when_video_confirmed():
    """유나 §17-23 ⑤-1 정정 — 업로드 직후뿐 아니라 재진입(단건 재조회)에서도
    메타 줄(길이·해상도·코덱·용량)이 같은 값으로 서야 한다. video_url과 같은
    video_row 재사용(추가 쿼리 0) — confirm 응답과 정확히 같은 값이어야 FE
    formatVideoMetaLine이 두 응답을 같은 코드로 처리할 수 있다."""
    from app.main import app

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org_id, project_id = await _seed_org(s)
            human_id = await _seed_human(s, org_id, project_id)
            connection_id = await _seed_connection(s, org_id, channel="instagram")
            story_id = await _seed_story(s, org_id, project_id)

        _setup_org_scoped_app(app, Session, org_id, user_id=human_id, agent=False)
        async with _client_for(app) as client:
            draft_id = await _create_draft(client, org_id=org_id, connection_id=connection_id, story_id=story_id)
            raw = _build_mp4(duration_seconds=6.0, **_VALID_9_16)
            r_video = await _upload_and_confirm_video(client, org_id, draft_id, raw)
            assert r_video.status_code == 201, r_video.text
            confirm_body = r_video.json()

            # 재진입 — 새 GET 왕복(업로드 직후 응답이 아니라 별개 단건 재조회).
            r_detail = await client.get(f"/api/v2/organizations/{org_id}/channel-posts/drafts/{draft_id}")
        assert r_detail.status_code == 200, r_detail.text
        video_meta = r_detail.json()["video_meta"]
        assert video_meta is not None
        assert video_meta["duration_seconds"] == confirm_body["duration_seconds"]
        assert video_meta["width"] == confirm_body["width"]
        assert video_meta["height"] == confirm_body["height"]
        assert video_meta["codec"] == confirm_body["codec"]
        assert video_meta["original_bytes"] == confirm_body["original_bytes"]
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()


@pytest.mark.anyio
async def test_draft_detail_video_meta_null_when_no_media():
    from app.main import app

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org_id, project_id = await _seed_org(s)
            human_id = await _seed_human(s, org_id, project_id)
            connection_id = await _seed_connection(s, org_id, channel="instagram")
            story_id = await _seed_story(s, org_id, project_id)

        _setup_org_scoped_app(app, Session, org_id, user_id=human_id, agent=False)
        async with _client_for(app) as client:
            draft_id = await _create_draft(client, org_id=org_id, connection_id=connection_id, story_id=story_id)
            r_detail = await client.get(f"/api/v2/organizations/{org_id}/channel-posts/drafts/{draft_id}")
        assert r_detail.status_code == 200, r_detail.text
        assert r_detail.json()["video_meta"] is None
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()
