"""story #3805(Phase3·3-1·PR 3, 페드루 PO 確定 2026-09-11 09:31Z) — 「반응」
(Engagement) 답글 편입. channel_post_comment_replies에 얹은 triage 3컬럼(0365)이
`/engagement/items`에 comment와 UNION ALL로 합류하는지, PATCH가 item_id로 두
테이블 다 찾는지 검증한다.

세팅 헬퍼는 test_3805_engagement_items.py(PR1)와 동형 재사용(중복 재발명 금지)."""
from __future__ import annotations

import os
import uuid
from datetime import datetime, timedelta, timezone

import pytest

from tests.test_e4fc29fa_site_post_orchestration import _seed_agent, _seed_org, _session_factory
from tests.test_3497_insight_snapshots import _seed_channel_connection, _seed_channel_publication
from tests.test_3475_publishing_metrics import _client_for, _seed_human, _setup_org_scoped_app

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


async def _seed_comment(session, *, org_id, publication_id, channel, triage_status="open", captured_at=None):
    from app.models.channel_post_comment import ChannelPostComment

    c = ChannelPostComment(
        id=uuid.uuid4(), org_id=org_id, publication_id=publication_id, channel=channel,
        external_comment_id=f"ext-{uuid.uuid4().hex[:8]}", text="원 댓글",
        text_sha256=uuid.uuid4().hex, captured_at=captured_at or datetime.now(timezone.utc),
        triage_status=triage_status,
    )
    session.add(c)
    await session.commit()
    return c


async def _seed_reply(session, *, org_id, comment_id, member_id, triage_status="open", created_at=None):
    from app.models.channel_post_comment import ChannelPostCommentReply

    r = ChannelPostCommentReply(
        id=uuid.uuid4(), org_id=org_id, comment_id=comment_id, text="우리 답변",
        status="draft", created_by_member_id=member_id, created_by_kind="human",
        triage_status=triage_status,
    )
    session.add(r)
    await session.commit()
    if created_at is not None:
        # created_at은 server_default라 seed 뒤 직접 갱신(과거 시각을 흉내내기 위함).
        r.created_at = created_at
        session.add(r)
        await session.commit()
    return r


@pytest.mark.anyio
async def test_list_unions_comment_and_reply_sorted_together():
    from app.main import app

    engine, Session = await _session_factory()
    try:
        now = datetime.now(timezone.utc)
        async with Session() as s:
            org_id, _project_id = await _seed_org(s)
            owner_id = await _seed_human(s, org_id)
            conn = await _seed_channel_connection(s, org_id, channel="threads")
            pub = await _seed_channel_publication(s, org_id=org_id, connection_id=conn.id, channel="threads")

            comment = await _seed_comment(
                s, org_id=org_id, publication_id=pub.id, channel="threads",
                triage_status="open", captured_at=now - timedelta(hours=2),
            )
            reply = await _seed_reply(
                s, org_id=org_id, comment_id=comment.id, member_id=owner_id,
                triage_status="open", created_at=now - timedelta(hours=1),
            )

        _setup_org_scoped_app(app, Session, org_id, user_id=owner_id)
        async with _client_for(app) as client:
            r = await client.get(f"/api/v2/organizations/{org_id}/engagement/items?limit=50")
        assert r.status_code == 200, r.text
        items = r.json()["items"]
        ids_kinds = [(item["id"], item["kind"]) for item in items]
        # 둘 다 open이라 item_at desc — reply(1시간 전)가 comment(2시간 전)보다 먼저.
        assert ids_kinds == [(str(reply.id), "reply"), (str(comment.id), "comment")]
        # reply 행은 부모 댓글의 channel/publication_id를 조인해서 받는다(지어내지 않음).
        reply_item = items[0]
        assert reply_item["channel"] == "threads"
        assert reply_item["publication_id"] == str(pub.id)
        assert reply_item["external_comment_id"] is None
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()


@pytest.mark.anyio
async def test_list_kind_filter_narrows_to_one_table():
    from app.main import app

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org_id, _project_id = await _seed_org(s)
            owner_id = await _seed_human(s, org_id)
            conn = await _seed_channel_connection(s, org_id, channel="threads")
            pub = await _seed_channel_publication(s, org_id=org_id, connection_id=conn.id, channel="threads")
            comment = await _seed_comment(s, org_id=org_id, publication_id=pub.id, channel="threads")
            reply = await _seed_reply(s, org_id=org_id, comment_id=comment.id, member_id=owner_id)

        _setup_org_scoped_app(app, Session, org_id, user_id=owner_id)
        async with _client_for(app) as client:
            r_comment = await client.get(f"/api/v2/organizations/{org_id}/engagement/items?kind=comment")
            r_reply = await client.get(f"/api/v2/organizations/{org_id}/engagement/items?kind=reply")
        assert [i["id"] for i in r_comment.json()["items"]] == [str(comment.id)]
        assert [i["id"] for i in r_reply.json()["items"]] == [str(reply.id)]
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()


@pytest.mark.anyio
async def test_patch_reply_by_id_persists_and_reports_kind():
    """뮤테이션 대상: patch_engagement_item이 comment 테이블만 보고 실패(404)하면
    이 테스트가 RED가 된다 — reply 테이블 폴백 조회가 실제로 도는지 증명."""
    from app.main import app

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org_id, _project_id = await _seed_org(s)
            owner_id = await _seed_human(s, org_id)
            conn = await _seed_channel_connection(s, org_id, channel="threads")
            pub = await _seed_channel_publication(s, org_id=org_id, connection_id=conn.id, channel="threads")
            comment = await _seed_comment(s, org_id=org_id, publication_id=pub.id, channel="threads")
            reply = await _seed_reply(s, org_id=org_id, comment_id=comment.id, member_id=owner_id)

        _setup_org_scoped_app(app, Session, org_id, user_id=owner_id)
        async with _client_for(app) as client:
            r = await client.patch(
                f"/api/v2/organizations/{org_id}/engagement/items/{reply.id}",
                json={"triage_status": "done"},
            )
        assert r.status_code == 200, r.text
        body = r.json()
        assert body["kind"] == "reply"
        assert body["triage_status"] == "done"

        async with Session() as s:
            from app.models.channel_post_comment import ChannelPostCommentReply

            refreshed = await s.get(ChannelPostCommentReply, reply.id)
            assert refreshed.triage_status == "done"
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()


@pytest.mark.anyio
async def test_patch_reply_from_other_org_is_404():
    from app.main import app

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org_id, _project_id = await _seed_org(s)
            other_org_id, _other_project_id = await _seed_org(s)
            owner_id = await _seed_human(s, org_id)
            conn = await _seed_channel_connection(s, other_org_id, channel="threads")
            pub = await _seed_channel_publication(s, org_id=other_org_id, connection_id=conn.id, channel="threads")
            comment = await _seed_comment(s, org_id=other_org_id, publication_id=pub.id, channel="threads")
            reply = await _seed_reply(s, org_id=other_org_id, comment_id=comment.id, member_id=owner_id)

        _setup_org_scoped_app(app, Session, org_id, user_id=owner_id)
        async with _client_for(app) as client:
            r = await client.patch(
                f"/api/v2/organizations/{org_id}/engagement/items/{reply.id}",
                json={"triage_status": "done"},
            )
        assert r.status_code == 404, r.text
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()
