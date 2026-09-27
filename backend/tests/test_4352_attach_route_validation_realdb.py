"""story #4352 — 붙이기 라우트(이미지 순서 바꿈)도 초안 버전 검사 예외를 한 매핑으로 낸다(PO: «잠재» 칸도 이 PR에서).

지금 어댑터 선언 아래서는 붙이기가 이미 검사를 통과한 버전의 값을 이어 써 걸리지 않는다(도달 0). 하지만 한도가 바뀌는 날 이미
저장된 초안이 붙이기에서 코드 없는 500으로 터지는 같은 부류라, 테스트 안에서 어댑터 선언(글자 수 한도)을 조여 도달시킨다:
이미지 둘 있는 초안 → 한도를 본문보다 작게 → 순서 바꿈 → 422 `CHANNEL_TEXT_TOO_LONG` · 새 버전 0.
"""
from __future__ import annotations

import uuid

import pytest

from tests.test_3550_instagram_carousel import (  # noqa: F401 — 3550의 autouse 픽스처(비밀 키 · 로컬 미디어 저장소)를 그대로 쓴다
    _configure_secrets,
    _instagram_sandbox_ten_images,
    _local_channel_media_storage,
    _local_channel_media_storage_object_path_fix,
    _upload_n_images,
)
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
from tests.test_3550_instagram_carousel import _REAL_DB_URL

pytestmark = [
    pytest.mark.destructive_schema,
    pytest.mark.skipif(not _REAL_DB_URL, reason="real Postgres 필요"),
    pytest.mark.anyio,
]


@pytest.fixture
def anyio_backend():
    return "asyncio"


@pytest.fixture(autouse=True)
async def _dispose_global_engine_after_test():
    yield
    from app.core.database import engine as _global_engine
    await _global_engine.dispose()


async def test_reorder_after_the_channel_limit_tightened_is_422_with_the_shared_code_and_writes_no_version():
    from sqlalchemy import func, select

    from app.main import app
    from app.models.channel_post_image import ChannelPostImage
    from app.models.channel_post_version import ChannelPostVersion
    from app.services.channel_adapters import get_channel_adapter

    engine, Session = await _session_factory()
    adapter = get_channel_adapter("instagram")
    original_limit = adapter.max_text_length
    try:
        async with Session() as s:
            org_id, project_id = await _seed_org(s)
            human_id = await _seed_human(s, org_id, project_id)
            connection_id = await _seed_connection(s, org_id, channel="instagram")
            story_id = await _seed_story(s, org_id, project_id)
        _setup_org_scoped_app(app, Session, org_id, user_id=human_id, agent=False)

        async with _client_for(app) as client:
            draft_id = await _create_draft(client, org_id=org_id, connection_id=connection_id, story_id=story_id)
            _r1, r2 = await _upload_n_images(client, org_id, draft_id, 2)
            async with Session() as s:
                image_ids = [str(i) for i in (await s.execute(
                    select(ChannelPostImage.id).where(ChannelPostImage.version_id == uuid.UUID(r2.json()["version_id"]))
                    .order_by(ChannelPostImage.position)
                )).scalars()]
                versions_before = (await s.execute(
                    select(func.count()).select_from(ChannelPostVersion).where(ChannelPostVersion.draft_id == uuid.UUID(draft_id))
                )).scalar_one()
            # 어댑터 선언을 조인다(이미 저장된 본문이 새 한도를 넘는 날).
            object.__setattr__(adapter, "max_text_length", 1)
            resp = await client.post(
                f"/api/v2/organizations/{org_id}/channel-posts/drafts/{draft_id}/assets/reorder",
                json={"image_ids": list(reversed(image_ids))},
            )
        assert resp.status_code == 422, f"{resp.status_code}: {resp.text[:300]}"
        assert "CHANNEL_TEXT_TOO_LONG" in resp.text, resp.text[:300]
        async with Session() as s:
            versions_after = (await s.execute(
                select(func.count()).select_from(ChannelPostVersion).where(ChannelPostVersion.draft_id == uuid.UUID(draft_id))
            )).scalar_one()
        assert versions_after == versions_before, "검사에 걸린 순서 바꿈이 새 버전을 남겼다"
    finally:
        object.__setattr__(adapter, "max_text_length", original_limit)
        app.dependency_overrides.clear()
        await engine.dispose()
