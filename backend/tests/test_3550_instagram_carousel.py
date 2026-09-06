"""story #3550(Phase2·마케팅운영, 페드루 PO 確定 2026-09-06) — Instagram 캐러셀(이미지
2~10장). PO 못박음 4가지:
① N=1 항등 — 이미 봉인된 단일-이미지 버전이 이 스토리로 "변조" 판정되면 안 된다.
② 저장 구조 — UNIQUE(version_id, position)·순서 재배열도 바꿔치기와 동형으로 봉인을
   깬다.
③ N > image_max_count 거부는 서버(422 CHANNEL_POST_IMAGE_COUNT_EXCEEDED).
④ Instagram 캐러셀 컨테이너(부모+children) — sandbox 어댑터 동형 선언·자식 실패=
   원자성(부모 0건).

세팅 헬퍼는 test_620beefc_channel_post_image.py 재사용(중복 재발명 금지)."""
from __future__ import annotations

import os
import uuid
from datetime import datetime, timezone
from unittest.mock import AsyncMock, patch

import pytest

from tests.test_620beefc_channel_post_image import (
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


_CHANNEL_MEDIA_BUCKET = "test-channel-media-3550"


@pytest.fixture(autouse=True)
def _local_channel_media_storage(monkeypatch, tmp_path):
    """test_620beefc_channel_post_image.py의 동형 픽스처(중복 재발명 대신 이 파일도
    같은 기법 — 다른 버킷명으로 격리)."""
    import app.services.channel_post_images as cpi_module

    monkeypatch.setenv("STORAGE_PROVIDER", "local")
    monkeypatch.setenv("STORAGE_LOCAL_ROOT", str(tmp_path / ".storage"))
    monkeypatch.setattr(cpi_module, "CHANNEL_MEDIA_BUCKET", _CHANNEL_MEDIA_BUCKET)
    monkeypatch.setattr(cpi_module, "_PUBLIC_BASE", f"https://storage.googleapis.com/{_CHANNEL_MEDIA_BUCKET}/")
    yield


@pytest.fixture(autouse=True)
def _local_channel_media_storage_object_path_fix(monkeypatch):
    """test_620beefc의 `_put_raw_object`/`_object_path_for`가 모듈 상수
    `_CHANNEL_MEDIA_BUCKET`(그 파일 자체)을 쓰므로, 이 파일에서 재사용할 때도 같은
    이름의 버킷이어야 앞뒤가 맞는다 — 두 파일이 같은 상수명을 각자 갖되 여기서는
    import한 헬퍼가 그 파일의 전역을 참조하므로, monkeypatch로 그 값을 이 파일의
    버킷명과 맞춘다."""
    import tests.test_620beefc_channel_post_image as base_test_module

    monkeypatch.setattr(base_test_module, "_CHANNEL_MEDIA_BUCKET", _CHANNEL_MEDIA_BUCKET)
    yield


@pytest.fixture(autouse=True)
def _instagram_sandbox_ten_images(monkeypatch):
    """story #3320 test 파일의 `_enable_sandbox_flag`와 동형 — 이미 등재돼 있을 수도
    없을 수도 있는 조건부 블록(SANDBOX_CHANNEL_ENABLED, 모듈 import 시점 1회 평가)에
    기대지 않고 이 테스트 파일이 필요로 하는 정확한 값(image_max_count=10)을 직접
    주입한다(import 순서 무관하게 결정적)."""
    import app.services.channel_adapters as adapters_mod

    ig_sandbox_cfg = adapters_mod.ChannelAdapterConfig(
        authorize_url="", token_url="", scope="sandbox_publish,sandbox_delete",
        refresh_mode="manual", credential_kind="none", display_name="Instagram Sandbox",
        max_text_length=2200, utm_source="instagram_sandbox", utm_medium="test",
        image_formats=("image/jpeg",), image_max_bytes=8 * 1024 * 1024,
        image_aspect_max=1.91, image_aspect_min=0.8,
        image_width_min=320, image_width_max=1440, image_color_space="sRGB",
        image_max_count=10,
    )
    monkeypatch.setitem(adapters_mod.CHANNEL_ADAPTERS, "instagram_sandbox", ig_sandbox_cfg)
    yield


async def _upload_n_images(client, org_id, draft_id, n: int, *, size=(800, 1000)):
    """n장을 순서대로 업로드·confirm한다. 각 confirm 응답을 리스트로 반환."""
    responses = []
    for i in range(n):
        raw = _jpeg_bytes(*size, color=(10 * i, 50, 80))
        r = await _upload_and_confirm(client, org_id, draft_id, raw, content_type="image/jpeg")
        responses.append(r)
    return responses


# ─── ① N=1 항등 ────────────────────────────────────────────────────────────────


@pytest.mark.anyio
async def test_single_image_seal_hash_is_identity_not_a_hash_of_hash():
    """페드루 PO 못박음① — N=1이면 ChannelPostVersion.image_sha256이 그 이미지의
    final_sha256과 정확히 같아야 한다(합성 해시를 한 번 더 씌우면 안 됨 — 기존
    승인된 단일-이미지 게이트가 이 스토리 배포로 「변조」로 뒤집히는 회귀)."""
    from app.main import app
    from app.models.channel_post_image import ChannelPostImage
    from app.models.channel_post_version import ChannelPostVersion
    from sqlalchemy import select

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
            [r1] = await _upload_n_images(client, org_id, draft_id, 1)
        assert r1.status_code == 201, r1.text
        assert r1.json()["position"] == 0

        async with Session() as s:
            version = (await s.execute(
                select(ChannelPostVersion).where(ChannelPostVersion.draft_id == uuid.UUID(draft_id))
                .order_by(ChannelPostVersion.version.desc()).limit(1)
            )).scalar_one()
            image = (await s.execute(
                select(ChannelPostImage).where(ChannelPostImage.version_id == version.id)
            )).scalar_one()
        assert version.image_sha256 == image.final_sha256, "N=1인데 합성 해시가 씌워졌다(항등 위반)"
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()


# ─── ② 저장 구조 — position·합성 해시·양성대조(바꿔치기·재배열) ────────────────


@pytest.mark.anyio
async def test_three_images_get_sequential_positions_and_composite_seal_hash():
    from app.main import app
    from app.models.channel_post_image import ChannelPostImage
    from app.models.channel_post_version import ChannelPostVersion
    from app.services.channel_post_images import compute_image_seal_hash
    from sqlalchemy import select

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
            r1, r2, r3 = await _upload_n_images(client, org_id, draft_id, 3)
        for r in (r1, r2, r3):
            assert r.status_code == 201, r.text
        assert [r.json()["position"] for r in (r1, r2, r3)] == [0, 1, 2]

        async with Session() as s:
            latest_version = (await s.execute(
                select(ChannelPostVersion).where(ChannelPostVersion.draft_id == uuid.UUID(draft_id))
                .order_by(ChannelPostVersion.version.desc()).limit(1)
            )).scalar_one()
            images = list((await s.execute(
                select(ChannelPostImage).where(ChannelPostImage.version_id == latest_version.id)
                .order_by(ChannelPostImage.position)
            )).scalars().all())
        assert len(images) == 3
        assert [img.position for img in images] == [0, 1, 2]
        expected = compute_image_seal_hash([img.final_sha256 for img in images])
        assert latest_version.image_sha256 == expected
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()


def test_compute_image_seal_hash_positive_control_swap_and_reorder_both_break_seal():
    """페드루 PO 못박음② 양성대조(순수 함수, DB 불요) — 1장 바꿔치기·순서 재배열
    둘 다 합성 해시를 바꿔야 한다(디디 설계 메모에서 실측한 그대로 코드로 pin)."""
    from app.services.channel_post_images import compute_image_seal_hash

    original = ["aaa111", "bbb222", "ccc333"]
    swapped_position_2 = ["aaa111", "XXXXXX", "ccc333"]
    reordered = ["ccc333", "bbb222", "aaa111"]

    base = compute_image_seal_hash(original)
    assert base != compute_image_seal_hash(swapped_position_2), "2번째 이미지 바꿔치기가 봉인을 안 깼다"
    assert base != compute_image_seal_hash(reordered), "순서 재배열이 봉인을 안 깼다"


def test_compute_image_seal_hash_single_element_is_identity():
    from app.services.channel_post_images import compute_image_seal_hash

    assert compute_image_seal_hash(["only-one-hash"]) == "only-one-hash"


@pytest.mark.anyio
async def test_text_only_edit_after_carousel_carries_forward_all_images_with_positions():
    """텍스트만 편집한 새 버전(이미지 재첨부 없음)도 N장 전부를 새 version_id로
    복제해야 한다 — 단일-이미지 carry-forward 버그(channel_posts.py 주석 참고)의
    N장 버전 재발 방지."""
    from app.main import app
    from app.models.channel_post_image import ChannelPostImage
    from app.models.channel_post_version import ChannelPostVersion
    from app.services.channel_posts import create_channel_post_draft_version, get_channel_post_draft
    from sqlalchemy import select

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
            await _upload_n_images(client, org_id, draft_id, 2)

        async with Session() as s:
            draft = await get_channel_post_draft(s, org_id=org_id, draft_id=uuid.UUID(draft_id))
            latest_before = (await s.execute(
                select(ChannelPostVersion).where(ChannelPostVersion.draft_id == uuid.UUID(draft_id))
                .order_by(ChannelPostVersion.version.desc()).limit(1)
            )).scalar_one()
            new_version, _channel, _violations = await create_channel_post_draft_version(
                s, org_id=org_id, work_item_id=draft.work_item_id, connection_id=draft.connection_id,
                text="본문만 고침", link_url=latest_before.link_url,
                author_member_id=human_id, author_kind="human",
            )
            images = list((await s.execute(
                select(ChannelPostImage).where(ChannelPostImage.version_id == new_version.id)
                .order_by(ChannelPostImage.position)
            )).scalars().all())
        assert len(images) == 2, "텍스트만 편집했는데 캐러셀 2장이 새 버전으로 안 이어졌다"
        assert [img.position for img in images] == [0, 1]
        assert new_version.image_sha256 == latest_before.image_sha256, "carry-forward인데 봉인 해시가 바뀌었다"
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()


# ─── ③ N > image_max_count 서버 거부 ───────────────────────────────────────────


@pytest.mark.anyio
async def test_eleventh_image_upload_rejected_with_422_count_exceeded():
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
            responses = await _upload_n_images(client, org_id, draft_id, 10)
            for r in responses:
                assert r.status_code == 201, r.text
            r11 = (await _upload_n_images(client, org_id, draft_id, 1))[0]
        assert r11.status_code == 422, r11.text
        body = r11.json()
        assert body["error"]["code"] == "CHANNEL_POST_IMAGE_COUNT_EXCEEDED"
        assert body["error"]["image_max_count"] == 10
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()


@pytest.mark.anyio
async def test_second_image_on_threads_rejected_max_count_one_regression():
    """회귀 0 — Threads는 여전히 image_max_count=1(이 스토리로 안 바뀜), 2번째
    이미지는 여전히 거부돼야 한다."""
    from app.main import app

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org_id, project_id = await _seed_org(s)
            human_id = await _seed_human(s, org_id, project_id)
            connection_id = await _seed_connection(s, org_id, channel="threads")
            story_id = await _seed_story(s, org_id, project_id)
        _setup_org_scoped_app(app, Session, org_id, user_id=human_id, agent=False)

        async with _client_for(app) as client:
            draft_id = await _create_draft(client, org_id=org_id, connection_id=connection_id, story_id=story_id)
            r1, r2 = await _upload_n_images(client, org_id, draft_id, 2)
        assert r1.status_code == 201, r1.text
        assert r2.status_code == 422, r2.text
        assert r2.json()["error"]["code"] == "CHANNEL_POST_IMAGE_COUNT_EXCEEDED"
        assert r2.json()["error"]["image_max_count"] == 1
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()


# ─── ④ Instagram 캐러셀 컨테이너(부모+children)·sandbox 미러·원자성 ───────────


@pytest.mark.anyio
async def test_instagram_publish_client_module_declares_create_carousel_container():
    import app.services.instagram_publish as instagram_publish
    import app.services.instagram_sandbox_publish as instagram_sandbox_publish

    assert hasattr(instagram_publish, "create_carousel_container")
    assert hasattr(instagram_sandbox_publish, "create_carousel_container")


@pytest.mark.anyio
async def test_create_carousel_container_builds_parent_with_children_ids():
    from app.services.instagram_publish import create_carousel_container

    responses = iter([
        {"id": "child-1"}, {"id": "child-2"}, {"id": "child-3"}, {"id": "parent-999"},
    ])

    class _FakeResponse:
        def __init__(self, body):
            self.status_code = 200
            self._body = body
        def json(self):
            return self._body
        @property
        def text(self):
            return str(self._body)

    calls = []

    class _FakeClient:
        async def post(self, url, *, params):
            calls.append(params)
            return _FakeResponse(next(responses))

    creation_id = await create_carousel_container(
        _FakeClient(), access_token="tok", threads_user_id="ig-user-1", text="캡션",
        image_urls=["https://x/1.jpg", "https://x/2.jpg", "https://x/3.jpg"],
    )
    assert creation_id == "parent-999"
    assert len(calls) == 4
    for child_call in calls[:3]:
        assert child_call["is_carousel_item"] == "true"
    parent_call = calls[3]
    assert parent_call["media_type"] == "CAROUSEL"
    assert parent_call["children"] == "child-1,child-2,child-3"
    assert parent_call["caption"] == "캡션"


@pytest.mark.anyio
async def test_create_carousel_container_child_failure_never_creates_parent():
    """원자성(그라운딩·PO 明示) — 자식 하나 실패하면 부모 컨테이너 호출 자체가 안
    일어난다(발행 0)."""
    from app.services.instagram_publish import create_carousel_container
    from app.services.threads_publish import ThreadsPublishError

    class _FakeFailResponse:
        status_code = 502
        text = "provider down"
        def json(self):
            return {}

    class _FakeOkResponse:
        status_code = 200
        text = "{}"
        def json(self):
            return {"id": "child-1"}

    calls = []

    class _FakeClient:
        async def post(self, url, *, params):
            calls.append(params)
            if len(calls) == 2:
                return _FakeFailResponse()
            return _FakeOkResponse()

    with pytest.raises(ThreadsPublishError):
        await create_carousel_container(
            _FakeClient(), access_token="tok", threads_user_id="ig-user-1", text="",
            image_urls=["https://x/1.jpg", "https://x/2.jpg", "https://x/3.jpg"],
        )
    # 2번째 자식에서 실패 — 3번째 자식·부모(4번째 콜) 자체가 안 불렸다.
    assert len(calls) == 2
    assert all("media_type" not in c for c in calls), "부모(CAROUSEL) 콜이 일어났다(원자성 위반)"


@pytest.mark.anyio
async def test_sandbox_carousel_child_failure_marker_blocks_all_captures_atomically():
    """라이브 대역 — instagram_sandbox로 3장 캐러셀 발행 시도, 2번째 자식 실패
    마커를 심으면 published 0(원자성), 정상 마커 없는 3장은 published 1."""
    from app.services.instagram_sandbox_publish import create_carousel_container
    from app.services.threads_publish import ThreadsPublishError

    ok = await create_carousel_container(
        None, access_token="tok", threads_user_id="ig-user", text="정상 캡션",
        image_urls=["u1", "u2", "u3"],
    )
    assert ok.startswith("sandbox-ig-carousel-")

    with pytest.raises(ThreadsPublishError) as exc_info:
        await create_carousel_container(
            None, access_token="tok", threads_user_id="ig-user",
            text="캡션 [sandbox:carousel-child-2-failed]", image_urls=["u1", "u2", "u3"],
        )
    assert exc_info.value.code == "SANDBOX_INSTAGRAM_CAROUSEL_CHILD_FAILED"


@pytest.mark.anyio
async def test_publish_endpoint_dispatches_to_carousel_for_two_plus_images_instagram_sandbox():
    """종단 — instagram_sandbox 초안에 이미지 3장 → 승인 → 발행 200·external_id·
    published_at(라이브 카디르 런북 재료와 동형 축, 여기선 코드 테스트로 pin)."""
    from app.main import app

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org_id, project_id = await _seed_org(s)
            human_id = await _seed_human(s, org_id, project_id)
            connection_id = await _seed_connection(s, org_id, channel="instagram_sandbox")
            story_id = await _seed_story(s, org_id, project_id)
            from app.models.participation import ParticipationRole
            role = ParticipationRole(id=uuid.uuid4(), org_id=org_id, key="approver", label="Approver", is_default=True)
            s.add(role)
            await s.commit()
        _setup_org_scoped_app(app, Session, org_id, user_id=human_id, agent=False)

        async with _client_for(app) as client:
            draft_id = await _create_draft(client, org_id=org_id, connection_id=connection_id, story_id=story_id)
            responses = await _upload_n_images(client, org_id, draft_id, 3)
            for r in responses:
                assert r.status_code == 201, r.text
            version_id = responses[-1].json()["version_id"]

            r_submit = await client.post(
                f"/api/v2/organizations/{org_id}/channel-posts/drafts/{draft_id}/submit",
                json={"version_id": version_id},
            )
            assert r_submit.status_code == 200, r_submit.text
            gate_id = r_submit.json()["gate_id"]

        async with Session() as s:
            from app.models.gate import Gate
            from sqlalchemy import select as sa_select

            gate = (await s.execute(sa_select(Gate).where(Gate.id == uuid.UUID(gate_id)))).scalar_one()
            gate.status = "approved"
            gate.resolver_id = uuid.uuid4()
            gate.resolved_at = datetime.now(timezone.utc)
            await s.commit()

        async with _client_for(app) as client:
            # 이미지(캐러셀 포함) 발행은 항상 2틱 — 1틱=컨테이너 생성(processing=True,
            # 즉시 반환)·2틱=publish_container까지(instagram_sandbox_publish.py::
            # get_container_status가 이미 결정적으로 FINISHED라 별도 mock 불요, 그래도
            # channel_posts.py 오케스트레이션이 "이미지 있으면 1틱은 무조건 반환"이라
            # 실제로 2번 불러야 한다 — test_620beefc_channel_post_image.py::
            # test_image_publish_finished_tick_completes와 동형 계약).
            r_publish_1 = await client.post(
                f"/api/v2/organizations/{org_id}/channel-posts/drafts/{draft_id}/publish",
            )
            assert r_publish_1.status_code == 200, r_publish_1.text
            assert r_publish_1.json()["processing"] is True

            r_publish_2 = await client.post(
                f"/api/v2/organizations/{org_id}/channel-posts/drafts/{draft_id}/publish",
            )
        assert r_publish_2.status_code == 200, r_publish_2.text
        body = r_publish_2.json()
        assert body["processing"] is False
        assert body["external_id"] is not None and body["external_id"].startswith("sandbox-ig-media-")
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()


# ─── BE 2/2(디디·페드루 PO 確定 2026-09-06) — 삭제·재정렬 ─────────────────────────


@pytest.mark.anyio
async def test_delete_middle_image_renumbers_remaining_and_recomputes_seal():
    """3장 중 가운데(position 1) 삭제 → 남은 2장이 새 버전에서 [0,1]로 재부여되고
    합성 해시가 남은 순서(원래 상대 순서 유지)로 재계산돼야 한다. 옛 버전 행은
    그대로 남아 있어야 한다(삭제=새 버전, 원본 불변 원칙)."""
    from app.main import app
    from app.models.channel_post_image import ChannelPostImage
    from app.models.channel_post_version import ChannelPostVersion
    from app.services.channel_post_images import compute_image_seal_hash
    from sqlalchemy import select

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
            r1, r2, r3 = await _upload_n_images(client, org_id, draft_id, 3)
            old_version_id = r3.json()["version_id"]

            async with Session() as s:
                old_images = list((await s.execute(
                    select(ChannelPostImage).where(ChannelPostImage.version_id == uuid.UUID(old_version_id))
                    .order_by(ChannelPostImage.position)
                )).scalars().all())
            middle_image_id = str(old_images[1].id)
            kept_hashes = [old_images[0].final_sha256, old_images[2].final_sha256]

            r_delete = await client.request(
                "DELETE", f"/api/v2/organizations/{org_id}/channel-posts/drafts/{draft_id}/assets/{middle_image_id}",
            )
        assert r_delete.status_code == 200, r_delete.text
        remaining = r_delete.json()
        assert [row["position"] for row in remaining] == [0, 1]

        async with Session() as s:
            old_images_after = list((await s.execute(
                select(ChannelPostImage).where(ChannelPostImage.version_id == uuid.UUID(old_version_id))
            )).scalars().all())
            assert len(old_images_after) == 3, "옛 버전 행이 삭제 처리로 건드려지면 안 된다(불변)"

            new_version_id = remaining[0]["version_id"]
            new_version = (await s.execute(
                select(ChannelPostVersion).where(ChannelPostVersion.id == uuid.UUID(new_version_id))
            )).scalar_one()
            new_images = list((await s.execute(
                select(ChannelPostImage).where(ChannelPostImage.version_id == uuid.UUID(new_version_id))
                .order_by(ChannelPostImage.position)
            )).scalars().all())
        assert [img.final_sha256 for img in new_images] == kept_hashes
        assert new_version.image_sha256 == compute_image_seal_hash(kept_hashes)
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()


@pytest.mark.anyio
async def test_delete_only_remaining_image_sets_seal_to_none_and_empty_list():
    """1장뿐인 draft에서 그 1장을 삭제 → 새 버전은 이미지 0장·image_sha256=None(첫
    draft의 "이미지 없음" 상태와 동일 — sha256("")이 아니다)."""
    from app.main import app
    from app.models.channel_post_version import ChannelPostVersion
    from sqlalchemy import select

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
            (r1,) = await _upload_n_images(client, org_id, draft_id, 1)
            image_id = r1.json()

            async with Session() as s:
                from app.models.channel_post_image import ChannelPostImage
                row = (await s.execute(
                    select(ChannelPostImage).where(ChannelPostImage.version_id == uuid.UUID(image_id["version_id"]))
                )).scalar_one()
            r_delete = await client.request(
                "DELETE", f"/api/v2/organizations/{org_id}/channel-posts/drafts/{draft_id}/assets/{row.id}",
            )
        assert r_delete.status_code == 200, r_delete.text
        assert r_delete.json() == []

        async with Session() as s:
            new_version = (await s.execute(
                select(ChannelPostVersion).where(ChannelPostVersion.draft_id == uuid.UUID(draft_id))
                .order_by(ChannelPostVersion.version.desc()).limit(1)
            )).scalar_one()
        assert new_version.image_sha256 is None
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()


@pytest.mark.anyio
async def test_delete_unknown_image_id_returns_404():
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
            await _upload_n_images(client, org_id, draft_id, 1)

            r_delete = await client.request(
                "DELETE",
                f"/api/v2/organizations/{org_id}/channel-posts/drafts/{draft_id}/assets/{uuid.uuid4()}",
            )
        assert r_delete.status_code == 404, r_delete.text
        assert r_delete.json()["error"]["code"] == "CHANNEL_POST_IMAGE_NOT_FOUND"
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()


@pytest.mark.anyio
async def test_reorder_two_images_swaps_positions_and_recomputes_seal():
    from app.main import app
    from app.models.channel_post_version import ChannelPostVersion
    from app.services.channel_post_images import compute_image_seal_hash
    from sqlalchemy import select

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
            r1, r2 = await _upload_n_images(client, org_id, draft_id, 2)

            async with Session() as s:
                from app.models.channel_post_image import ChannelPostImage
                images = list((await s.execute(
                    select(ChannelPostImage).where(ChannelPostImage.version_id == uuid.UUID(r2.json()["version_id"]))
                    .order_by(ChannelPostImage.position)
                )).scalars().all())
            first_id, second_id = str(images[0].id), str(images[1].id)
            reversed_hashes = [images[1].final_sha256, images[0].final_sha256]

            r_reorder = await client.post(
                f"/api/v2/organizations/{org_id}/channel-posts/drafts/{draft_id}/assets/reorder",
                json={"image_ids": [second_id, first_id]},
            )
        assert r_reorder.status_code == 200, r_reorder.text
        reordered = r_reorder.json()
        assert [row["position"] for row in reordered] == [0, 1]

        async with Session() as s:
            new_version = (await s.execute(
                select(ChannelPostVersion).where(ChannelPostVersion.id == uuid.UUID(reordered[0]["version_id"]))
            )).scalar_one()
        assert new_version.image_sha256 == compute_image_seal_hash(reversed_hashes)
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()


@pytest.mark.anyio
async def test_reorder_with_missing_or_duplicate_id_rejected_422():
    from app.main import app
    from sqlalchemy import select

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
            r1, r2 = await _upload_n_images(client, org_id, draft_id, 2)

            async with Session() as s:
                from app.models.channel_post_image import ChannelPostImage
                images = list((await s.execute(
                    select(ChannelPostImage).where(ChannelPostImage.version_id == uuid.UUID(r2.json()["version_id"]))
                    .order_by(ChannelPostImage.position)
                )).scalars().all())
            first_id, second_id = str(images[0].id), str(images[1].id)

            r_missing = await client.post(
                f"/api/v2/organizations/{org_id}/channel-posts/drafts/{draft_id}/assets/reorder",
                json={"image_ids": [first_id]},
            )
            r_duplicate = await client.post(
                f"/api/v2/organizations/{org_id}/channel-posts/drafts/{draft_id}/assets/reorder",
                json={"image_ids": [first_id, first_id]},
            )
        for r in (r_missing, r_duplicate):
            assert r.status_code == 422, r.text
            assert r.json()["error"]["code"] == "CHANNEL_POST_IMAGE_REORDER_INVALID_SET"
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()


@pytest.mark.anyio
async def test_list_images_for_version_endpoint_returns_ordered_positions():
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
            r1, r2, r3 = await _upload_n_images(client, org_id, draft_id, 3)
            version_id = r3.json()["version_id"]

            r_list = await client.get(
                f"/api/v2/organizations/{org_id}/channel-posts/drafts/{draft_id}/versions/{version_id}/assets",
            )
        assert r_list.status_code == 200, r_list.text
        rows = r_list.json()
        assert [row["position"] for row in rows] == [0, 1, 2]
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()
