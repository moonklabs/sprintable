"""story #3679(3656 후속, 페드루 PO 確定 2026-09-07) — hook_key 왕복.

실물(2026-09-07 21:38Z) — `POST drafts`는 hook_key를 받고 201 응답(ChannelPost
DraftVersionResponse)에 에코하지만, `GET drafts/{id}`(ChannelPostDraftListItem)와
`GET drafts/{id}/versions`(ChannelPostVersionHistoryItem) 응답엔 hook_key가 없어
쓰고 나면 보드 묶음 말고는 어디서도 못 읽었다. `ChannelPostDraftVersion.hook_key`
컬럼은 story #3645부터 이미 있다(신규 마이그레이션 0) — 이 스토리는 순수 읽기
경로 additive 배선이다.

세팅 헬퍼는 test_620beefc_channel_post_image_upload.py 재사용(중복 재발명 금지,
test_3645_evidence_asset_hook_keys.py와 동형 관례)."""
from __future__ import annotations

import os
import uuid

import pytest

from tests.test_620beefc_channel_post_image_upload import (
    _client_for,
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


async def _setup(text: str, hook_key: str | None):
    from app.main import app

    engine, Session = await _session_factory()
    async with Session() as s:
        org_id, project_id = await _seed_org(s)
        user_id = await _seed_human(s, org_id, project_id)
        story_id = await _seed_story(s, org_id, project_id)
        conn_id = await _seed_connection(s, org_id, channel="sandbox")

    app.dependency_overrides.clear()
    _setup_org_scoped_app(app, Session, org_id, user_id=user_id)
    return engine, app, org_id, story_id, conn_id


@pytest.mark.anyio
async def test_get_draft_detail_includes_hook_key_when_tagged():
    engine, app, org_id, story_id, conn_id = await _setup("훅 왕복 테스트", "hook-A")
    try:
        async with _client_for(app) as c:
            create_res = await c.post(
                f"/api/v2/organizations/{org_id}/channel-posts/drafts",
                json={
                    "work_item_id": str(story_id), "connection_id": str(conn_id),
                    "text": "훅 왕복 테스트", "hook_key": "hook-A",
                },
            )
            assert create_res.status_code == 201, create_res.text
            draft_id = create_res.json()["draft_id"]

            detail_res = await c.get(f"/api/v2/organizations/{org_id}/channel-posts/drafts/{draft_id}")
            assert detail_res.status_code == 200, detail_res.text
            assert detail_res.json()["hook_key"] == "hook-A"

            list_res = await c.get(f"/api/v2/organizations/{org_id}/channel-posts/drafts")
            assert list_res.status_code == 200, list_res.text
            [row] = [r for r in list_res.json() if r["draft_id"] == draft_id]
            assert row["hook_key"] == "hook-A"

            versions_res = await c.get(f"/api/v2/organizations/{org_id}/channel-posts/drafts/{draft_id}/versions")
            assert versions_res.status_code == 200, versions_res.text
            versions = versions_res.json()
            assert len(versions) == 1
            assert versions[0]["hook_key"] == "hook-A"
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()


@pytest.mark.anyio
async def test_get_draft_detail_hook_key_null_when_untagged():
    """AC4(호환) — hook_key 없이 만든 초안은 지금과 같이 null·거부 없음."""
    engine, app, org_id, story_id, conn_id = await _setup("훅 없는 초안", None)
    try:
        async with _client_for(app) as c:
            create_res = await c.post(
                f"/api/v2/organizations/{org_id}/channel-posts/drafts",
                json={"work_item_id": str(story_id), "connection_id": str(conn_id), "text": "훅 없는 초안"},
            )
            assert create_res.status_code == 201, create_res.text
            draft_id = create_res.json()["draft_id"]
            assert create_res.json()["hook_key"] is None

            detail_res = await c.get(f"/api/v2/organizations/{org_id}/channel-posts/drafts/{draft_id}")
            assert detail_res.status_code == 200, detail_res.text
            assert detail_res.json()["hook_key"] is None

            versions_res = await c.get(f"/api/v2/organizations/{org_id}/channel-posts/drafts/{draft_id}/versions")
            assert versions_res.status_code == 200, versions_res.text
            assert versions_res.json()[0]["hook_key"] is None
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()


@pytest.mark.anyio
async def test_mutation_removing_hook_key_from_list_item_loses_it_on_read(monkeypatch):
    """뮤테이션 — `_to_draft_list_item()`이 hook_key를 안 실으면(옛 사각지대 재현)
    GET draft detail이 값을 잃는 것을 고정한다(이 배선이 실제로 값을 옮긴다는 증거)."""
    import app.routers.channel_posts as mod

    original = mod._to_draft_list_item

    def _without_hook_key(*args, **kwargs):
        item = original(*args, **kwargs)
        return item.model_copy(update={"hook_key": None})

    monkeypatch.setattr(mod, "_to_draft_list_item", _without_hook_key)

    engine, app, org_id, story_id, conn_id = await _setup("뮤테이션", "hook-A")
    try:
        async with _client_for(app) as c:
            create_res = await c.post(
                f"/api/v2/organizations/{org_id}/channel-posts/drafts",
                json={
                    "work_item_id": str(story_id), "connection_id": str(conn_id),
                    "text": "뮤테이션", "hook_key": "hook-A",
                },
            )
            draft_id = create_res.json()["draft_id"]
            detail_res = await c.get(f"/api/v2/organizations/{org_id}/channel-posts/drafts/{draft_id}")
            assert detail_res.json()["hook_key"] is None, "뮤테이션이 걸리지 않았다(hook_key가 여전히 읽힌다)"
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()
