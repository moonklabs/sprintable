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
    (_promote_connection_status의 `not in ("revoked", "error")` 가드는 이 PR이
    안 건드린다, 여기서 회귀 0을 고정)."""
    from app.services.channel_post_comments import _promote_connection_status

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org_id, _ = await _seed_org(s)
            conn = await _seed_channel_connection(s, org_id, channel="facebook", status="revoked")
            pub = await _seed_channel_publication(s, org_id=org_id, connection_id=conn.id, channel="facebook", external_id="media-1")
            await s.commit()

            await _promote_connection_status(s, publication_id=pub.id)
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
