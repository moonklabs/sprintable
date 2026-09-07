"""story #3597(Phase2·BE·소형·결함, 페드루 PO 確定 2026-09-06, 3595 실측 근거) —
`channel_post_comments.py::_promote_connection_status`가 `if channel != "threads":
return`로 잘려 있어 IG/FB 댓글 수집 CONNECTION 실패는 에러코드까지 정확히 분류
되고도 connection.status 승격이 안 됐다(/organization/channels 칩·재연결 버튼에
안 섬). 가드를 channel 이름이 아니라 connection 유무로 바꾼 뒤(insight_snapshots.py
::_promote_connection_status_for_snapshot과 동형) 재확認한다.

세팅 헬퍼는 test_3497_insight_snapshots.py·test_3516_channel_post_comments.py와
동형(중복 재발명 금지)."""
from __future__ import annotations

import os
import uuid
from datetime import datetime, timedelta, timezone

import pytest

from tests.test_e4fc29fa_site_post_orchestration import _seed_org, _session_factory
from tests.test_3497_insight_snapshots import _seed_channel_connection, _seed_channel_publication

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
    """test_3516_comment_reply.py와 동형 — channel_connection 암호화 키가 없으면
    _seed_channel_connection의 encrypt_channel_credential이 죽는다."""
    import importlib
    from cryptography.fernet import Fernet

    import app.core.config as config_module
    monkeypatch.setattr(config_module.settings, "channel_credential_encryption_key", Fernet.generate_key().decode())

    import app.services.channel_credential_crypto as crypto_module
    importlib.reload(crypto_module)
    yield
    importlib.reload(crypto_module)


@pytest.fixture(autouse=True)
def _enable_sandbox_adapter(monkeypatch):
    """test_3516_comment_reply.py와 동형 — sandbox는 CHANNEL_ADAPTERS 본 registry에
    없어(_PUBLISH_CLIENT_MODULE_PATHS 전용 채널) supports_fetch_replies=True로
    임시 등재해야 collect_comments_for_publication이 unsupported로 조기 종료하지
    않는다."""
    import app.services.channel_adapters as adapters_mod

    sandbox_config = adapters_mod.ChannelAdapterConfig(
        authorize_url="", token_url="", scope="sandbox_publish", refresh_mode="manual",
        display_name="Sandbox", credential_kind="none", max_text_length=500,
        utm_source="sandbox", utm_medium="test",
        image_formats=("image/jpeg", "image/png"), image_max_bytes=8 * 1024 * 1024,
        image_aspect_max=10.0, image_width_min=320, image_width_max=1440,
        image_color_space="sRGB", image_max_count=1,
        supports_fetch_replies=True,
    )
    monkeypatch.setitem(adapters_mod.CHANNEL_ADAPTERS, "sandbox", sandbox_config)
    yield


@pytest.fixture(autouse=True)
def _enable_instagram_sandbox_adapter(monkeypatch):
    """instagram_sandbox는 sandbox와 동형 사정 — CHANNEL_ADAPTERS 본 registry에
    없다(_PUBLISH_CLIENT_MODULE_PATHS 전용). facebook_sandbox는 이미 본 registry에
    있어(channel_adapters.py:316) 이 fixture가 불필요."""
    import app.services.channel_adapters as adapters_mod

    ig_sandbox_config = adapters_mod.ChannelAdapterConfig(
        authorize_url="", token_url="", scope="instagram_sandbox_publish", refresh_mode="manual",
        display_name="Instagram Sandbox", credential_kind="none", max_text_length=2200,
        utm_source="instagram_sandbox", utm_medium="test",
        image_formats=("image/jpeg", "image/png"), image_max_bytes=8 * 1024 * 1024,
        image_aspect_max=1.91, image_width_min=320, image_width_max=1440,
        image_color_space="sRGB", image_max_count=10,
        supports_fetch_replies=True,
    )
    monkeypatch.setitem(adapters_mod.CHANNEL_ADAPTERS, "instagram_sandbox", ig_sandbox_config)
    yield


@pytest.mark.anyio
async def test_instagram_connection_failure_promotes_status_expired(monkeypatch):
    """AC1·AC2 — instagram CONNECTION 실패가 이제 connection.status를 expired로
    승격한다(이전엔 threads 전용 가드에 막혀 no-op이었다)."""
    from app.services.channel_post_comments import process_due_comment_collections, schedule_comment_collection
    from app.services.threads_publish import ThreadsPublishError
    import app.services.instagram_publish as instagram_publish

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org_id, _ = await _seed_org(s)
            conn = await _seed_channel_connection(s, org_id, channel="instagram")
            pub = await _seed_channel_publication(s, org_id=org_id, connection_id=conn.id, channel="instagram", external_id="media-1")

            anchor = datetime.now(timezone.utc) - timedelta(hours=2)
            await schedule_comment_collection(
                s, org_id=org_id, publication_id=pub.id, channel="instagram", external_id="media-1", anchor_at=anchor,
            )
            await s.commit()

            async def _raise_expired(client, *, access_token, media_id):
                raise ThreadsPublishError("TOKEN_EXPIRED", "sandbox: 401 시뮬레이션", status_code=401)

            monkeypatch.setattr(instagram_publish, "fetch_replies", _raise_expired)
            counts = await process_due_comment_collections(s)
            assert counts["failed"] == 1

            await s.refresh(conn)
            assert conn.status == "expired"
    finally:
        await engine.dispose()


@pytest.mark.anyio
async def test_facebook_connection_failure_promotes_status_expired(monkeypatch):
    """AC1·AC2 — facebook도 동형(3595 표가 지목한 두 번째 채널)."""
    from app.services.channel_post_comments import process_due_comment_collections, schedule_comment_collection
    from app.services.threads_publish import ThreadsPublishError
    import app.services.facebook_publish as facebook_publish

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org_id, _ = await _seed_org(s)
            conn = await _seed_channel_connection(s, org_id, channel="facebook")
            pub = await _seed_channel_publication(s, org_id=org_id, connection_id=conn.id, channel="facebook", external_id="media-1")

            anchor = datetime.now(timezone.utc) - timedelta(hours=2)
            await schedule_comment_collection(
                s, org_id=org_id, publication_id=pub.id, channel="facebook", external_id="media-1", anchor_at=anchor,
            )
            await s.commit()

            async def _raise_expired(client, *, access_token, media_id):
                raise ThreadsPublishError("TOKEN_EXPIRED", "sandbox: 401 시뮬레이션", status_code=401)

            monkeypatch.setattr(facebook_publish, "fetch_replies", _raise_expired)
            counts = await process_due_comment_collections(s)
            assert counts["failed"] == 1

            await s.refresh(conn)
            assert conn.status == "expired"
    finally:
        await engine.dispose()


@pytest.mark.anyio
async def test_facebook_connection_failure_does_not_downgrade_revoked_or_error():
    """기존 규율 불변 — 이미 revoked·error인 연결은 expired로 덮어쓰지 않는다
    (story #3605 — `_promote_connection_status`에 `error_code` 인자가 추가되며
    이 가드가 graph_api_errors.connection_status_for_error_code로 옮겨갔다.
    여기선 "다른 코드가 expired로 매핑돼도 이미 revoked면 안 바뀐다"는 sticky
    규율이 여전히 지켜지는지 고정 — 이 스토리 리팩터 中 한 번 실제로 좁혀져서
    회귀했던 자리, 이 테스트가 그 회귀를 실측으로 잡았다)."""
    from app.services.channel_post_comments import _promote_connection_status

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org_id, _ = await _seed_org(s)
            conn = await _seed_channel_connection(s, org_id, channel="facebook", status="revoked")
            pub = await _seed_channel_publication(s, org_id=org_id, connection_id=conn.id, channel="facebook", external_id="media-1")
            await s.commit()

            await _promote_connection_status(s, publication_id=pub.id, error_code="CHANNEL_TOKEN_EXPIRED")
            await s.commit()
            await s.refresh(conn)
            assert conn.status == "revoked"
    finally:
        await engine.dispose()


@pytest.mark.anyio
async def test_sandbox_connection_untouched_by_promote(monkeypatch):
    """sandbox 채널 — connection이 있어도(테스트 시딩 관례) 실제로 CONNECTION류
    실패를 만들 방법이 없으니 무변(AC1의 "connection 유무" 가드가 sandbox를 특별
    취급하지 않아도 실질 결과는 그대로임을 고정)."""
    from app.services.channel_post_comments import process_due_comment_collections, schedule_comment_collection

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org_id, _ = await _seed_org(s)
            conn = await _seed_channel_connection(s, org_id, channel="sandbox")
            pub = await _seed_channel_publication(s, org_id=org_id, connection_id=conn.id, channel="sandbox", external_id="media-1")

            anchor = datetime.now(timezone.utc) - timedelta(hours=2)
            await schedule_comment_collection(
                s, org_id=org_id, publication_id=pub.id, channel="sandbox", external_id="media-1", anchor_at=anchor,
            )
            await s.commit()

            counts = await process_due_comment_collections(s)
            assert counts["captured"] == 1
            assert counts["failed"] == 0

            await s.refresh(conn)
            assert conn.status == "active"
    finally:
        await engine.dispose()


# ─── story #3597(페드루 PO 追加 2026-09-06) — 「발행 뒤 만료」 라이브 마커 ────────
# [sandbox:expire-after-publish]: create_container/publish_container를 실제로
# 거쳐(발행은 성공) media_id에 표식을 남기고, fetch_replies가 그 media_id를 보면
# 401을 던진다 — AC3 라이브 검증(PO Test Org)이 실제로 재현하는 정확한 경로를
# 여기서 코드로도 고정한다(create_container→publish_container→fetch_replies
# 전부 실동작, monkeypatch 0).


@pytest.mark.anyio
async def test_instagram_sandbox_expire_after_publish_marker_promotes_status_expired():
    from app.services.channel_post_comments import process_due_comment_collections, schedule_comment_collection
    import app.services.instagram_sandbox_publish as ig_sandbox

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org_id, _ = await _seed_org(s)
            conn = await _seed_channel_connection(s, org_id, channel="instagram_sandbox")

            creation_id = await ig_sandbox.create_container(
                None, access_token="x", threads_user_id="u", text="[sandbox:expire-after-publish]",
                image_url="https://example.com/i.jpg",
            )
            media_id = await ig_sandbox.publish_container(None, access_token="x", threads_user_id="u", creation_id=creation_id)
            assert media_id.endswith("-expireafterpublish")

            pub = await _seed_channel_publication(
                s, org_id=org_id, connection_id=conn.id, channel="instagram_sandbox", external_id=media_id,
            )
            anchor = datetime.now(timezone.utc) - timedelta(hours=2)
            await schedule_comment_collection(
                s, org_id=org_id, publication_id=pub.id, channel="instagram_sandbox", external_id=media_id, anchor_at=anchor,
            )
            await s.commit()

            counts = await process_due_comment_collections(s)
            assert counts["failed"] == 1

            await s.refresh(conn)
            assert conn.status == "expired"
    finally:
        await engine.dispose()


# ─── story #3597(잔여, PO 라이브 회차 2026-09-07 02:27~02:33Z 실측·PO 確定) ────────
# 스케줄 루프(process_due_comment_collections)는 위 테스트들처럼 CONNECTION 실패
# 시 승격을 부르는데, 휴먼 수동 「다시 수집」(refresh_comments_now)은 그 호출
# 자체가 없었다 — 라이브 실측: FB 샌드박스 502 CHANNEL_TOKEN_EXPIRED 뒤에도
# connection.status가 active 그대로(/organization/channels 칩 「연결됨」).


@pytest.mark.anyio
async def test_manual_refresh_connection_failure_promotes_status_expired(monkeypatch):
    """AC1(수동 경로) — 「다시 수집」 버튼이 부르는 refresh_comments_now도 CONNECTION
    실패면 connection.status를 expired로 승격해야 칩이 선다."""
    from app.services.channel_post_comments import CommentFetchError, refresh_comments_now
    from app.services.threads_publish import ThreadsPublishError
    import app.services.instagram_publish as instagram_publish

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org_id, _ = await _seed_org(s)
            conn = await _seed_channel_connection(s, org_id, channel="instagram")
            pub = await _seed_channel_publication(s, org_id=org_id, connection_id=conn.id, channel="instagram", external_id="media-1")
            await s.commit()

            async def _raise_expired(client, *, access_token, media_id):
                raise ThreadsPublishError("TOKEN_EXPIRED", "sandbox: 401 시뮬레이션", status_code=401)

            monkeypatch.setattr(instagram_publish, "fetch_replies", _raise_expired)
            with pytest.raises(CommentFetchError):
                await refresh_comments_now(s, org_id=org_id, publication_id=pub.id)

            await s.refresh(conn)
            assert conn.status == "expired"
    finally:
        await engine.dispose()


@pytest.mark.anyio
async def test_manual_refresh_transient_failure_does_not_touch_connection(monkeypatch):
    """루프와 동형 불변 — TRANSIENT(CHANNEL_RATE_LIMITED)는 사람이 고칠 대상이
    아니라 connection을 건드리지 않는다(재시도가 유효할 수 있는 실패류를
    「재연결 필요」로 잘못 몰지 않는다)."""
    from app.services.channel_post_comments import CommentFetchError, refresh_comments_now
    from app.services.threads_publish import ThreadsPublishError
    import app.services.instagram_publish as instagram_publish

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org_id, _ = await _seed_org(s)
            conn = await _seed_channel_connection(s, org_id, channel="instagram")
            pub = await _seed_channel_publication(s, org_id=org_id, connection_id=conn.id, channel="instagram", external_id="media-1")
            await s.commit()

            async def _raise_rate_limited(client, *, access_token, media_id):
                raise ThreadsPublishError("RATE_LIMITED", "sandbox: 429 시뮬레이션", status_code=429)

            monkeypatch.setattr(instagram_publish, "fetch_replies", _raise_rate_limited)
            with pytest.raises(CommentFetchError):
                await refresh_comments_now(s, org_id=org_id, publication_id=pub.id)

            await s.refresh(conn)
            assert conn.status == "active"
    finally:
        await engine.dispose()


@pytest.mark.anyio
async def test_facebook_sandbox_expire_after_publish_marker_promotes_status_expired():
    from app.services.channel_post_comments import process_due_comment_collections, schedule_comment_collection
    import app.services.facebook_sandbox_publish as fb_sandbox

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org_id, _ = await _seed_org(s)
            conn = await _seed_channel_connection(s, org_id, channel="facebook_sandbox")

            creation_id = await fb_sandbox.create_container(
                None, access_token="x", threads_user_id="u", text="[sandbox:expire-after-publish]",
            )
            media_id = await fb_sandbox.publish_container(None, access_token="x", threads_user_id="u", creation_id=creation_id)
            assert media_id.endswith("-expireafterpublish")

            pub = await _seed_channel_publication(
                s, org_id=org_id, connection_id=conn.id, channel="facebook_sandbox", external_id=media_id,
            )
            anchor = datetime.now(timezone.utc) - timedelta(hours=2)
            await schedule_comment_collection(
                s, org_id=org_id, publication_id=pub.id, channel="facebook_sandbox", external_id=media_id, anchor_at=anchor,
            )
            await s.commit()

            counts = await process_due_comment_collections(s)
            assert counts["failed"] == 1

            await s.refresh(conn)
            assert conn.status == "expired"
    finally:
        await engine.dispose()


# ─── story #3640(BE·샌드박스 리그·소형, 페드루 PO 確定 2026-09-07) — expire-after-
# publish 마커의 「영구 지뢰」화 방지: 발행 뒤 첫 수집 1회만 401(위 두 테스트가
# 고정하는 양성대조), 그 뒤(사람이 「다시 연결」한 뒤 등)는 정상 200·연결 active
# 유지. dev PO Test Org Sandbox Page 1(641adabf)이 표본이 살아있는 한 영원히
# 못 쓰던 실사고를 여기서 코드로 고정한다.


async def _seed_second_tick(s, *, org_id, publication_id, channel, external_id, due_at):
    """schedule_comment_collection은 (publication_id, due_at) UNIQUE라 첫 seed와
    같은 anchor를 재사용하면 충돌한다 — 두 번째 수집 틱은 별도 due_at로 직접
    삽입(헬퍼 재사용 없이 새 세팅 로직 발명 0, 컬럼은 schedule_comment_collection과
    동형)."""
    from app.models.channel_post_comment import CommentCollectionSchedule

    s.add(CommentCollectionSchedule(
        id=uuid.uuid4(), org_id=org_id, publication_id=publication_id, channel=channel,
        external_id=external_id, due_at=due_at, status="pending",
    ))


@pytest.mark.anyio
async def test_instagram_sandbox_expire_after_publish_marker_second_collection_succeeds_and_stays_active():
    """AC1 — 첫 수집(위 test_instagram_sandbox_expire_after_publish_marker_
    promotes_status_expired와 동일 경로)은 401·expired 그대로, 두 번째 수집은
    200·connection active 유지(사람이 「다시 연결」한 것과 동형 — 재연결 후 다음
    틱이 또 만료시키던 실사고가 여기서 재현되면 이 테스트가 RED)."""
    from app.services.channel_post_comments import process_due_comment_collections, schedule_comment_collection
    import app.services.instagram_sandbox_publish as ig_sandbox

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org_id, _ = await _seed_org(s)
            conn = await _seed_channel_connection(s, org_id, channel="instagram_sandbox")

            creation_id = await ig_sandbox.create_container(
                None, access_token="x", threads_user_id="u", text="[sandbox:expire-after-publish]",
                image_url="https://example.com/i.jpg",
            )
            media_id = await ig_sandbox.publish_container(None, access_token="x", threads_user_id="u", creation_id=creation_id)

            pub = await _seed_channel_publication(
                s, org_id=org_id, connection_id=conn.id, channel="instagram_sandbox", external_id=media_id,
            )
            anchor = datetime.now(timezone.utc) - timedelta(hours=2)
            await schedule_comment_collection(
                s, org_id=org_id, publication_id=pub.id, channel="instagram_sandbox", external_id=media_id, anchor_at=anchor,
            )
            await s.commit()

            counts = await process_due_comment_collections(s)
            assert counts["failed"] == 1
            await s.refresh(conn)
            assert conn.status == "expired"

            # 사람이 「다시 연결」(3613 AC3와 동형 — 여기선 status만 되돌린다, 그
            # 다시연결 플로우 자체는 이 스토리 스코프 밖).
            conn.status = "active"
            await _seed_second_tick(
                s, org_id=org_id, publication_id=pub.id, channel="instagram_sandbox", external_id=media_id,
                due_at=datetime.now(timezone.utc) - timedelta(minutes=1),
            )
            await s.commit()

            counts2 = await process_due_comment_collections(s)
            assert counts2["failed"] == 0, f"두 번째 수집도 실패로 잡히면 안 된다: {counts2}"
            assert counts2["captured"] == 1

            await s.refresh(conn)
            assert conn.status == "active", "두 번째 수집이 다시 연결을 expired로 되돌리면 안 된다(영구 지뢰 재발)"

            await s.refresh(pub)
            assert pub.sandbox_expired_once is True
    finally:
        await engine.dispose()


@pytest.mark.anyio
async def test_facebook_sandbox_expire_after_publish_marker_second_collection_succeeds_and_stays_active():
    """AC1(facebook_sandbox 짝) — ig와 동형."""
    from app.services.channel_post_comments import process_due_comment_collections, schedule_comment_collection
    import app.services.facebook_sandbox_publish as fb_sandbox

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org_id, _ = await _seed_org(s)
            conn = await _seed_channel_connection(s, org_id, channel="facebook_sandbox")

            creation_id = await fb_sandbox.create_container(
                None, access_token="x", threads_user_id="u", text="[sandbox:expire-after-publish]",
            )
            media_id = await fb_sandbox.publish_container(None, access_token="x", threads_user_id="u", creation_id=creation_id)

            pub = await _seed_channel_publication(
                s, org_id=org_id, connection_id=conn.id, channel="facebook_sandbox", external_id=media_id,
            )
            anchor = datetime.now(timezone.utc) - timedelta(hours=2)
            await schedule_comment_collection(
                s, org_id=org_id, publication_id=pub.id, channel="facebook_sandbox", external_id=media_id, anchor_at=anchor,
            )
            await s.commit()

            counts = await process_due_comment_collections(s)
            assert counts["failed"] == 1
            await s.refresh(conn)
            assert conn.status == "expired"

            conn.status = "active"
            await _seed_second_tick(
                s, org_id=org_id, publication_id=pub.id, channel="facebook_sandbox", external_id=media_id,
                due_at=datetime.now(timezone.utc) - timedelta(minutes=1),
            )
            await s.commit()

            counts2 = await process_due_comment_collections(s)
            assert counts2["failed"] == 0, f"두 번째 수집도 실패로 잡히면 안 된다: {counts2}"
            assert counts2["captured"] == 1

            await s.refresh(conn)
            assert conn.status == "active"

            await s.refresh(pub)
            assert pub.sandbox_expired_once is True
    finally:
        await engine.dispose()


@pytest.mark.anyio
async def test_instagram_sandbox_expire_marker_without_one_shot_flag_still_401s_mutation():
    """뮤테이션(AC1) — sandbox_expired_once가 아직 False인 채로(=1회성 로직이
    없었다면) 두 번째 수집을 돌리면 여전히 401·failed다. 위 성공 테스트가 실제로
    이 결함을 잡는다는 증거(회귀 가드 자체를 검증) — pub.sandbox_expired_once를
    다시 False로 되돌려 「관측 기록이 없었다」를 재현."""
    from app.services.channel_post_comments import process_due_comment_collections, schedule_comment_collection
    import app.services.instagram_sandbox_publish as ig_sandbox

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org_id, _ = await _seed_org(s)
            conn = await _seed_channel_connection(s, org_id, channel="instagram_sandbox")

            creation_id = await ig_sandbox.create_container(
                None, access_token="x", threads_user_id="u", text="[sandbox:expire-after-publish]",
                image_url="https://example.com/i.jpg",
            )
            media_id = await ig_sandbox.publish_container(None, access_token="x", threads_user_id="u", creation_id=creation_id)

            pub = await _seed_channel_publication(
                s, org_id=org_id, connection_id=conn.id, channel="instagram_sandbox", external_id=media_id,
            )
            anchor = datetime.now(timezone.utc) - timedelta(hours=2)
            await schedule_comment_collection(
                s, org_id=org_id, publication_id=pub.id, channel="instagram_sandbox", external_id=media_id, anchor_at=anchor,
            )
            await s.commit()

            await process_due_comment_collections(s)
            await s.refresh(pub)
            assert pub.sandbox_expired_once is True

            # 뮤테이션 — 관측 기록을 되돌려 "1회성 로직이 없었다"를 재현.
            pub.sandbox_expired_once = False
            conn.status = "active"
            await _seed_second_tick(
                s, org_id=org_id, publication_id=pub.id, channel="instagram_sandbox", external_id=media_id,
                due_at=datetime.now(timezone.utc) - timedelta(minutes=1),
            )
            await s.commit()

            counts2 = await process_due_comment_collections(s)
            assert counts2["failed"] == 1, "sandbox_expired_once 없이는 두 번째도 401(영구 지뢰) — 뮤테이션 RED 확認"
    finally:
        await engine.dispose()
