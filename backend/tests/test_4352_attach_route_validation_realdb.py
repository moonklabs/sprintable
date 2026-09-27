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


async def test_import_route_after_the_limit_tightened_is_422_and_leaves_no_uploaded_object(tmp_path):
    """까디르 P1 · ③ — 이미지 **가져오기**(MCP/플러그인 에이전트 길: import → confirm → 새 버전)도 같은 매핑: 조인 한도에서 422
    `CHANNEL_TEXT_TOO_LONG` · 새 버전 0. 그리고 서버가 검사 **전**에 올린 객체가 거절 뒤 남지 않는다(고아 0).
    대조: 한도를 조이기 전 같은 가져오기는 성공하고 저장소 파일이 늘어난다(파일 세기가 헛돌지 않음)."""
    import base64

    from sqlalchemy import func, select

    from app.main import app
    from app.models.channel_post_version import ChannelPostVersion
    from app.services.channel_adapters import get_channel_adapter
    from tests.test_620beefc_channel_post_image_upload import _jpeg_bytes

    storage_root = tmp_path / ".storage"

    def stored_files() -> int:
        return sum(1 for p in storage_root.rglob("*") if p.is_file()) if storage_root.exists() else 0

    async def import_image(client, org_id, draft_id, raw):
        return await client.post(
            f"/api/v2/organizations/{org_id}/channel-posts/drafts/{draft_id}/assets/import-image",
            json={"image_base64": base64.b64encode(raw).decode("ascii"), "content_type": "image/jpeg"},
        )

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
            before_ok = stored_files()
            ok = await import_image(client, org_id, draft_id, _jpeg_bytes(800, 1000, color=(1, 2, 3)))
            assert ok.status_code == 201 or ok.status_code == 200, ok.text[:300]
            assert stored_files() > before_ok, "대조: 성공한 가져오기는 저장소에 객체를 남긴다"

            async with Session() as s:
                versions_before = (await s.execute(
                    select(func.count()).select_from(ChannelPostVersion).where(ChannelPostVersion.draft_id == uuid.UUID(draft_id))
                )).scalar_one()
            files_before = stored_files()
            object.__setattr__(adapter, "max_text_length", 1)
            resp = await import_image(client, org_id, draft_id, _jpeg_bytes(800, 1000, color=(4, 5, 6)))
        assert resp.status_code == 422, f"{resp.status_code}: {resp.text[:300]}"
        assert "CHANNEL_TEXT_TOO_LONG" in resp.text, resp.text[:300]
        assert stored_files() == files_before, "거절된 가져오기가 올린 객체가 저장소에 남았다(고아)"
        async with Session() as s:
            versions_after = (await s.execute(
                select(func.count()).select_from(ChannelPostVersion).where(ChannelPostVersion.draft_id == uuid.UUID(draft_id))
            )).scalar_one()
        assert versions_after == versions_before
    finally:
        object.__setattr__(adapter, "max_text_length", original_limit)
        app.dependency_overrides.clear()
        await engine.dispose()


async def _world_with_draft(Session):
    from app.main import app

    async with Session() as s:
        org_id, project_id = await _seed_org(s)
        human_id = await _seed_human(s, org_id, project_id)
        connection_id = await _seed_connection(s, org_id, channel="instagram")
        story_id = await _seed_story(s, org_id, project_id)
    _setup_org_scoped_app(app, Session, org_id, user_id=human_id, agent=False)
    return app, org_id, connection_id, story_id


def _count_files(root) -> int:
    return sum(1 for p in root.rglob("*") if p.is_file()) if root.exists() else 0


async def test_import_rejected_before_confirms_checks_still_removes_its_upload(tmp_path):
    """③ 가져오기 쪽 정리만 지키는 자리 — confirm의 검사 구간 **앞**에서 거절(장 수 초과)되면 confirm 안의 정리는 안 돈다. 서버가 올린
    객체는 가져오기 입구가 지운다(거절 뒤 저장소 파일 수 그대로)."""
    import base64

    from app.services.channel_adapters import get_channel_adapter
    from tests.test_620beefc_channel_post_image_upload import _jpeg_bytes

    engine, Session = await _session_factory()
    adapter = get_channel_adapter("instagram")
    original_max = adapter.image_max_count
    try:
        app, org_id, connection_id, story_id = await _world_with_draft(Session)
        async with _client_for(app) as client:
            draft_id = await _create_draft(client, org_id=org_id, connection_id=connection_id, story_id=story_id)
            body = {"image_base64": base64.b64encode(_jpeg_bytes(800, 1000)).decode("ascii"), "content_type": "image/jpeg"}
            url = f"/api/v2/organizations/{org_id}/channel-posts/drafts/{draft_id}/assets/import-image"
            first = await client.post(url, json=body)
            assert first.status_code in (200, 201), first.text[:300]
            object.__setattr__(adapter, "image_max_count", 1)
            files_before = _count_files(tmp_path / ".storage")
            resp = await client.post(url, json=body)
        assert resp.status_code == 422 and "CHANNEL_POST_IMAGE_COUNT_EXCEEDED" in resp.text, resp.text[:300]
        assert _count_files(tmp_path / ".storage") == files_before, "장 수 초과로 거절된 가져오기의 객체가 남았다(고아)"
    finally:
        object.__setattr__(adapter, "image_max_count", original_max)
        from app.main import app as _app
        _app.dependency_overrides.clear()
        await engine.dispose()


async def test_confirm_route_rejected_by_the_draft_version_check_removes_the_uploaded_object(tmp_path):
    """③ confirm 안 정리(새 버전 쓰기 구간)만 지키는 자리 — 확정 라우트(브라우저가 올린 객체)가 초안 버전 검사에서 거절되면 그 객체도
    어떤 행에도 안 걸린다 → 지운다. 가져오기 입구의 정리는 이 길을 안 탄다."""
    from app.services.channel_adapters import get_channel_adapter
    from tests.test_620beefc_channel_post_image_upload import _jpeg_bytes, _upload_and_confirm

    engine, Session = await _session_factory()
    adapter = get_channel_adapter("instagram")
    original_limit = adapter.max_text_length
    try:
        app, org_id, connection_id, story_id = await _world_with_draft(Session)
        async with _client_for(app) as client:
            draft_id = await _create_draft(client, org_id=org_id, connection_id=connection_id, story_id=story_id)
            files_before = _count_files(tmp_path / ".storage")
            object.__setattr__(adapter, "max_text_length", 1)
            resp = await _upload_and_confirm(client, org_id, draft_id, _jpeg_bytes(800, 1000), content_type="image/jpeg")
        assert resp.status_code == 422 and "CHANNEL_TEXT_TOO_LONG" in resp.text, resp.text[:300]
        assert _count_files(tmp_path / ".storage") == files_before, "거절된 확정의 업로드 객체가 남았다(고아)"
    finally:
        object.__setattr__(adapter, "max_text_length", original_limit)
        from app.main import app as _app
        _app.dependency_overrides.clear()
        await engine.dispose()


async def _committed_image_objects_alive(Session, draft_id, storage_root) -> tuple[int, bool]:
    """(이 초안의 이미지 행 수, 그 행들이 가리키는 원본 객체가 저장소에 전부 있는지)."""
    from sqlalchemy import select

    from app.models.channel_post_image import ChannelPostImage

    async with Session() as s:
        paths = list((await s.execute(
            select(ChannelPostImage.original_object_path).where(ChannelPostImage.draft_id == uuid.UUID(draft_id))
        )).scalars())
    files = {str(p.relative_to(storage_root)).split("/", 1)[-1] for p in storage_root.rglob("*") if p.is_file()} if storage_root.exists() else set()
    return len(paths), all(p in files for p in paths)


def _arm_commit_then_fail(monkeypatch):
    """«실패로 보고됐지만 실제로 커밋된» 커밋(연결 끊김 흉내): 이미지 행이 걸린 커밋만 진짜 커밋한 뒤 예외를 던진다."""
    from sqlalchemy.ext.asyncio import AsyncSession

    from app.models.channel_post_image import ChannelPostImage

    real_commit = AsyncSession.commit

    async def commit(self):
        has_image = any(isinstance(o, ChannelPostImage) for o in self.identity_map.values())
        await real_commit(self)
        if has_image:
            raise ConnectionError("connection lost after COMMIT was sent")

    monkeypatch.setattr(AsyncSession, "commit", commit)


def _arm_refresh_fail(monkeypatch):
    """커밋은 성공 · 그 뒤 refresh에서 던진다."""
    from sqlalchemy.ext.asyncio import AsyncSession

    from app.models.channel_post_image import ChannelPostImage

    real_refresh = AsyncSession.refresh

    async def refresh(self, instance, *args, **kwargs):
        if isinstance(instance, ChannelPostImage):
            raise ConnectionError("connection lost during refresh")
        return await real_refresh(self, instance, *args, **kwargs)

    monkeypatch.setattr(AsyncSession, "refresh", refresh)


@pytest.mark.parametrize("failure", ["commit_then_fail", "refresh_fail"])
async def test_import_failure_at_or_after_commit_keeps_the_committed_object(tmp_path, monkeypatch, failure):
    """까디르 09-27 ① ② — 커밋 중 · 뒤 실패(커밋은 들어감)면 행이 객체를 가리킨다 → 정리하면 끊긴 참조. 남는 고아 < 끊긴 참조:
    가져오기 입구 · confirm 정리 모두 지우지 않는다(행 1 · 객체 살아 있음)."""
    import base64

    from tests.test_620beefc_channel_post_image_upload import _jpeg_bytes

    engine, Session = await _session_factory()
    try:
        app, org_id, connection_id, story_id = await _world_with_draft(Session)
        async with _client_for(app) as client:
            draft_id = await _create_draft(client, org_id=org_id, connection_id=connection_id, story_id=story_id)
            (_arm_commit_then_fail if failure == "commit_then_fail" else _arm_refresh_fail)(monkeypatch)
            with pytest.raises(ConnectionError):
                await client.post(
                    f"/api/v2/organizations/{org_id}/channel-posts/drafts/{draft_id}/assets/import-image",
                    json={"image_base64": base64.b64encode(_jpeg_bytes(800, 1000)).decode("ascii"), "content_type": "image/jpeg"},
                )
        monkeypatch.undo()
        rows, alive = await _committed_image_objects_alive(Session, draft_id, tmp_path / ".storage")
        assert rows == 1, "커밋은 들어갔어야 한다(실패로 보고됐을 뿐)"
        assert alive, "커밋된 이미지 행이 가리키는 객체를 지웠다(끊긴 참조)"
    finally:
        from app.main import app as _app
        _app.dependency_overrides.clear()
        await engine.dispose()


async def test_confirm_route_commit_reported_failed_but_committed_keeps_the_object(tmp_path, monkeypatch):
    """② 확정 라우트 쪽 — confirm 정리 구간에 커밋이 들어 있으면 «실패로 보고된 커밋»에서 객체를 지워 끊긴 참조가 된다(뮤테이션 대조)."""
    from tests.test_620beefc_channel_post_image_upload import _jpeg_bytes, _upload_and_confirm

    engine, Session = await _session_factory()
    try:
        app, org_id, connection_id, story_id = await _world_with_draft(Session)
        async with _client_for(app) as client:
            draft_id = await _create_draft(client, org_id=org_id, connection_id=connection_id, story_id=story_id)
            _arm_commit_then_fail(monkeypatch)
            with pytest.raises(ConnectionError):
                await _upload_and_confirm(client, org_id, draft_id, _jpeg_bytes(800, 1000), content_type="image/jpeg")
        monkeypatch.undo()
        rows, alive = await _committed_image_objects_alive(Session, draft_id, tmp_path / ".storage")
        assert rows == 1
        assert alive, "커밋된 이미지 행이 가리키는 객체를 지웠다(끊긴 참조)"
    finally:
        from app.main import app as _app
        _app.dependency_overrides.clear()
        await engine.dispose()
