"""story #3603(Phase2·BE·소형·결함, 페드루 PO 確定 2026-09-07, 유나 3597 관찰) —
`_promote_connection_status`(댓글)·`_promote_connection_status_for_snapshot`
(인사이트)가 `status`만 바꾸고 `last_error`/`last_error_code`/`last_error_at`는
안 건드려 /organization/channels 행의 「서버 응답 보기」가 비거나 옛 오류를
보였다. CONNECTION 실패로 실제 expired 승격되는 분기에서만 이 3종을 채우고,
no-op(이미 revoked/error·sandbox) 분기는 전부 불변임을 고정한다.

세팅 헬퍼는 test_3597_ig_fb_connection_status_promote.py·test_3497_insight_
snapshots.py와 동형(중복 재발명 금지)."""
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
    """test_3597_ig_fb_connection_status_promote.py와 동형 — channel_connection 암호화
    키가 없으면 _seed_channel_connection의 encrypt_channel_credential이 죽는다."""
    import importlib
    from cryptography.fernet import Fernet

    import app.core.config as config_module
    monkeypatch.setattr(config_module.settings, "channel_credential_encryption_key", Fernet.generate_key().decode())

    import app.services.channel_credential_crypto as crypto_module
    importlib.reload(crypto_module)
    yield
    importlib.reload(crypto_module)


@pytest.mark.anyio
async def test_comment_collection_connection_failure_fills_last_error_trio(monkeypatch):
    """AC1·AC2(댓글 경로) — FB CONNECTION 실패가 last_error(원문)·last_error_code·
    last_error_at을 전부 채운다."""
    from app.models.channel_connection import ChannelConnection
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

            before = datetime.now(timezone.utc)

            async def _raise_expired(client, *, access_token, media_id):
                raise ThreadsPublishError("TOKEN_EXPIRED", "sandbox: 401 시뮬레이션", status_code=401)

            monkeypatch.setattr(facebook_publish, "fetch_replies", _raise_expired)
            counts = await process_due_comment_collections(s)
            assert counts["failed"] == 1

            refreshed = await s.get(ChannelConnection, conn.id)
            assert refreshed.status == "expired"
            assert refreshed.last_error is not None and "401" in refreshed.last_error
            print("DEBUG last_error=", refreshed.last_error); assert refreshed.last_error_code == "CHANNEL_TOKEN_EXPIRED"
            assert refreshed.last_error_at is not None
            assert refreshed.last_error_at >= before, "last_error_at이 이 실패 시점보다 과거일 수 없다"
    finally:
        await engine.dispose()


@pytest.mark.anyio
async def test_manual_refresh_connection_failure_fills_last_error_trio(monkeypatch):
    """story #3603(잔여, 페드루 PO 追加 2026-09-07) — 수동 「다시 수집」(refresh_comments_now,
    #3597 잔여가 승격 자체는 이미 고침)도 last_error 3종을 채워야 한다. 승격 호출에
    error_code/message를 안 실으면 이 경로만 last_error_code가 비어(3597과 같은
    클래스) AC1이 스케줄 루프에서만 참이 된다."""
    from app.models.channel_connection import ChannelConnection
    from app.services.channel_post_comments import CommentFetchError, refresh_comments_now
    from app.services.threads_publish import ThreadsPublishError
    import app.services.facebook_publish as facebook_publish

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org_id, _ = await _seed_org(s)
            conn = await _seed_channel_connection(s, org_id, channel="facebook")
            pub = await _seed_channel_publication(s, org_id=org_id, connection_id=conn.id, channel="facebook", external_id="media-1")
            await s.commit()

            before = datetime.now(timezone.utc)

            async def _raise_expired(client, *, access_token, media_id):
                raise ThreadsPublishError("TOKEN_EXPIRED", "sandbox: 401 시뮬레이션", status_code=401)

            monkeypatch.setattr(facebook_publish, "fetch_replies", _raise_expired)
            with pytest.raises(CommentFetchError):
                await refresh_comments_now(s, org_id=org_id, publication_id=pub.id)

            refreshed = await s.get(ChannelConnection, conn.id)
            assert refreshed.status == "expired"
            assert refreshed.last_error is not None and "401" in refreshed.last_error
            assert refreshed.last_error_code == "CHANNEL_TOKEN_EXPIRED"
            assert refreshed.last_error_at is not None
            assert refreshed.last_error_at >= before
    finally:
        await engine.dispose()


@pytest.mark.anyio
async def test_insight_snapshot_connection_failure_fills_last_error_trio(monkeypatch):
    """AC1·AC2(인사이트 경로) — IG CONNECTION 실패도 동형."""
    import httpx

    from app.models.channel_connection import ChannelConnection
    from app.services.insight_snapshots import process_due_insight_snapshots, schedule_insight_snapshots
    from tests.test_3497_insight_snapshots import _patch_threads_transport

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org_id, _ = await _seed_org(s)
            conn = await _seed_channel_connection(s, org_id, channel="instagram")
            pub = await _seed_channel_publication(s, org_id=org_id, connection_id=conn.id, channel="instagram")
            work_item_id = uuid.uuid4()

            # story #3603 그라운딩 — insight_snapshots._SNAPSHOT_OFFSETS=(+1d,+7d)뿐
            # (댓글 쪽 +1h·+1d·+7d와 다름, 실측). anchor_at을 8일 전처럼 두 창이 다
            # 지나게 주면(test_3497::test_threads_401_...와 동형) due 행이 2개 한
            # 번에 처리돼, 첫 행이 승격→expired한 뒤 두 번째 행이 이미 expired인
            # connection을 다시 봐 CHANNEL_CONNECTION_NOT_ACTIVE라는 별개(그러나
            # 여전히 CONNECTION류) 실패로 last_error를 덮어쓴다 — 이 테스트가 원하는
            # 건 "그 실패의 code"이지 "마지막에 처리된 행의 code"가 아니므로 +1d
            # 창 하나만 지나고 +7d는 아직인 시점으로 anchor를 잡는다.
            await schedule_insight_snapshots(
                s, org_id=org_id, work_item_id=work_item_id, publication_id=pub.id,
                publication_kind="channel_publication", channel="instagram", external_id=pub.external_id,
                anchor_at=datetime.now(timezone.utc) - timedelta(days=1, hours=1),
            )
            await s.commit()

            before = datetime.now(timezone.utc)
            _patch_threads_transport(
                monkeypatch, lambda request: httpx.Response(401, json={"error": {"message": "expired"}}),
            )
            counts = await process_due_insight_snapshots(s)
            assert counts["failed"] == 1, counts

            refreshed = await s.get(ChannelConnection, conn.id)
            assert refreshed.status == "expired"
            assert refreshed.last_error is not None
            assert refreshed.last_error_code == "CHANNEL_TOKEN_EXPIRED"
            assert refreshed.last_error_at is not None
            assert refreshed.last_error_at >= before
    finally:
        await engine.dispose()


@pytest.mark.anyio
async def test_promote_no_op_keeps_status_but_still_updates_last_error_trio():
    """story #3605 CHANGES-2(유나 §13-9 ④-2, 페드루 PO 채택 2026-09-07)로 이
    테스트의 기대값이 갱신됐다 — status는 sticky(이미 revoked면 절대 안 바뀜)지만
    last_error 3종은 sticky 여부와 무관하게 항상 갱신된다. 근거(PO 원문): status=
    "active"로 되돌리는 대입 셋(재연결 upsert·자격 교체·apply_refresh_result)이
    전부 last_error=None까지 같이 지우므로, 얼음은 한 실패 국면 안에서만 서고
    「지금도 실패하나」는 last_error{code,message,at}가 진다 — status가 얼어
    있는 동안에도 last_error가 최신 실패를 계속 반영해야 그 역할을 할 수 있다.
    (원래 이 테스트는 이 트리오도 no-op으로 불변이길 기대했다 — #3605가 그
    가정 자체를 교정한다.)"""
    from app.models.channel_connection import ChannelConnection
    from app.services.channel_post_comments import _promote_connection_status

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org_id, _ = await _seed_org(s)
            conn = await _seed_channel_connection(s, org_id, channel="facebook", status="revoked")
            pub = await _seed_channel_publication(s, org_id=org_id, connection_id=conn.id, channel="facebook", external_id="media-1")
            await s.commit()

            await _promote_connection_status(
                s, publication_id=pub.id, error_code="CHANNEL_TOKEN_EXPIRED", message="지금도 계속 실패 中",
            )
            await s.commit()
            refreshed = await s.get(ChannelConnection, conn.id)
            assert refreshed.status == "revoked"
            assert refreshed.last_error == "지금도 계속 실패 中"
            assert refreshed.last_error_code == "CHANNEL_TOKEN_EXPIRED"
            assert refreshed.last_error_at is not None
    finally:
        await engine.dispose()


# ─── story #3633 — non-active→active 복귀 3경로가 last_error 3종을 전부 지운다 ───
# dev 실측(2026-09-07 08:26Z): Sandbox Page 1 재연결 뒤 status=active인데
# last_error_code=CHANNEL_CONNECTION_NOT_ACTIVE가 그대로 남아 있었다(재연결 경로가
# last_error 문장만 비우고 code/at은 안 비움) — mark_connection_recovered(graph_
# api_errors.py, 3605 sticky_connection_status와 같은 모듈)로 세 경로 통일.


async def _seed_expired_connection_with_error_trio(session, org_id, *, channel="threads"):
    conn = await _seed_channel_connection(session, org_id, channel=channel, status="expired")
    conn.last_error = "old failure"
    conn.last_error_code = "CHANNEL_CONNECTION_NOT_ACTIVE"
    conn.last_error_at = datetime.now(timezone.utc) - timedelta(hours=1)
    await session.commit()
    return conn


@pytest.mark.anyio
async def test_reconnect_upsert_clears_last_error_trio():
    """재연결(upsert_channel_connection의 기존 행 upsert 분기)."""
    from app.models.channel_connection import ChannelConnection
    from app.services.channel_connection import upsert_channel_connection

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org_id, _ = await _seed_org(s)
            conn = await _seed_expired_connection_with_error_trio(s, org_id, channel="threads")

            row = await upsert_channel_connection(
                s, org_id=org_id, channel="threads", account_id=conn.account_id, account_label=None,
                credential_kind="oauth", access_token="new-token", refresh_token=None,
                token_expires_at=None, refresh_mode="reissue_from_access_token", scopes=[],
                connected_by=uuid.uuid4(),
            )
            assert row.id == conn.id
            assert row.status == "active"
            assert row.last_error is None
            assert row.last_error_code is None
            assert row.last_error_at is None
    finally:
        await engine.dispose()


@pytest.mark.anyio
async def test_replace_credential_clears_last_error_trio():
    """자격 교체(replace_channel_connection_credential)."""
    from app.services.channel_connection import replace_channel_connection_credential

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org_id, _ = await _seed_org(s)
            conn = await _seed_expired_connection_with_error_trio(s, org_id, channel="wordpress")

            row = await replace_channel_connection_credential(
                s, org_id=org_id, connection_id=conn.id, new_secret="new-secret-value", updated_by=uuid.uuid4(),
            )
            assert row.status == "active"
            assert row.last_error is None
            assert row.last_error_code is None
            assert row.last_error_at is None
    finally:
        await engine.dispose()


@pytest.mark.anyio
async def test_apply_refresh_result_clears_last_error_trio():
    """자동 토큰 갱신 성공(apply_refresh_result)."""
    from app.models.channel_connection import ChannelConnection
    from app.services.channel_connection import apply_refresh_result

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org_id, _ = await _seed_org(s)
            conn = await _seed_expired_connection_with_error_trio(s, org_id, channel="threads")

            await apply_refresh_result(s, connection=conn, new_access_token="new-token", expires_in_seconds=3600)

            refreshed = await s.get(ChannelConnection, conn.id)
            assert refreshed.status == "active"
            assert refreshed.last_error is None
            assert refreshed.last_error_code is None
            assert refreshed.last_error_at is None
    finally:
        await engine.dispose()
