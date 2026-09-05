"""story #3516 조각②(Phase2·마케팅운영, 페드루 PO 確定 2026-09-05) — 댓글 「작업으로
전환」+ 답변(초안→상신→게이트→명령→어댑터 reply)+target_comment_state+보드 3필드.

세팅 헬퍼는 test_3516_channel_post_comments.py(조각①)·test_e4fc29fa_site_post_
orchestration.py와 동형(중복 재발명 금지)."""
from __future__ import annotations

import os
import uuid
from datetime import datetime, timedelta, timezone

import pytest

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
    """test_3516_channel_post_comments.py와 동형 — supports_reply=True로 등재."""
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


def _fake_comment(comment_id: str, text: str = "댓글") -> dict:
    return {
        "id": comment_id, "text": text, "username": "user1",
        "timestamp": datetime.now(timezone.utc).isoformat(),
    }


async def _seed_comment(session, *, org_id, publication_id, channel="sandbox", text="원 댓글", external_comment_id="c1"):
    """조각①의 collect_comments_for_publication을 직접 거치지 않고(그 흐름은 조각①이
    이미 잰다) 이 스토리(조각②)의 관심사만 격리해서 재는 최소 시딩."""
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
    """channel_publication 하나가 온전히 Gate→Story까지 이어지게(그라운딩 — comment
    follow-up·submit_comment_reply 둘 다 이 체인을 타고 올라가 work_item_id를 찾는다)."""
    work_item_id = await _seed_story(session, org_id, project_id)
    gate = await _seed_gate(session, org_id=org_id, work_item_id=work_item_id)
    conn = await _seed_channel_connection(session, org_id, channel=channel)
    pub = await _seed_board_channel_publication(
        session, org_id=org_id, gate_id=gate.id, channel=channel, published_at=datetime.now(timezone.utc),
        connection_id=conn.id,
    )
    return work_item_id, gate, conn, pub


# ─── compute_target_comment_state ────────────────────────────────────────────


def test_compute_target_comment_state_three_branches():
    from app.services.channel_post_comment_replies import compute_target_comment_state
    from app.models.channel_post_comment import ChannelPostComment
    import hashlib

    text = "원 댓글"
    sha = hashlib.sha256(text.encode("utf-8")).hexdigest()

    current = ChannelPostComment(text=text, text_sha256=sha, deleted_at=None)
    assert compute_target_comment_state(comment=current, sealed_target_text_sha256=sha) == "current"

    changed = ChannelPostComment(text="편집됨", text_sha256="다른sha", deleted_at=None)
    assert compute_target_comment_state(comment=changed, sealed_target_text_sha256=sha) == "changed"

    deleted = ChannelPostComment(text=text, text_sha256=sha, deleted_at=datetime.now(timezone.utc))
    assert compute_target_comment_state(comment=deleted, sealed_target_text_sha256=sha) == "deleted"

    # deleted가 changed보다 우선(동시에 바뀌었어도).
    deleted_and_changed = ChannelPostComment(text="편집됨", text_sha256="다른sha", deleted_at=datetime.now(timezone.utc))
    assert compute_target_comment_state(comment=deleted_and_changed, sealed_target_text_sha256=sha) == "deleted"


# ─── create_comment_follow_up ────────────────────────────────────────────────


@pytest.mark.anyio
async def test_create_comment_follow_up_creates_story_with_number_and_evidence():
    from app.services.channel_post_comment_replies import create_comment_follow_up
    from app.models.pm import Story
    from app.models.evidence import Evidence
    from sqlalchemy import select

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org_id, project_id = await _seed_org(s)
            human_id, _ = await _seed_human(s, org_id)
            _, _, _, pub = await _seed_full_publication_chain(s, org_id=org_id, project_id=project_id)
            comment = await _seed_comment(s, org_id=org_id, publication_id=pub.id)

            result = await create_comment_follow_up(
                s, org_id=org_id, comment_id=comment.id, title="[댓글] 후속", note="확인 필요",
                requested_by_member_id=human_id,
            )
            story = (await s.execute(select(Story).where(Story.id == result["story_id"]))).scalar_one()
            assert story.title == "[댓글] 후속"
            assert story.story_number is not None, "allocate_story_number를 거쳐야 한다(story #3505 원 증상 재발 방지)"
            assert story.assignee_id == human_id

            evidence = (await s.execute(
                select(Evidence).where(Evidence.work_item_id == story.id)
            )).scalar_one()
            assert evidence.payload["comment_id"] == str(comment.id)
    finally:
        await engine.dispose()


@pytest.mark.anyio
async def test_create_comment_follow_up_unknown_comment_raises_not_found():
    from app.services.channel_post_comment_replies import CommentNotFoundError, create_comment_follow_up

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org_id, _ = await _seed_org(s)
            human_id, _ = await _seed_human(s, org_id)
            with pytest.raises(CommentNotFoundError):
                await create_comment_follow_up(
                    s, org_id=org_id, comment_id=uuid.uuid4(), title="t", note=None,
                    requested_by_member_id=human_id,
                )
    finally:
        await engine.dispose()


# ─── create_comment_reply_draft + submit_comment_reply ───────────────────────


@pytest.mark.anyio
async def test_submit_comment_reply_creates_sealed_gate():
    from app.services.channel_post_comment_replies import create_comment_reply_draft, submit_comment_reply
    from app.models.gate import Gate
    import hashlib

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org_id, project_id = await _seed_org(s)
            await _seed_default_role(s, org_id)
            human_id, _ = await _seed_human(s, org_id)
            work_item_id, _, _, pub = await _seed_full_publication_chain(s, org_id=org_id, project_id=project_id)
            comment = await _seed_comment(s, org_id=org_id, publication_id=pub.id)

            draft = await create_comment_reply_draft(
                s, org_id=org_id, comment_id=comment.id, text="답변 초안",
                created_by_member_id=human_id, created_by_kind="human",
            )
            assert draft.status == "draft"
            assert draft.gate_id is None

            reply = await submit_comment_reply(s, org_id=org_id, reply_id=draft.id, requester_member_id=human_id)
            assert reply.status == "pending"
            assert reply.gate_id is not None

            gate = (await s.execute(
                Gate.__table__.select().where(Gate.id == reply.gate_id)
            )).mappings().one()
            assert gate["scope_key"] == f"comment:{comment.id}"
            assert gate["work_item_id"] == work_item_id
            assert gate["sealed_content_sha256"] == hashlib.sha256("답변 초안".encode("utf-8")).hexdigest()
            assert gate["sealed_content_body"] == "답변 초안"
            assert gate["neutral_facts"]["kind"] == "comment_reply"
            assert gate["neutral_facts"]["target_external_comment_id"] == comment.external_comment_id
            assert gate["neutral_facts"]["target_text_sha256"] == comment.text_sha256
    finally:
        await engine.dispose()


@pytest.mark.anyio
async def test_submit_comment_reply_wrong_status_raises():
    from app.services.channel_post_comment_replies import (
        CommentReplyWrongStatusError, create_comment_reply_draft, submit_comment_reply,
    )

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org_id, project_id = await _seed_org(s)
            await _seed_default_role(s, org_id)
            human_id, _ = await _seed_human(s, org_id)
            _, _, _, pub = await _seed_full_publication_chain(s, org_id=org_id, project_id=project_id)
            comment = await _seed_comment(s, org_id=org_id, publication_id=pub.id)

            draft = await create_comment_reply_draft(
                s, org_id=org_id, comment_id=comment.id, text="답변", created_by_member_id=human_id,
                created_by_kind="human",
            )
            await submit_comment_reply(s, org_id=org_id, reply_id=draft.id, requester_member_id=human_id)

            with pytest.raises(CommentReplyWrongStatusError):
                await submit_comment_reply(s, org_id=org_id, reply_id=draft.id, requester_member_id=human_id)
    finally:
        await engine.dispose()


@pytest.mark.anyio
async def test_submit_comment_reply_target_deleted_raises():
    from app.services.channel_post_comment_replies import (
        CommentReplyTargetDeletedError, create_comment_reply_draft, submit_comment_reply,
    )

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org_id, project_id = await _seed_org(s)
            await _seed_default_role(s, org_id)
            human_id, _ = await _seed_human(s, org_id)
            _, _, _, pub = await _seed_full_publication_chain(s, org_id=org_id, project_id=project_id)
            comment = await _seed_comment(s, org_id=org_id, publication_id=pub.id)

            draft = await create_comment_reply_draft(
                s, org_id=org_id, comment_id=comment.id, text="답변", created_by_member_id=human_id,
                created_by_kind="human",
            )
            comment.deleted_at = datetime.now(timezone.utc)
            await s.commit()

            with pytest.raises(CommentReplyTargetDeletedError):
                await submit_comment_reply(s, org_id=org_id, reply_id=draft.id, requester_member_id=human_id)
    finally:
        await engine.dispose()


@pytest.mark.anyio
async def test_submit_comment_reply_unsupported_channel_raises():
    from app.services.channel_post_comment_replies import (
        CommentReplyChannelUnsupportedError, create_comment_reply_draft, submit_comment_reply,
    )

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org_id, project_id = await _seed_org(s)
            await _seed_default_role(s, org_id)
            human_id, _ = await _seed_human(s, org_id)
            _, _, _, pub = await _seed_full_publication_chain(s, org_id=org_id, project_id=project_id, channel="wordpress")
            comment = await _seed_comment(s, org_id=org_id, publication_id=pub.id, channel="wordpress")

            draft = await create_comment_reply_draft(
                s, org_id=org_id, comment_id=comment.id, text="답변", created_by_member_id=human_id,
                created_by_kind="human",
            )
            with pytest.raises(CommentReplyChannelUnsupportedError):
                await submit_comment_reply(s, org_id=org_id, reply_id=draft.id, requester_member_id=human_id)
    finally:
        await engine.dispose()


# ─── gates.py 승인 → gate_service.py 자동 명령 생성(comment_reply 분기) ────────


@pytest.mark.anyio
async def test_api_approve_gate_creates_comment_reply_command():
    from app.main import app
    from app.models.publication_command import PublicationCommand
    from app.services.channel_post_comment_replies import create_comment_reply_draft, submit_comment_reply
    from sqlalchemy import select

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org_id, project_id = await _seed_org(s)
            await _seed_default_role(s, org_id)
            human_id, _ = await _seed_human(s, org_id, role="owner")
            _, _, conn, pub = await _seed_full_publication_chain(s, org_id=org_id, project_id=project_id)
            comment = await _seed_comment(s, org_id=org_id, publication_id=pub.id)

            draft = await create_comment_reply_draft(
                s, org_id=org_id, comment_id=comment.id, text="답변", created_by_member_id=human_id,
                created_by_kind="human",
            )
            reply = await submit_comment_reply(s, org_id=org_id, reply_id=draft.id, requester_member_id=human_id)
            gate_id = reply.gate_id

        _setup_org_scoped_app(app, Session, org_id, user_id=human_id, agent=False)
        try:
            async with _client_for(app) as client:
                resp = await client.post(
                    f"/api/v2/gates/{gate_id}/transition",
                    json={"status": "approved", "note": "승인", "evidence_viewed": True},
                )
                assert resp.status_code == 200, resp.text
        finally:
            app.dependency_overrides.clear()

        async with Session() as s:
            command = (await s.execute(
                select(PublicationCommand).where(PublicationCommand.gate_id == gate_id)
            )).scalar_one()
            assert command.content_kind == "comment_reply"
            assert command.operation == "reply"
            assert command.destination == conn.id
            assert command.approved_version == reply.id
    finally:
        await engine.dispose()


@pytest.mark.anyio
async def test_api_approve_gate_rejects_when_target_comment_deleted():
    from app.main import app
    from app.services.channel_post_comment_replies import create_comment_reply_draft, submit_comment_reply

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org_id, project_id = await _seed_org(s)
            await _seed_default_role(s, org_id)
            human_id, _ = await _seed_human(s, org_id, role="owner")
            _, _, _, pub = await _seed_full_publication_chain(s, org_id=org_id, project_id=project_id)
            comment = await _seed_comment(s, org_id=org_id, publication_id=pub.id)

            draft = await create_comment_reply_draft(
                s, org_id=org_id, comment_id=comment.id, text="답변", created_by_member_id=human_id,
                created_by_kind="human",
            )
            reply = await submit_comment_reply(s, org_id=org_id, reply_id=draft.id, requester_member_id=human_id)
            gate_id = reply.gate_id

            comment.deleted_at = datetime.now(timezone.utc)
            await s.commit()

        _setup_org_scoped_app(app, Session, org_id, user_id=human_id, agent=False)
        try:
            async with _client_for(app) as client:
                resp = await client.post(
                    f"/api/v2/gates/{gate_id}/transition",
                    json={"status": "approved", "note": "승인", "evidence_viewed": True},
                )
                assert resp.status_code == 409, resp.text
                assert resp.json()["error"]["code"] == "COMMENT_REPLY_TARGET_DELETED"
        finally:
            app.dependency_overrides.clear()
    finally:
        await engine.dispose()


# ─── 워커: _process_one_comment_reply_command ────────────────────────────────


async def _submit_and_approve_reply(s, *, org_id, human_id, comment):
    from app.services.channel_post_comment_replies import create_comment_reply_draft, submit_comment_reply
    from app.services.gate_service import transition_gate

    draft = await create_comment_reply_draft(
        s, org_id=org_id, comment_id=comment.id, text="답변 본문", created_by_member_id=human_id,
        created_by_kind="human",
    )
    reply = await submit_comment_reply(s, org_id=org_id, reply_id=draft.id, requester_member_id=human_id)
    await transition_gate(s, org_id, reply.gate_id, "approved", human_id, "승인")
    await s.commit()
    return reply


@pytest.mark.anyio
async def test_worker_sends_reply_via_sandbox_and_marks_sent(monkeypatch):
    from app.models.channel_post_comment import ChannelPostCommentReply
    from app.models.publication_command import PublicationCommand
    from app.services.publication_command import process_due_publication_commands
    import app.services.sandbox_publish as sandbox_publish
    from sqlalchemy import select

    async def _fake_reply(client, *, access_token, threads_user_id, reply_to_id, text):
        return f"sandbox-reply-{reply_to_id}", f"https://sandbox.invalid/reply/{reply_to_id}"

    monkeypatch.setattr(sandbox_publish, "reply", _fake_reply)

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org_id, project_id = await _seed_org(s)
            await _seed_default_role(s, org_id)
            human_id, _ = await _seed_human(s, org_id, role="owner")
            _, _, _, pub = await _seed_full_publication_chain(s, org_id=org_id, project_id=project_id)
            comment = await _seed_comment(s, org_id=org_id, publication_id=pub.id, external_comment_id="ext-c1")

            reply = await _submit_and_approve_reply(s, org_id=org_id, human_id=human_id, comment=comment)

            counts = await process_due_publication_commands(s)
            assert counts.get("completed", 0) >= 1 or counts.get("processed", 0) >= 1, counts

            updated_reply = (await s.execute(
                select(ChannelPostCommentReply).where(ChannelPostCommentReply.id == reply.id)
            )).scalar_one()
            assert updated_reply.status == "sent"
            assert updated_reply.external_reply_id == "sandbox-reply-ext-c1"
            assert updated_reply.external_reply_url == "https://sandbox.invalid/reply/ext-c1"

            command = (await s.execute(
                select(PublicationCommand).where(PublicationCommand.gate_id == reply.gate_id)
            )).scalar_one()
            assert command.status == "completed"
    finally:
        await engine.dispose()


@pytest.mark.anyio
async def test_worker_voids_command_when_target_deleted_before_processing():
    from app.models.channel_post_comment import ChannelPostComment, ChannelPostCommentReply
    from app.models.publication_command import PublicationCommand
    from app.services.publication_command import process_due_publication_commands
    from sqlalchemy import select

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org_id, project_id = await _seed_org(s)
            await _seed_default_role(s, org_id)
            human_id, _ = await _seed_human(s, org_id, role="owner")
            _, _, _, pub = await _seed_full_publication_chain(s, org_id=org_id, project_id=project_id)
            comment = await _seed_comment(s, org_id=org_id, publication_id=pub.id, external_comment_id="ext-c2")

            reply = await _submit_and_approve_reply(s, org_id=org_id, human_id=human_id, comment=comment)

            # 승인 뒤·워커 도달 前 레이스 — 대상 댓글이 지워짐.
            comment_row = (await s.execute(
                select(ChannelPostComment).where(ChannelPostComment.id == comment.id)
            )).scalar_one()
            comment_row.deleted_at = datetime.now(timezone.utc)
            await s.commit()

            await process_due_publication_commands(s)

            updated_reply = (await s.execute(
                select(ChannelPostCommentReply).where(ChannelPostCommentReply.id == reply.id)
            )).scalar_one()
            assert updated_reply.status == "failed"

            command = (await s.execute(
                select(PublicationCommand).where(PublicationCommand.gate_id == reply.gate_id)
            )).scalar_one()
            assert command.status == "voided"
            assert command.reason_code == "TARGET_COMMENT_DELETED"
    finally:
        await engine.dispose()


# ─── get_comment_reply_view: target_comment_state 읽기 시 계산 ───────────────


@pytest.mark.anyio
async def test_get_comment_reply_view_reports_changed_after_edit():
    from app.services.channel_post_comment_replies import get_comment_reply_view
    from app.models.channel_post_comment import ChannelPostComment
    from sqlalchemy import select

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org_id, project_id = await _seed_org(s)
            await _seed_default_role(s, org_id)
            human_id, _ = await _seed_human(s, org_id, role="owner")
            _, _, _, pub = await _seed_full_publication_chain(s, org_id=org_id, project_id=project_id)
            comment = await _seed_comment(s, org_id=org_id, publication_id=pub.id)

            reply = await _submit_and_approve_reply(s, org_id=org_id, human_id=human_id, comment=comment)

            before = await get_comment_reply_view(s, org_id=org_id, reply_id=reply.id)
            assert before["target_comment_state"] == "current"

            comment_row = (await s.execute(
                select(ChannelPostComment).where(ChannelPostComment.id == comment.id)
            )).scalar_one()
            import hashlib

            comment_row.text = "편집됨"
            comment_row.text_sha256 = hashlib.sha256("편집됨".encode("utf-8")).hexdigest()
            await s.commit()

            after = await get_comment_reply_view(s, org_id=org_id, reply_id=reply.id)
            assert after["target_comment_state"] == "changed"
    finally:
        await engine.dispose()


# ─── API: draft는 에이전트 가능·submit은 human-only ──────────────────────────


@pytest.mark.anyio
async def test_api_create_draft_allows_agent_but_submit_rejects_agent():
    from app.main import app

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org_id, project_id = await _seed_org(s)
            await _seed_default_role(s, org_id)
            agent_id = await _seed_agent(s, org_id, project_id)
            _, _, _, pub = await _seed_full_publication_chain(s, org_id=org_id, project_id=project_id)
            comment = await _seed_comment(s, org_id=org_id, publication_id=pub.id)

        _setup_org_scoped_app(app, Session, org_id, user_id=agent_id, agent=True)
        try:
            async with _client_for(app) as client:
                resp = await client.post(
                    f"/api/v2/organizations/{org_id}/comments/{comment.id}/replies", json={"text": "에이전트 초안"},
                )
                assert resp.status_code == 201, resp.text
                reply_id = resp.json()["id"]

                resp2 = await client.post(
                    f"/api/v2/organizations/{org_id}/comments/{comment.id}/replies/{reply_id}/submit",
                )
                assert resp2.status_code == 403
                assert resp2.json()["error"]["code"] == "COMMENT_REPLY_HUMAN_ONLY"
        finally:
            app.dependency_overrides.clear()
    finally:
        await engine.dispose()


# ─── 보드: channel_post_draft_id·comments_last_collected_at·comments_supported ─


@pytest.mark.anyio
async def test_insights_board_carries_three_comment_signal_fields():
    from app.services.insights_board import list_insights_board
    from app.services.channel_post_comments import refresh_comments_now
    import app.services.sandbox_publish as sandbox_publish
    from app.models.channel_post_draft import ChannelPostDraft
    from app.models.channel_post_version import ChannelPostVersion

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org_id, project_id = await _seed_org(s)
            work_item_id, gate, conn, pub = await _seed_full_publication_chain(s, org_id=org_id, project_id=project_id)

            draft = ChannelPostDraft(
                id=uuid.uuid4(), org_id=org_id, work_item_id=work_item_id, connection_id=conn.id, channel="sandbox",
            )
            s.add(draft)
            await s.flush()
            version = ChannelPostVersion(
                id=pub.version_id, draft_id=draft.id, version=1, text="본문", body_sha256="x",
                author_member_id=uuid.uuid4(), author_kind="human",
            )
            s.add(version)
            await s.commit()

            async def _fetch(client, *, access_token, media_id):
                return [_fake_comment("c1")], True

            monkeypatch_target = sandbox_publish
            monkeypatch_target.fetch_replies = _fetch
            await refresh_comments_now(s, org_id=org_id, publication_id=pub.id)

            result = await list_insights_board(
                s, org_id=org_id, window="30d", channel=None, status=None, sort="published_at", sort_dir="desc",
                cursor=None, limit=50,
            )
            row = next(r for r in result["rows"] if r["publication_id"] == pub.id)
            assert row["channel_post_draft_id"] == draft.id
            assert row["comments_last_collected_at"] is not None
            assert row["comments_supported"] is True
    finally:
        await engine.dispose()


@pytest.mark.anyio
async def test_insights_board_comments_supported_false_for_unsupported_channel():
    from app.services.insights_board import list_insights_board

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org_id, project_id = await _seed_org(s)
            _, _, _, pub = await _seed_full_publication_chain(s, org_id=org_id, project_id=project_id, channel="wordpress")

            result = await list_insights_board(
                s, org_id=org_id, window="30d", channel=None, status=None, sort="published_at", sort_dir="desc",
                cursor=None, limit=50,
            )
            row = next(r for r in result["rows"] if r["publication_id"] == pub.id)
            assert row["comments_supported"] is False
            assert row["comments_last_collected_at"] is None
            assert row["channel_post_draft_id"] is None, "wordpress publication의 version_id는 SitePostVersion을 가리켜 ChannelPostVersion 조인이 안 맞는다"
    finally:
        await engine.dispose()
