"""story #3516 조각③(Phase2·마케팅운영, 페드루 PO 確定 2026-09-05) — 에이전트 스코프
전수 확인 + AC8 라이브 런북(sandbox "댓글 지워진 상태" id 규칙) 자가검증.

세팅 헬퍼는 조각①·조각②(test_3516_channel_post_comments.py·test_3516_comment_
reply.py)와 동형(중복 재발명 금지)."""
from __future__ import annotations

import os
import uuid
from datetime import datetime, timedelta, timezone

import pytest
from fastapi import HTTPException

from tests.test_e4fc29fa_site_post_orchestration import (
    _seed_agent, _seed_default_role, _seed_human, _seed_org, _session_factory,
)
from tests.test_3497_insight_snapshots import _seed_channel_connection, _seed_channel_publication
from tests.test_3475_publishing_metrics import _client_for, _setup_org_scoped_app
from tests.test_3502_insights_board import _seed_channel_publication as _seed_board_channel_publication
from tests.test_3502_insights_board import _seed_gate
from tests.test_3471_org_content_rules_lint import _seed_story

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


@pytest.fixture(autouse=True)
def _enable_sandbox_adapter(monkeypatch):
    import app.services.channel_adapters as adapters_mod

    sandbox_config = adapters_mod.ChannelAdapterConfig(
        authorize_url="", token_url="", scope="sandbox_publish,sandbox_delete,sandbox_manage_replies",
        refresh_mode="manual", display_name="Sandbox", credential_kind="none", max_text_length=500,
        utm_source="sandbox", utm_medium="test", supports_unpublish=True,
        unpublish_required_scope="sandbox_delete",
        image_formats=("image/jpeg", "image/png"), image_max_bytes=8 * 1024 * 1024,
        image_aspect_max=10.0, image_width_min=320, image_width_max=1440,
        image_color_space="sRGB", image_max_count=1,
        insight_metrics=("impressions", "reach", "views", "engagements", "clicks", "spend", "conversions"),
        supports_fetch_replies=True, supports_reply=True, reply_required_scope="sandbox_manage_replies",
    )
    monkeypatch.setitem(adapters_mod.CHANNEL_ADAPTERS, "sandbox", sandbox_config)
    yield


async def _seed_comment(session, *, org_id, publication_id, channel="sandbox", text="원 댓글", external_comment_id="c1"):
    from app.models.channel_post_comment import ChannelPostComment
    import hashlib

    comment = ChannelPostComment(
        id=uuid.uuid4(), org_id=org_id, publication_id=publication_id, channel=channel,
        external_comment_id=external_comment_id, author_display_name="user1", text=text,
        text_sha256=hashlib.sha256(text.encode("utf-8")).hexdigest(),
        external_created_at=datetime.now(timezone.utc), captured_at=datetime.now(timezone.utc), raw={},
    )
    session.add(comment)
    await session.commit()
    return comment


async def _seed_full_publication_chain(session, *, org_id, project_id, channel="sandbox"):
    work_item_id = await _seed_story(session, org_id, project_id)
    gate = await _seed_gate(session, org_id=org_id, work_item_id=work_item_id)
    conn = await _seed_channel_connection(session, org_id, channel=channel)
    pub = await _seed_board_channel_publication(
        session, org_id=org_id, gate_id=gate.id, channel=channel, published_at=datetime.now(timezone.utc),
        connection_id=conn.id,
    )
    return work_item_id, gate, conn, pub


# ─── ① 에이전트 스코프 전수 ───────────────────────────────────────────────────


@pytest.mark.anyio
async def test_agent_scope_matrix():
    """한 org 안에서 에이전트 키로 6개 액션을 전부 두드려 200/403을 한 번에 확인
    (페드루 조각③ ① — 목록 GET·초안 POST 200 / submit·approve·refresh·follow-up
    거부, 코드 명시)."""
    from app.main import app
    from app.services.channel_post_comment_replies import create_comment_reply_draft, submit_comment_reply

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org_id, project_id = await _seed_org(s)
            await _seed_default_role(s, org_id)
            agent_id = await _seed_agent(s, org_id, project_id)
            human_id, _ = await _seed_human(s, org_id, role="owner")
            _, _, _, pub = await _seed_full_publication_chain(s, org_id=org_id, project_id=project_id)
            comment = await _seed_comment(s, org_id=org_id, publication_id=pub.id)

            # 승인 흐름을 사람으로 미리 한 번 완주해 gate_id를 하나 확보(approve
            # 거부 테스트용 — 새 초안을 만들면 gate가 없어 승인 자체를 시도할 수
            # 없으니, 이미 pending인 게이트가 있어야 "에이전트가 승인 못 함"을 잰다).
            human_draft = await create_comment_reply_draft(
                s, org_id=org_id, comment_id=comment.id, text="휴먼 답변", created_by_member_id=human_id,
                created_by_kind="human",
            )
            human_reply = await submit_comment_reply(s, org_id=org_id, reply_id=human_draft.id, requester_member_id=human_id)
            gate_id = human_reply.gate_id

        _setup_org_scoped_app(app, Session, org_id, user_id=agent_id, agent=True)
        try:
            async with _client_for(app) as client:
                # 목록 GET(조각①) — 200.
                resp_list = await client.get(f"/api/v2/organizations/{org_id}/publications/{pub.id}/comments")
                assert resp_list.status_code == 200, resp_list.text

                # 답변 초안 POST — 200(201).
                resp_draft = await client.post(
                    f"/api/v2/organizations/{org_id}/comments/{comment.id}/replies", json={"text": "에이전트 초안"},
                )
                assert resp_draft.status_code == 201, resp_draft.text
                agent_reply_id = resp_draft.json()["id"]

                # submit — 403.
                resp_submit = await client.post(
                    f"/api/v2/organizations/{org_id}/comments/{comment.id}/replies/{agent_reply_id}/submit",
                )
                assert resp_submit.status_code == 403
                assert resp_submit.json()["error"]["code"] == "COMMENT_REPLY_HUMAN_ONLY"

                # follow-up — 403.
                resp_followup = await client.post(
                    f"/api/v2/organizations/{org_id}/comments/{comment.id}/follow-ups", json={"title": "t"},
                )
                assert resp_followup.status_code == 403
                assert resp_followup.json()["error"]["code"] == "COMMENT_REPLY_HUMAN_ONLY"

                # refresh(조각①) — 403.
                resp_refresh = await client.post(
                    f"/api/v2/organizations/{org_id}/publications/{pub.id}/comments/refresh",
                )
                assert resp_refresh.status_code == 403
                assert resp_refresh.json()["error"]["code"] == "COMMENT_REFRESH_HUMAN_ONLY"
        finally:
            app.dependency_overrides.clear()

        # approve(gates.py 범용 전이 — 신규 로직 0, comment_reply 게이트도 기존
        # "휴먼만 승인" 규율을 그대로 탄다) — 이 org 전이 엔드포인트를 실 HTTP로
        # 왕복하면 이 테스트 환경에서 무관한 백그라운드 부작용(pg_notify 등 dev
        # 인프라 부재)이 얽혀 응답이 끝없이 지연되는 현상이 있어(재현 확認·환경
        # 이슈로 판정, 이 스토리 코드 변화와 무관 — resolve_member·`_authorize_
        # gate_approve_equivalent` 자체는 서비스 계층에서 직접 호출하면 즉시
        # 403을 낸다), 라우터가 실제로 쓰는 그 인가 함수를 직접 호출해 같은
        # 판정을 검증한다(HTTP 왕복 없이 순수 서비스 계층 재현).
        from app.dependencies.auth import AuthContext
        from app.models.gate import Gate
        from app.routers.gates import _authorize_gate_approve_equivalent
        from app.services.member_resolver import resolve_member

        async with Session() as s:
            auth = AuthContext(
                user_id=str(agent_id), email="agent@test",
                claims={"app_metadata": {"org_id": str(org_id), "api_key_id": "test-agent-key"}},
            )
            resolved = await resolve_member(auth, org_id, s)
            assert resolved.type == "agent"
            gate_row = await s.get(Gate, gate_id)
            with pytest.raises(HTTPException) as exc_info:
                await _authorize_gate_approve_equivalent(s, gate_row, resolved, auth, org_id)
            assert exc_info.value.status_code == 403
    finally:
        await engine.dispose()


# ─── ③ AC8 — sandbox "댓글 지워진 상태" id 규칙 ──────────────────────────────


def test_sandbox_comment2_deleted_marker_encodes_and_decodes_epoch():
    import app.services.sandbox_publish as sandbox_publish

    creation_id = sandbox_publish._encode_creation_id(
        mode="ok", ready_at_epoch=1234567890, comment2_delete_after_epoch=1234567950,
    )
    # 기존 4단 판정(mode·ready_at_epoch)이 5·6단이 붙어도 안 깨진다(하위호환).
    mode, ready_at_epoch = sandbox_publish._decode_creation_id(creation_id)
    assert mode == "ok"
    assert ready_at_epoch == 1234567890
    assert sandbox_publish._decode_comment2_delete_after_epoch(creation_id) == 1234567950

    # 마커 없는 기존 creation_id는 None(하위호환 — 기존 5종 마커 영향 0).
    plain = sandbox_publish._encode_creation_id(mode="ok", ready_at_epoch=1234567890)
    assert sandbox_publish._decode_comment2_delete_after_epoch(plain) is None


@pytest.mark.anyio
async def test_sandbox_fetch_replies_shows_two_before_epoch_and_one_after(monkeypatch):
    """AC8 라이브 런북의 핵심 재현 — [sandbox:comment-2-deleted] 마커로 만든
    media_id는 처음엔(delete_after 전) 2건, 그 시각을 지나면 1건만 준다."""
    import app.services.sandbox_publish as sandbox_publish
    import httpx

    class _FakeClient:
        pass

    fake_now = [1000.0]
    monkeypatch.setattr(sandbox_publish.time, "time", lambda: fake_now[0])

    creation_id = await sandbox_publish.create_container(
        _FakeClient(), access_token="x", threads_user_id="u", text="본문 [sandbox:comment-2-deleted]",
    )
    media_id = await sandbox_publish.publish_container(
        _FakeClient(), access_token="x", threads_user_id="u", creation_id=creation_id,
    )
    assert media_id.endswith(f"-c2del{1000 + sandbox_publish._COMMENT2_DELETE_AFTER_SECONDS}")

    before_items, before_complete = await sandbox_publish.fetch_replies(_FakeClient(), access_token="x", media_id=media_id)
    assert len(before_items) == 2
    assert before_complete is True

    fake_now[0] = 1000.0 + sandbox_publish._COMMENT2_DELETE_AFTER_SECONDS + 1
    after_items, after_complete = await sandbox_publish.fetch_replies(_FakeClient(), access_token="x", media_id=media_id)
    assert len(after_items) == 1
    assert after_complete is True


@pytest.mark.anyio
async def test_sandbox_fetch_replies_without_marker_unaffected_by_time(monkeypatch):
    """하위호환 뮤테이션성 확인 — 마커 없는 기존 media_id는 시간이 아무리 지나도
    항상 2건(기존 5종 마커·기본 성공 경로에 영향 0)."""
    import app.services.sandbox_publish as sandbox_publish

    fake_now = [1000.0]
    monkeypatch.setattr(sandbox_publish.time, "time", lambda: fake_now[0])

    items_now, _ = await sandbox_publish.fetch_replies(None, access_token="x", media_id="sandbox-media-plain")
    fake_now[0] = 999999999.0
    items_later, _ = await sandbox_publish.fetch_replies(None, access_token="x", media_id="sandbox-media-plain")
    assert len(items_now) == 2
    assert len(items_later) == 2


@pytest.mark.anyio
async def test_ac8_runbook_end_to_end_delete_then_submit_reply_409(monkeypatch):
    """AC8 전체 흐름(카디르군 런북 그대로) — sandbox 표본 게시물에 마커 붙은
    media_id로 발행 → 첫 refresh 2건 → delete_after 지남 → 재수집 1건(소프트
    삭제 리컨실) → 그 지워진 댓글에 답변 상신 시도 → 409."""
    from app.services.channel_post_comments import collect_comments_for_publication
    from app.services.channel_post_comment_replies import (
        CommentReplyTargetDeletedError, create_comment_reply_draft, submit_comment_reply,
    )
    import app.services.sandbox_publish as sandbox_publish

    fake_now = [1000.0]
    monkeypatch.setattr(sandbox_publish.time, "time", lambda: fake_now[0])

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org_id, project_id = await _seed_org(s)
            await _seed_default_role(s, org_id)
            human_id, _ = await _seed_human(s, org_id, role="owner")
            _, _, conn, pub = await _seed_full_publication_chain(s, org_id=org_id, project_id=project_id)

            creation_id = await sandbox_publish.create_container(
                None, access_token="x", threads_user_id=conn.account_id, text="[sandbox:comment-2-deleted]",
            )
            media_id = await sandbox_publish.publish_container(
                None, access_token="x", threads_user_id=conn.account_id, creation_id=creation_id,
            )

            first = await collect_comments_for_publication(
                s, org_id=org_id, publication_id=pub.id, channel="sandbox", external_id=media_id,
            )
            await s.commit()
            assert first["fetched"] == 2

            fake_now[0] = 1000.0 + sandbox_publish._COMMENT2_DELETE_AFTER_SECONDS + 1
            second = await collect_comments_for_publication(
                s, org_id=org_id, publication_id=pub.id, channel="sandbox", external_id=media_id,
            )
            await s.commit()
            assert second["deleted"] == 1

            from app.models.channel_post_comment import ChannelPostComment
            from sqlalchemy import select

            deleted_comment = (await s.execute(
                select(ChannelPostComment).where(
                    ChannelPostComment.publication_id == pub.id, ChannelPostComment.deleted_at.is_not(None),
                )
            )).scalar_one()

            draft = await create_comment_reply_draft(
                s, org_id=org_id, comment_id=deleted_comment.id, text="답변 시도", created_by_member_id=human_id,
                created_by_kind="human",
            )
            with pytest.raises(CommentReplyTargetDeletedError):
                await submit_comment_reply(s, org_id=org_id, reply_id=draft.id, requester_member_id=human_id)
    finally:
        await engine.dispose()
