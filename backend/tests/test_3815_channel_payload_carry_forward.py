"""story #3815(이미지 carry-forward 통합, 페드루 PO 確定 2026-09-12) — 실 결함:
`channel_post_images.py`의 이미지 첨부(confirm)·삭제·재배열 3곳이 새 불변 버전을
만들며 `create_channel_post_draft_version(...)`에 channel_payload를 안 넘겨(당시
기본값 None) 직전 버전의 channel_payload(YouTube 메타·X 스레드 세그먼트·stibee
subject)를 매번 조용히 지웠다 — 배포 82 이후에도 남아 있던 실 데이터 손실.

처방(3곳 개별 패치가 아니라 근본 — 페드루 PO 明示 정정) — `create_channel_post_
draft_version` 자신의 기본값을 바꿨다: channel_payload 생략(None)이면 직전 버전
값을 캐리포워드, 명시적으로 비우려면 `{}`. `_copy_image_row` 통일(channel_posts.py
내부 인라인 복제 루프도 그 헬퍼로 교체)도 이 카드 범위(회귀 0 확인용, 별도 동작
변경 아님).

이 파일 — ① 공유 기본값 자체(직접 서비스 호출, 조직/스토리/커넥션만 시딩) ②
실 버그 재현 축(HTTP 왕복, 이미지 첨부→재배열→삭제 전 구간에서 channel_payload가
살아남는지 instagram 캐러셀로 증명 — image_max_count 10이라 3550 인프라 그대로
재사용, youtube/x_thread별 채널 특정 검증 게이트에 안 걸리게 임의 payload 사용)."""
from __future__ import annotations

import os
import uuid

import pytest

from tests.test_620beefc_channel_post_image_upload import (
    _client_for,
    _create_draft,
    _jpeg_bytes,
    _seed_connection,
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


_CHANNEL_MEDIA_BUCKET = "test-channel-media-3815-carry-forward"


@pytest.fixture(autouse=True)
def _local_channel_media_storage(monkeypatch, tmp_path):
    """test_620beefc의 동형 픽스처(§그 파일 주석 참고) — 다른 버킷명으로 격리."""
    import app.services.channel_post_images as cpi_module

    monkeypatch.setenv("STORAGE_PROVIDER", "local")
    monkeypatch.setenv("STORAGE_LOCAL_ROOT", str(tmp_path / ".storage"))
    monkeypatch.setattr(cpi_module, "CHANNEL_MEDIA_BUCKET", _CHANNEL_MEDIA_BUCKET)
    monkeypatch.setattr(cpi_module, "_PUBLIC_BASE", f"https://storage.googleapis.com/{_CHANNEL_MEDIA_BUCKET}/")
    yield


@pytest.fixture(autouse=True)
def _local_channel_media_storage_object_path_fix(monkeypatch):
    """test_3550_instagram_carousel.py와 동형 이유 — `_upload_and_confirm`이 참조하는
    object-path 헬퍼는 test_620beefc 모듈 전역의 버킷명을 쓰므로 이 파일 버킷명과 맞춘다."""
    import tests.test_620beefc_channel_post_image_upload as base_test_module

    monkeypatch.setattr(base_test_module, "_CHANNEL_MEDIA_BUCKET", _CHANNEL_MEDIA_BUCKET)


# ─── ① 공유 기본값 — create_channel_post_draft_version() 자신의 계약 ──────────

@pytest.mark.anyio
async def test_omitted_channel_payload_carries_forward_from_prior_version():
    """뮤테이션 킬 — 이 기본값을 다시 무조건 None으로 되돌리면 v2.channel_payload가
    None이 되어 이 assert가 RED."""
    from app.services.channel_posts import create_channel_post_draft_version

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org_id, project_id = await _seed_org(s)
            human_id = await _seed_human(s, org_id, project_id)
            story_id = await _seed_story(s, org_id, project_id)
            connection_id = await _seed_connection(s, org_id, channel="threads")

            v1, _channel, _violations = await create_channel_post_draft_version(
                s, org_id=org_id, work_item_id=story_id, connection_id=connection_id,
                text="v1", link_url=None, author_member_id=human_id, author_kind="human",
                channel_payload={"note": "v1 메타"},
            )
            assert v1.channel_payload == {"note": "v1 메타"}

            v2, _channel, _violations = await create_channel_post_draft_version(
                s, org_id=org_id, work_item_id=story_id, connection_id=connection_id,
                text="v2 — channel_payload 인자 자체를 안 넘김", link_url=None,
                author_member_id=human_id, author_kind="human",
            )
            assert v2.channel_payload == {"note": "v1 메타"}, (
                "channel_payload 생략 시 직전 버전 값이 캐리포워드돼야 한다"
            )
    finally:
        await engine.dispose()


@pytest.mark.anyio
async def test_explicit_none_also_carries_forward_matching_router_null_body():
    """라우터(`post_channel_post_draft_version`)는 매번 `channel_payload=body.
    channel_payload`를 명시 전달한다 — 클라이언트가 그 필드를 아예 안 보내면
    body.channel_payload도 None이라, "생략"과 "명시적 None 전달" 둘 다 캐리포워드로
    같이 묶여야 라우터 경로도 이 기본값의 혜택을 받는다(§services/channel_posts.py
    docstring)."""
    from app.services.channel_posts import create_channel_post_draft_version

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org_id, project_id = await _seed_org(s)
            human_id = await _seed_human(s, org_id, project_id)
            story_id = await _seed_story(s, org_id, project_id)
            connection_id = await _seed_connection(s, org_id, channel="threads")

            v1, _channel, _violations = await create_channel_post_draft_version(
                s, org_id=org_id, work_item_id=story_id, connection_id=connection_id,
                text="v1", link_url=None, author_member_id=human_id, author_kind="human",
                channel_payload={"note": "v1 메타"},
            )
            assert v1.channel_payload == {"note": "v1 메타"}

            v2, _channel, _violations = await create_channel_post_draft_version(
                s, org_id=org_id, work_item_id=story_id, connection_id=connection_id,
                text="v2 — channel_payload=None 명시", link_url=None,
                author_member_id=human_id, author_kind="human", channel_payload=None,
            )
            assert v2.channel_payload == {"note": "v1 메타"}
    finally:
        await engine.dispose()


@pytest.mark.anyio
async def test_explicit_empty_dict_clears_channel_payload_not_carried_forward():
    """「명시적으로 비우기」 축 — `{}`는 캐리포워드 대상이 아니라 그 자체가 새 값이다
    (None과 falsy를 뭉개면 이 구별이 죽는다, 페드루 PO 明示)."""
    from app.services.channel_posts import create_channel_post_draft_version

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org_id, project_id = await _seed_org(s)
            human_id = await _seed_human(s, org_id, project_id)
            story_id = await _seed_story(s, org_id, project_id)
            connection_id = await _seed_connection(s, org_id, channel="threads")

            v1, _channel, _violations = await create_channel_post_draft_version(
                s, org_id=org_id, work_item_id=story_id, connection_id=connection_id,
                text="v1", link_url=None, author_member_id=human_id, author_kind="human",
                channel_payload={"note": "v1 메타"},
            )
            assert v1.channel_payload == {"note": "v1 메타"}

            v2, _channel, _violations = await create_channel_post_draft_version(
                s, org_id=org_id, work_item_id=story_id, connection_id=connection_id,
                text="v2 — channel_payload={} 명시(비움)", link_url=None,
                author_member_id=human_id, author_kind="human", channel_payload={},
            )
            assert v2.channel_payload == {}, "명시적 {}는 캐리포워드되지 않고 그대로 비워져야 한다"
    finally:
        await engine.dispose()


@pytest.mark.anyio
async def test_new_draft_first_version_with_no_prior_defaults_to_none():
    """양성대조 — prior_latest 자체가 없는(신규 초안) 첫 버전은 캐리포워드할 대상이
    없으니 그대로 None(지어내지 않는다)."""
    from app.services.channel_posts import create_channel_post_draft_version

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org_id, project_id = await _seed_org(s)
            human_id = await _seed_human(s, org_id, project_id)
            story_id = await _seed_story(s, org_id, project_id)
            connection_id = await _seed_connection(s, org_id, channel="threads")

            v1, _channel, _violations = await create_channel_post_draft_version(
                s, org_id=org_id, work_item_id=story_id, connection_id=connection_id,
                text="첫 버전", link_url=None, author_member_id=human_id, author_kind="human",
            )
            assert v1.channel_payload is None
    finally:
        await engine.dispose()


# ─── ② 실 버그 재현 — 이미지 첨부/재배열/삭제 전 구간, HTTP 왕복 ──────────────

async def _latest_channel_payload(session, draft_id: str):
    from app.models.channel_post_version import ChannelPostVersion
    from sqlalchemy import select

    version = (await session.execute(
        select(ChannelPostVersion).where(ChannelPostVersion.draft_id == uuid.UUID(draft_id))
        .order_by(ChannelPostVersion.version.desc()).limit(1)
    )).scalar_one()
    return version.channel_payload


async def _latest_image_ids(session, draft_id: str) -> list[str]:
    """attach/delete/reorder 매번 `_copy_image_row`가 새 version_id·새 id로 행을
    복제하므로(§channel_post_images.py docstring), 이전 응답의 image_id는 다음 조작
    시점엔 이미 낡은 값이다 — 매번 최신 버전에서 현재 id들을 다시 읽어야 한다."""
    from app.models.channel_post_image import ChannelPostImage
    from app.models.channel_post_version import ChannelPostVersion
    from sqlalchemy import select

    version = (await session.execute(
        select(ChannelPostVersion).where(ChannelPostVersion.draft_id == uuid.UUID(draft_id))
        .order_by(ChannelPostVersion.version.desc()).limit(1)
    )).scalar_one()
    rows = (await session.execute(
        select(ChannelPostImage).where(ChannelPostImage.version_id == version.id)
        .order_by(ChannelPostImage.position)
    )).scalars().all()
    return [str(row.id) for row in rows]


@pytest.mark.anyio
async def test_image_attach_reorder_delete_all_preserve_channel_payload_end_to_end():
    """실 사고 재현·회귀 봉인 — instagram 캐러셀(image_max_count=10, youtube/x_thread
    같은 채널별 검증 게이트에 안 걸리는 임의 channel_payload 사용)로 이미지 첨부 2회
    →재배열→삭제 전 구간에서 channel_payload가 한 번도 안 떨어지는지 끝까지 추적한다
    (수정 前엔 매 단계 직후 None으로 떨어졌다 — 세 호출부 전부의 동형 결함이었다)."""
    from app.main import app

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org_id, project_id = await _seed_org(s)
            human_id = await _seed_human(s, org_id, project_id)
            story_id = await _seed_story(s, org_id, project_id)
            connection_id = await _seed_connection(s, org_id, channel="instagram")

        _setup_org_scoped_app(app, Session, org_id, user_id=human_id, agent=False)
        async with _client_for(app) as client:
            draft_id = await _create_draft(client, org_id=org_id, connection_id=connection_id, story_id=story_id)

            # channel_payload를 명시 세팅(라우터 경로 — 매 저장마다 body.channel_payload
            # 그대로 전달하는 그 자리) — 이 값이 아래 이미지 조작 3종을 거치는 동안
            # 살아남아야 한다.
            r = await client.post(
                f"/api/v2/organizations/{org_id}/channel-posts/drafts",
                json={
                    "work_item_id": str(story_id), "connection_id": str(connection_id),
                    "text": "캐러셀 채널페이로드 보존 확인", "channel_payload": {"note": "잃으면 안 되는 메타"},
                },
            )
            assert r.status_code == 201, r.text

            async with Session() as s:
                assert await _latest_channel_payload(s, draft_id) == {"note": "잃으면 안 되는 메타"}

            r1 = await _upload_and_confirm(client, org_id, draft_id, _jpeg_bytes(600, 600), content_type="image/jpeg")
            assert r1.status_code == 201, r1.text
            async with Session() as s:
                assert await _latest_channel_payload(s, draft_id) == {"note": "잃으면 안 되는 메타"}, (
                    "이미지 1장 첨부 뒤 channel_payload가 떨어짐(실 사고 재현)"
                )

            r2 = await _upload_and_confirm(client, org_id, draft_id, _jpeg_bytes(600, 600), content_type="image/jpeg")
            assert r2.status_code == 201, r2.text
            async with Session() as s:
                assert await _latest_channel_payload(s, draft_id) == {"note": "잃으면 안 되는 메타"}, (
                    "이미지 2번째 첨부 뒤 channel_payload가 떨어짐(실 사고 재현)"
                )
                current_ids = await _latest_image_ids(s, draft_id)
            assert len(current_ids) == 2, current_ids

            r_reorder = await client.post(
                f"/api/v2/organizations/{org_id}/channel-posts/drafts/{draft_id}/assets/reorder",
                json={"image_ids": list(reversed(current_ids))},
            )
            assert r_reorder.status_code == 200, r_reorder.text
            async with Session() as s:
                assert await _latest_channel_payload(s, draft_id) == {"note": "잃으면 안 되는 메타"}, (
                    "재배열 뒤 channel_payload가 떨어짐(실 사고 재현)"
                )
                current_ids = await _latest_image_ids(s, draft_id)
            assert len(current_ids) == 2, current_ids

            r_delete = await client.delete(
                f"/api/v2/organizations/{org_id}/channel-posts/drafts/{draft_id}/assets/{current_ids[0]}",
            )
            assert r_delete.status_code == 200, r_delete.text
            async with Session() as s:
                assert await _latest_channel_payload(s, draft_id) == {"note": "잃으면 안 되는 메타"}, (
                    "삭제 뒤 channel_payload가 떨어짐(실 사고 재현)"
                )
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()
