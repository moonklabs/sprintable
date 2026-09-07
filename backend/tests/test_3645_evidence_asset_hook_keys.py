"""story #3645(Phase2·BE, 페드루 PO 確定 2026-09-07 — 그라운딩 정정 후 3pt·BE만·#3987
뒤): evidence에 소재(asset) 계보 + hook_key 라벨.

그라운딩에서 정정된 두 가지(본문·코드 둘 다 근거):
① asset_master 개념은 코드 0건 — 블루프린트 "처분"을 "착지"로 읽은 PO 오독이었다.
   원장 개념을 새로 만들지 않는다. `channel_post_images.original_sha256`을 그대로
   소재 키로 쓴다.
② `verification_sheet` Evidence kind는 story #3561로 이미 존재 — 이 스토리 범위
   밖(③ 채택 안 함).

이 파일의 관심사:
1. `insight_snapshots.py::_resolve_channel_publication_asset_evidence`의 정규화
   (캐러셀 N장·릴스 영상+커버 2건·단일 이미지 1건·텍스트만 null·site_post kind는
   애초에 이미지 개념이 없어 null).
2. `channel_post_versions.hook_key` — 서버 형식 검사(≤64자·`[A-Za-z0-9_-]`, 422)·
   발행 뒤 편집이 이미 기록된 evidence에 영향 없음(카피지 참조가 아니다).

세팅 헬퍼는 test_620beefc_channel_post_image_upload.py(draft/이미지/연결)·
test_3497_insight_snapshots.py(스냅샷 스케줄/처리) 재사용(중복 재발명 금지)."""
from __future__ import annotations

import os
import uuid
from datetime import datetime, timedelta, timezone

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


async def _seed_image(session, *, org_id, draft_id, version_id, position, sha256=None):
    from app.models.channel_post_image import ChannelPostImage

    image = ChannelPostImage(
        id=uuid.uuid4(), org_id=org_id, draft_id=draft_id, version_id=version_id, position=position,
        original_object_path=f"org/{org_id}/img-{uuid.uuid4().hex[:8]}.jpg",
        original_sha256=sha256 or uuid.uuid4().hex,
        original_content_type="image/jpeg", original_bytes=1234,
        original_width=1080, original_height=1080, created_by=uuid.uuid4(),
    )
    session.add(image)
    await session.commit()
    return image


async def _seed_video(session, *, org_id, draft_id, version_id, sha256=None):
    from app.models.channel_post_video import ChannelPostVideo

    video = ChannelPostVideo(
        id=uuid.uuid4(), org_id=org_id, draft_id=draft_id, version_id=version_id,
        original_object_path=f"org/{org_id}/vid-{uuid.uuid4().hex[:8]}.mp4",
        original_sha256=sha256 or uuid.uuid4().hex,
        original_content_type="video/mp4", original_bytes=999999,
        duration_seconds=12.0, width=1080, height=1920, codec="avc1", created_by=uuid.uuid4(),
    )
    session.add(video)
    await session.commit()
    return video


async def _seed_channel_publication(session, *, org_id, connection_id, channel, version_id, external_id="media-1"):
    from app.models.channel_publication import ChannelPublication

    pub = ChannelPublication(
        id=uuid.uuid4(), org_id=org_id, gate_id=uuid.uuid4(), version_id=version_id,
        connection_id=connection_id, channel=channel, status="published",
        external_id=external_id, published_at=datetime.now(timezone.utc),
    )
    session.add(pub)
    await session.commit()
    return pub


@pytest.fixture(autouse=True)
def _enable_sandbox_adapter(monkeypatch):
    """test_3497_insight_snapshots.py의 dict 직접 주입 선례와 동형 — sandbox insight
    캡처 경로가 이 어댑터 등재를 요구한다."""
    import app.services.channel_adapters as adapters_mod

    sandbox_config = adapters_mod.ChannelAdapterConfig(
        authorize_url="", token_url="", scope="sandbox_publish,sandbox_delete",
        refresh_mode="manual", display_name="Sandbox", credential_kind="none", max_text_length=500,
        utm_source="sandbox", utm_medium="test", supports_unpublish=True,
        unpublish_required_scope="sandbox_delete",
        image_formats=("image/jpeg", "image/png"), image_max_bytes=8 * 1024 * 1024,
        image_aspect_max=10.0, image_width_min=320, image_width_max=1440,
        image_color_space="sRGB", image_max_count=10,
        insight_metrics=("impressions", "reach", "views", "engagements", "clicks", "spend", "conversions"),
    )
    monkeypatch.setitem(adapters_mod.CHANNEL_ADAPTERS, "sandbox", sandbox_config)
    yield


async def _capture_and_get_evidence(session, *, org_id, work_item_id, publication_id, publication_kind, channel="sandbox"):
    from app.models.evidence import Evidence
    from app.services.insight_snapshots import process_due_insight_snapshots, schedule_insight_snapshots
    from sqlalchemy import select

    due_soon = datetime.now(timezone.utc) - timedelta(minutes=1)
    await schedule_insight_snapshots(
        session, org_id=org_id, work_item_id=work_item_id, publication_id=publication_id,
        publication_kind=publication_kind, channel=channel, external_id=None,
        anchor_at=due_soon - timedelta(days=1),
    )
    await session.commit()
    counts = await process_due_insight_snapshots(session)
    assert counts["captured"] == 1, counts

    evidence = (await session.execute(
        select(Evidence).where(Evidence.work_item_id == work_item_id, Evidence.source == channel)
    )).scalar_one()
    return evidence


# ─── ①-normalize — asset_sha256s ──────────────────────────────────────────────


@pytest.mark.anyio
async def test_asset_sha256s_carousel_two_images_position_ordered():
    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org_id, project_id = await _seed_org(s)
            conn_id = await _seed_connection(s, org_id, channel="sandbox")
            draft_id = uuid.uuid4()
            version_id = uuid.uuid4()
            img0 = await _seed_image(s, org_id=org_id, draft_id=draft_id, version_id=version_id, position=0)
            img1 = await _seed_image(s, org_id=org_id, draft_id=draft_id, version_id=version_id, position=1)
            pub = await _seed_channel_publication(s, org_id=org_id, connection_id=conn_id, channel="sandbox", version_id=version_id)

            evidence = await _capture_and_get_evidence(
                s, org_id=org_id, work_item_id=uuid.uuid4(), publication_id=pub.id,
                publication_kind="channel_publication",
            )
            assert evidence.payload["asset_sha256s"] == [img0.original_sha256, img1.original_sha256]
    finally:
        await engine.dispose()


@pytest.mark.anyio
async def test_asset_sha256s_reels_video_then_cover():
    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org_id, project_id = await _seed_org(s)
            conn_id = await _seed_connection(s, org_id, channel="sandbox")
            draft_id = uuid.uuid4()
            version_id = uuid.uuid4()
            video = await _seed_video(s, org_id=org_id, draft_id=draft_id, version_id=version_id)
            cover = await _seed_image(s, org_id=org_id, draft_id=draft_id, version_id=version_id, position=0)
            pub = await _seed_channel_publication(s, org_id=org_id, connection_id=conn_id, channel="sandbox", version_id=version_id)

            evidence = await _capture_and_get_evidence(
                s, org_id=org_id, work_item_id=uuid.uuid4(), publication_id=pub.id,
                publication_kind="channel_publication",
            )
            assert evidence.payload["asset_sha256s"] == [video.original_sha256, cover.original_sha256]
    finally:
        await engine.dispose()


@pytest.mark.anyio
async def test_asset_sha256s_single_image():
    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org_id, project_id = await _seed_org(s)
            conn_id = await _seed_connection(s, org_id, channel="sandbox")
            draft_id = uuid.uuid4()
            version_id = uuid.uuid4()
            img = await _seed_image(s, org_id=org_id, draft_id=draft_id, version_id=version_id, position=0)
            pub = await _seed_channel_publication(s, org_id=org_id, connection_id=conn_id, channel="sandbox", version_id=version_id)

            evidence = await _capture_and_get_evidence(
                s, org_id=org_id, work_item_id=uuid.uuid4(), publication_id=pub.id,
                publication_kind="channel_publication",
            )
            assert evidence.payload["asset_sha256s"] == [img.original_sha256]
    finally:
        await engine.dispose()


@pytest.mark.anyio
async def test_asset_sha256s_text_only_null():
    """이미지도 영상도 없는(텍스트만) 버전 — 있는 걸 지어내지 않는다."""
    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org_id, project_id = await _seed_org(s)
            conn_id = await _seed_connection(s, org_id, channel="sandbox")
            version_id = uuid.uuid4()
            pub = await _seed_channel_publication(s, org_id=org_id, connection_id=conn_id, channel="sandbox", version_id=version_id)

            evidence = await _capture_and_get_evidence(
                s, org_id=org_id, work_item_id=uuid.uuid4(), publication_id=pub.id,
                publication_kind="channel_publication",
            )
            assert evidence.payload["asset_sha256s"] is None
    finally:
        await engine.dispose()


@pytest.mark.anyio
async def test_asset_sha256s_null_for_site_post_kind():
    """publication_kind="site_post"(hosted_site)는 이미지/영상 개념 자체가 없다 —
    channel_publication 축 조회를 아예 안 타는지 확認(기존 #3497 site_post 경로
    회귀 0)."""
    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org_id, project_id = await _seed_org(s)

            evidence = await _capture_and_get_evidence(
                s, org_id=org_id, work_item_id=uuid.uuid4(), publication_id=uuid.uuid4(),
                publication_kind="site_post",
            )
            assert evidence.payload["asset_sha256s"] is None
            assert evidence.payload["hook_key"] is None
    finally:
        await engine.dispose()


@pytest.mark.anyio
async def test_mutation_removing_asset_resolver_call_loses_asset_sha256s_key(monkeypatch):
    """뮤테이션 — evidence 기록에서 소재 계보 조회를 없애면 캐러셀 스냅샷의
    asset_sha256s가 None으로 무너진다(이 정규화가 실제로 그 결함을 잡는다는 증거)."""
    import app.services.insight_snapshots as insight_snapshots_module

    async def _never_resolves(db, snapshot):
        return None, None

    monkeypatch.setattr(
        insight_snapshots_module, "_resolve_channel_publication_asset_evidence", _never_resolves,
    )

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org_id, project_id = await _seed_org(s)
            conn_id = await _seed_connection(s, org_id, channel="sandbox")
            draft_id = uuid.uuid4()
            version_id = uuid.uuid4()
            await _seed_image(s, org_id=org_id, draft_id=draft_id, version_id=version_id, position=0)
            pub = await _seed_channel_publication(s, org_id=org_id, connection_id=conn_id, channel="sandbox", version_id=version_id)

            evidence = await _capture_and_get_evidence(
                s, org_id=org_id, work_item_id=uuid.uuid4(), publication_id=pub.id,
                publication_kind="channel_publication",
            )
            assert evidence.payload["asset_sha256s"] is None, "뮤테이션이 걸리지 않았다"
    finally:
        await engine.dispose()


# ─── ②-hook_key — 형식 검사·post-publish 편집 격리 ─────────────────────────────


@pytest.mark.anyio
async def test_hook_key_valid_persists_on_version():
    from app.main import app

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org_id, project_id = await _seed_org(s)
            user_id = await _seed_human(s, org_id, project_id)
            story_id = await _seed_story(s, org_id, project_id)
            conn_id = await _seed_connection(s, org_id, channel="sandbox")

        app.dependency_overrides.clear()
        _setup_org_scoped_app(app, Session, org_id, user_id=user_id)
        try:
            async with _client_for(app) as c:
                r = await c.post(
                    f"/api/v2/organizations/{org_id}/channel-posts/drafts",
                    json={
                        "work_item_id": str(story_id), "connection_id": str(conn_id),
                        "text": "훅 테스트", "hook_key": "hook-A_1",
                    },
                )
                assert r.status_code == 201, r.text
                assert r.json()["hook_key"] == "hook-A_1"
        finally:
            app.dependency_overrides.clear()
    finally:
        await engine.dispose()


@pytest.mark.anyio
async def test_hook_key_too_long_rejected_422():
    from app.main import app

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org_id, project_id = await _seed_org(s)
            user_id = await _seed_human(s, org_id, project_id)
            story_id = await _seed_story(s, org_id, project_id)
            conn_id = await _seed_connection(s, org_id, channel="sandbox")

        app.dependency_overrides.clear()
        _setup_org_scoped_app(app, Session, org_id, user_id=user_id)
        try:
            async with _client_for(app) as c:
                r = await c.post(
                    f"/api/v2/organizations/{org_id}/channel-posts/drafts",
                    json={
                        "work_item_id": str(story_id), "connection_id": str(conn_id),
                        "text": "훅 테스트", "hook_key": "x" * 65,
                    },
                )
                assert r.status_code == 422, r.text
        finally:
            app.dependency_overrides.clear()
    finally:
        await engine.dispose()


@pytest.mark.anyio
async def test_hook_key_invalid_characters_rejected_422():
    from app.main import app

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org_id, project_id = await _seed_org(s)
            user_id = await _seed_human(s, org_id, project_id)
            story_id = await _seed_story(s, org_id, project_id)
            conn_id = await _seed_connection(s, org_id, channel="sandbox")

        app.dependency_overrides.clear()
        _setup_org_scoped_app(app, Session, org_id, user_id=user_id)
        try:
            async with _client_for(app) as c:
                r = await c.post(
                    f"/api/v2/organizations/{org_id}/channel-posts/drafts",
                    json={
                        "work_item_id": str(story_id), "connection_id": str(conn_id),
                        "text": "훅 테스트", "hook_key": "hook key!",
                    },
                )
                assert r.status_code == 422, r.text
        finally:
            app.dependency_overrides.clear()
    finally:
        await engine.dispose()


@pytest.mark.anyio
async def test_hook_key_edit_after_publish_does_not_change_recorded_evidence():
    """발행 뒤 draft를 다시 편집(새 버전, hook_key 다른 값)해도 이미 기록된 evidence의
    hook_key는 안 바뀐다 — evidence가 그 시점(publication.version_id 고정)의 버전을
    카피했기 때문(참조 조회가 아니다)."""
    from app.main import app

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org_id, project_id = await _seed_org(s)
            user_id = await _seed_human(s, org_id, project_id)
            story_id = await _seed_story(s, org_id, project_id)
            conn_id = await _seed_connection(s, org_id, channel="sandbox")

        app.dependency_overrides.clear()
        _setup_org_scoped_app(app, Session, org_id, user_id=user_id)
        try:
            async with _client_for(app) as c:
                r1 = await c.post(
                    f"/api/v2/organizations/{org_id}/channel-posts/drafts",
                    json={
                        "work_item_id": str(story_id), "connection_id": str(conn_id),
                        "text": "훅 v1", "hook_key": "hook-v1",
                    },
                )
                assert r1.status_code == 201, r1.text
                published_version_id = uuid.UUID(r1.json()["version_id"])

                # 발행(그 버전을 가리키는 channel_publication)은 이 시점의 버전을 고정.
                async with Session() as s:
                    pub = await _seed_channel_publication(
                        s, org_id=org_id, connection_id=conn_id, channel="sandbox",
                        version_id=published_version_id,
                    )
                    evidence = await _capture_and_get_evidence(
                        s, org_id=org_id, work_item_id=story_id, publication_id=pub.id,
                        publication_kind="channel_publication",
                    )
                    assert evidence.payload["hook_key"] == "hook-v1"

                # 발행 뒤 편집(같은 draft, 새 버전) — hook_key를 다른 값으로.
                r2 = await c.post(
                    f"/api/v2/organizations/{org_id}/channel-posts/drafts",
                    json={
                        "work_item_id": str(story_id), "connection_id": str(conn_id),
                        "text": "훅 v2", "hook_key": "hook-v2",
                    },
                )
                assert r2.status_code == 201, r2.text
                assert r2.json()["version_id"] != str(published_version_id)

                # 이미 기록된 evidence는 v1 그대로.
                async with Session() as s:
                    from sqlalchemy import select
                    from app.models.evidence import Evidence
                    reloaded = (await s.execute(
                        select(Evidence).where(Evidence.id == evidence.id)
                    )).scalar_one()
                    assert reloaded.payload["hook_key"] == "hook-v1", "발행 뒤 편집이 옛 evidence를 조용히 바꿨다"
        finally:
            app.dependency_overrides.clear()
    finally:
        await engine.dispose()


@pytest.mark.anyio
async def test_mutation_removing_hook_key_pass_through_loses_hook_key_in_evidence(monkeypatch):
    """뮤테이션 — 라우터가 hook_key를 서비스로 안 넘기면(누락) 발행물의 hook_key가
    항상 None으로 무너진다."""
    from app.main import app
    import app.routers.channel_posts as channel_posts_router_module

    original = channel_posts_router_module.create_channel_post_draft_version

    async def _drop_hook_key(*args, **kwargs):
        kwargs.pop("hook_key", None)
        return await original(*args, **kwargs)

    monkeypatch.setattr(channel_posts_router_module, "create_channel_post_draft_version", _drop_hook_key)

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org_id, project_id = await _seed_org(s)
            user_id = await _seed_human(s, org_id, project_id)
            story_id = await _seed_story(s, org_id, project_id)
            conn_id = await _seed_connection(s, org_id, channel="sandbox")

        app.dependency_overrides.clear()
        _setup_org_scoped_app(app, Session, org_id, user_id=user_id)
        try:
            async with _client_for(app) as c:
                r = await c.post(
                    f"/api/v2/organizations/{org_id}/channel-posts/drafts",
                    json={
                        "work_item_id": str(story_id), "connection_id": str(conn_id),
                        "text": "훅 테스트", "hook_key": "hook-A",
                    },
                )
                assert r.status_code == 201, r.text
                assert r.json()["hook_key"] is None, "뮤테이션이 걸리지 않았다"
        finally:
            app.dependency_overrides.clear()
    finally:
        await engine.dispose()
