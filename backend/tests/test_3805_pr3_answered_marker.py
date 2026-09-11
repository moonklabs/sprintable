"""story #3805(Phase3·3-1·PR 3, 페드루 PO 定 2026-09-11 10:36Z) — 「반응」(Engagement)
읽기전용 「답변함」 마커. 정정 배경: 「답글 편입」을 처음엔 channel_post_comment_
replies를 큐에 UNION으로 합류시켜 구현했으나, 이 테이블은 author 개념이 우리
조직 멤버뿐이라(고객 값을 담을 자리가 스키마에 없음) 전 행이 100% outbound —
"받은 반응"(inbound) 큐에 outbound를 섞은 설계 오류였다(PO 실측 지적, 캡처
리뷰 中 발견). 이 파일은 되돌린 뒤의 정본 계약을 고정한다: 댓글 행 옆에
읽기전용 answered_at만 노출(트리아지는 안 건드림).

세팅 헬퍼는 test_3805_engagement_items.py(PR1)와 동형 재사용(중복 재발명 금지)."""
from __future__ import annotations

import os
import uuid
from datetime import datetime, timedelta, timezone

import pytest

from tests.test_e4fc29fa_site_post_orchestration import _seed_org, _session_factory
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


async def _seed_reply(session, *, org_id, comment_id, member_id, status="sent"):
    from app.models.channel_post_comment import ChannelPostCommentReply

    r = ChannelPostCommentReply(
        id=uuid.uuid4(), org_id=org_id, comment_id=comment_id, text="우리 답변",
        status=status, created_by_member_id=member_id, created_by_kind="human",
    )
    session.add(r)
    await session.commit()
    return r


@pytest.mark.anyio
async def test_answered_at_null_when_no_sent_reply():
    from app.main import app

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org_id, _project_id = await _seed_org(s)
            owner_id = await _seed_human(s, org_id)
            conn = await _seed_channel_connection(s, org_id, channel="threads")
            pub = await _seed_channel_publication(s, org_id=org_id, connection_id=conn.id, channel="threads")
            comment = await _seed_comment(s, org_id=org_id, publication_id=pub.id, channel="threads")
            # 초안만 있고 아직 안 보냄 — 답변함 아님.
            await _seed_reply(s, org_id=org_id, comment_id=comment.id, member_id=owner_id, status="draft")

        _setup_org_scoped_app(app, Session, org_id, user_id=owner_id)
        async with _client_for(app) as client:
            r = await client.get(f"/api/v2/organizations/{org_id}/engagement/items")
        assert r.status_code == 200, r.text
        item = r.json()["items"][0]
        assert item["id"] == str(comment.id)
        assert item["answered_at"] is None
        # story #3805 PR 4(페드루 PO 確定 2026-09-11 12:12Z) — kind가 되살아났다.
        # 이번엔 outbound 답글 편입(PR 3에서 되돌린 설계 오류)이 아니라 인바운드
        # parent_comment_id 有無로 판정 — 이 댓글은 parent가 없는 최상위 댓글.
        assert item["kind"] == "comment"
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()


@pytest.mark.anyio
async def test_answered_at_set_when_reply_sent_triage_status_unaffected():
    """뮤테이션 대상: get_latest_sent_reply_at_by_comment_ids가 status='sent' 필터를
    걷으면(draft/pending도 답변함으로 잘못 셈) 이 테스트가 실패한다 — draft 답글
    하나·sent 답글 하나를 같이 심어 status 필터가 실제로 도는지 증명."""
    from app.main import app

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org_id, _project_id = await _seed_org(s)
            owner_id = await _seed_human(s, org_id)
            conn = await _seed_channel_connection(s, org_id, channel="threads")
            pub = await _seed_channel_publication(s, org_id=org_id, connection_id=conn.id, channel="threads")
            comment = await _seed_comment(s, org_id=org_id, publication_id=pub.id, channel="threads", triage_status="open")
            await _seed_reply(s, org_id=org_id, comment_id=comment.id, member_id=owner_id, status="draft")
            await _seed_reply(s, org_id=org_id, comment_id=comment.id, member_id=owner_id, status="sent")

        _setup_org_scoped_app(app, Session, org_id, user_id=owner_id)
        async with _client_for(app) as client:
            r = await client.get(f"/api/v2/organizations/{org_id}/engagement/items")
        assert r.status_code == 200, r.text
        item = r.json()["items"][0]
        assert item["answered_at"] is not None
        # 답변함이어도 트리아지 상태는 그대로(사람이 직접 옮긴다) — open 유지.
        assert item["triage_status"] == "open"
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()


@pytest.mark.anyio
async def test_patch_response_also_carries_answered_at():
    from app.main import app

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org_id, _project_id = await _seed_org(s)
            owner_id = await _seed_human(s, org_id)
            conn = await _seed_channel_connection(s, org_id, channel="threads")
            pub = await _seed_channel_publication(s, org_id=org_id, connection_id=conn.id, channel="threads")
            comment = await _seed_comment(s, org_id=org_id, publication_id=pub.id, channel="threads")
            await _seed_reply(s, org_id=org_id, comment_id=comment.id, member_id=owner_id, status="sent")

        _setup_org_scoped_app(app, Session, org_id, user_id=owner_id)
        async with _client_for(app) as client:
            r = await client.patch(
                f"/api/v2/organizations/{org_id}/engagement/items/{comment.id}",
                json={"triage_status": "done"},
            )
        assert r.status_code == 200, r.text
        body = r.json()
        assert body["answered_at"] is not None
        assert body["triage_status"] == "done"
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()
