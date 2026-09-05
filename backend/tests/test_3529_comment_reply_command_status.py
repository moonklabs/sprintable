"""story #3529(additive, 유나 §22-15 채택 · 페드루 PO 確定 2026-09-06) — 댓글 답변
「왜 멈췄고 다음에 뭘 하나」. 서버가 이미 §11-5 세 값(connection/needs_check/
transient)으로 접어 command 상태(pending+next_attempt_at/blocked/dead_letter/
voided)로 보내는 축을 ReplyView·댓글 목록 reply{} 요약에 그대로 노출한다(새 컬럼
0·새 이름 0 — PublicationCommand.status·failure_kind·next_attempt_at·reason_code
그대로). 디디 그라운딩(2026-09-06 04:11 KST)이 확인한 실재 이름만 쓴다.

세팅 헬퍼는 test_3516_comment_reply.py(조각②)와 동형(중복 재발명 금지)."""
from __future__ import annotations

import os
import uuid
from datetime import datetime, timezone

import pytest

from tests.test_e4fc29fa_site_post_orchestration import (
    _seed_default_role, _seed_human, _seed_org, _session_factory,
)
from tests.test_3475_publishing_metrics import _client_for, _setup_org_scoped_app
from tests.test_3516_comment_reply import _seed_comment, _seed_full_publication_chain, _submit_and_approve_reply

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
    """test_3516_comment_reply.py와 동형 — supports_reply/fetch_replies=True로 등재."""
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


async def _get_reply_and_list_summary(client, org_id, comment_id, reply_id, publication_id):
    r_reply = await client.get(f"/api/v2/organizations/{org_id}/comments/{comment_id}/replies/{reply_id}")
    assert r_reply.status_code == 200, r_reply.text
    r_list = await client.get(f"/api/v2/organizations/{org_id}/publications/{publication_id}/comments")
    assert r_list.status_code == 200, r_list.text
    list_reply_summary = next(c["reply"] for c in r_list.json()["comments"] if c["id"] == str(comment_id))
    return r_reply.json(), list_reply_summary


def _assert_four_fields(payload, *, command_status, failure_kind, next_attempt_at_is_none, reason_code):
    assert payload["command_status"] == command_status, payload
    assert payload["failure_kind"] == failure_kind, payload
    assert (payload["next_attempt_at"] is None) == next_attempt_at_is_none, payload
    assert payload["reason_code"] == reason_code, payload


@pytest.mark.anyio
async def test_before_submit_all_four_fields_null():
    """command_id가 null(초안 상태)이면 4필드 전부 null."""
    from app.main import app

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org_id, project_id = await _seed_org(s)
            await _seed_default_role(s, org_id)
            human_id, _ = await _seed_human(s, org_id, role="owner")
            _, _, _, pub = await _seed_full_publication_chain(s, org_id=org_id, project_id=project_id)
            comment = await _seed_comment(s, org_id=org_id, publication_id=pub.id)

        _setup_org_scoped_app(app, Session, org_id, user_id=human_id, agent=False)
        try:
            async with _client_for(app) as client:
                r_draft = await client.post(
                    f"/api/v2/organizations/{org_id}/comments/{comment.id}/replies", json={"text": "답변 초안"},
                )
                assert r_draft.status_code == 201, r_draft.text
                assert r_draft.json()["command_id"] is None
                _assert_four_fields(
                    r_draft.json(), command_status=None, failure_kind=None,
                    next_attempt_at_is_none=True, reason_code=None,
                )
        finally:
            app.dependency_overrides.clear()
    finally:
        await engine.dispose()


@pytest.mark.anyio
async def test_transient_failure_exposes_pending_backoff(monkeypatch):
    """CHANNEL_RATE_LIMITED(429) → failure_kind=transient·command는 pending으로
    남고(MAX_RETRIES=5 미도달) next_attempt_at이 채워진다. reason_code는 voided
    전용이라 null 유지."""
    from app.main import app
    from app.services.threads_publish import ThreadsPublishError
    import app.services.sandbox_publish as sandbox_publish
    from app.services.publication_command import process_due_publication_commands

    async def _fake_reply(client, *, access_token, threads_user_id, reply_to_id, text):
        raise ThreadsPublishError("rate_limited", "요청이 너무 잦습니다", status_code=429)

    monkeypatch.setattr(sandbox_publish, "reply", _fake_reply)

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org_id, project_id = await _seed_org(s)
            await _seed_default_role(s, org_id)
            human_id, _ = await _seed_human(s, org_id, role="owner")
            _, _, _, pub = await _seed_full_publication_chain(s, org_id=org_id, project_id=project_id)
            comment = await _seed_comment(s, org_id=org_id, publication_id=pub.id, external_comment_id="ext-transient")
            reply = await _submit_and_approve_reply(s, org_id=org_id, human_id=human_id, comment=comment)
            await process_due_publication_commands(s)

        _setup_org_scoped_app(app, Session, org_id, user_id=human_id, agent=False)
        try:
            async with _client_for(app) as client:
                reply_payload, list_payload = await _get_reply_and_list_summary(
                    client, org_id, comment.id, reply.id, pub.id,
                )
                for payload in (reply_payload, list_payload):
                    _assert_four_fields(
                        payload, command_status="pending", failure_kind="transient",
                        next_attempt_at_is_none=False, reason_code=None,
                    )
        finally:
            app.dependency_overrides.clear()
    finally:
        await engine.dispose()


@pytest.mark.anyio
async def test_connection_failure_exposes_blocked_status(monkeypatch):
    """CHANNEL_TOKEN_EXPIRED(401) → failure_kind=connection·command는 blocked로
    멈춘다(재시도 큐 X, 연결 복구 대기)."""
    from app.main import app
    from app.services.threads_publish import ThreadsPublishError
    import app.services.sandbox_publish as sandbox_publish
    from app.services.publication_command import process_due_publication_commands

    async def _fake_reply(client, *, access_token, threads_user_id, reply_to_id, text):
        raise ThreadsPublishError("token_expired", "토큰이 만료되었습니다", status_code=401)

    monkeypatch.setattr(sandbox_publish, "reply", _fake_reply)

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org_id, project_id = await _seed_org(s)
            await _seed_default_role(s, org_id)
            human_id, _ = await _seed_human(s, org_id, role="owner")
            _, _, _, pub = await _seed_full_publication_chain(s, org_id=org_id, project_id=project_id)
            comment = await _seed_comment(s, org_id=org_id, publication_id=pub.id, external_comment_id="ext-blocked")
            reply = await _submit_and_approve_reply(s, org_id=org_id, human_id=human_id, comment=comment)
            await process_due_publication_commands(s)

        _setup_org_scoped_app(app, Session, org_id, user_id=human_id, agent=False)
        try:
            async with _client_for(app) as client:
                reply_payload, list_payload = await _get_reply_and_list_summary(
                    client, org_id, comment.id, reply.id, pub.id,
                )
                for payload in (reply_payload, list_payload):
                    _assert_four_fields(
                        payload, command_status="blocked", failure_kind="connection",
                        next_attempt_at_is_none=True, reason_code=None,
                    )
        finally:
            app.dependency_overrides.clear()
    finally:
        await engine.dispose()


@pytest.mark.anyio
async def test_comment_not_found_exposes_dead_letter_status():
    """대상 댓글 행 자체가 사라지면(COMMENT_NOT_FOUND) needs_check로 분류돼 즉시
    dead_letter(재시도해도 다시 실패할 뿐이라 백오프 큐에 안 넣는다).

    HTTP 왕복이 아니라 command 행을 직접 대조한다 — 이 시나리오(댓글 행 하드
    삭제)에선 GET reply 자체가 `get_comment_reply_view`의 `_get_owned_comment`가
    `CommentNotFoundError`를 던져(그 라우터는 `CommentReplyNotFoundError`만
    catch) 500이 나는 별개의 기존 갭이라(#3529 스코프 밖 — 이 스토리는 서버가 이미
    아는 상태를 노출만 하는 것이지 읽기 경로 자체를 고치는 게 아니다), 여기서는
    command 행이 곧 «검증 대상 진실»이므로 그걸 직접 본다."""
    from app.models.channel_post_comment import ChannelPostComment
    from app.models.publication_command import PublicationCommand
    from app.services.publication_command import process_due_publication_commands
    from sqlalchemy import delete, select

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org_id, project_id = await _seed_org(s)
            await _seed_default_role(s, org_id)
            human_id, _ = await _seed_human(s, org_id, role="owner")
            _, _, _, pub = await _seed_full_publication_chain(s, org_id=org_id, project_id=project_id)
            comment = await _seed_comment(s, org_id=org_id, publication_id=pub.id, external_comment_id="ext-notfound")
            reply = await _submit_and_approve_reply(s, org_id=org_id, human_id=human_id, comment=comment)

            # 승인 뒤·워커 도달 前 레이스를 극단으로 — 댓글 행 자체가 사라짐(하드
            # 삭제, FK 없음 관례 — 소프트 삭제(TARGET_COMMENT_DELETED)와는 다른 경로).
            await s.execute(delete(ChannelPostComment).where(ChannelPostComment.id == comment.id))
            await s.commit()

            await process_due_publication_commands(s)

            command = (await s.execute(
                select(PublicationCommand).where(PublicationCommand.gate_id == reply.gate_id)
            )).scalar_one()
            assert command.status == "dead_letter"
            assert command.failure_kind == "needs_check"
            assert command.next_attempt_at is None
            assert command.reason_code is None
    finally:
        await engine.dispose()


@pytest.mark.anyio
async def test_target_comment_deleted_exposes_voided_with_reason_code():
    """AC4 — 승인 뒤·워커 도달 前 대상 댓글이 소프트 삭제되면 voided+reason_code=
    TARGET_COMMENT_DELETED(재시도 대상 아님). voided 경로는 apply_command_failure를
    안 거치므로 failure_kind는 null로 남는다."""
    from app.main import app
    from app.models.channel_post_comment import ChannelPostComment
    from app.services.publication_command import process_due_publication_commands
    from sqlalchemy import select

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org_id, project_id = await _seed_org(s)
            await _seed_default_role(s, org_id)
            human_id, _ = await _seed_human(s, org_id, role="owner")
            _, _, _, pub = await _seed_full_publication_chain(s, org_id=org_id, project_id=project_id)
            comment = await _seed_comment(s, org_id=org_id, publication_id=pub.id, external_comment_id="ext-voided1")
            reply = await _submit_and_approve_reply(s, org_id=org_id, human_id=human_id, comment=comment)

            comment_row = (await s.execute(
                select(ChannelPostComment).where(ChannelPostComment.id == comment.id)
            )).scalar_one()
            comment_row.deleted_at = datetime.now(timezone.utc)
            await s.commit()

            await process_due_publication_commands(s)

        _setup_org_scoped_app(app, Session, org_id, user_id=human_id, agent=False)
        try:
            async with _client_for(app) as client:
                reply_payload, list_payload = await _get_reply_and_list_summary(
                    client, org_id, comment.id, reply.id, pub.id,
                )
                for payload in (reply_payload, list_payload):
                    _assert_four_fields(
                        payload, command_status="voided", failure_kind=None,
                        next_attempt_at_is_none=True, reason_code="TARGET_COMMENT_DELETED",
                    )
        finally:
            app.dependency_overrides.clear()
    finally:
        await engine.dispose()


@pytest.mark.anyio
async def test_gate_reseal_mismatch_exposes_voided_with_reason_code():
    """승인 뒤·워커 도달 前 답변 본문이 바뀌어(재상신 개념 없음이라 직접 대입으로
    레이스 재현) 봉인 sha와 어긋나면 voided+reason_code=GATE_NOT_APPROVED_OR_
    RESEALED(TARGET_COMMENT_DELETED와는 다른 voided 사유)."""
    from app.main import app
    from app.models.channel_post_comment import ChannelPostCommentReply
    from app.services.publication_command import process_due_publication_commands
    from sqlalchemy import select

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org_id, project_id = await _seed_org(s)
            await _seed_default_role(s, org_id)
            human_id, _ = await _seed_human(s, org_id, role="owner")
            _, _, _, pub = await _seed_full_publication_chain(s, org_id=org_id, project_id=project_id)
            comment = await _seed_comment(s, org_id=org_id, publication_id=pub.id, external_comment_id="ext-voided2")
            reply = await _submit_and_approve_reply(s, org_id=org_id, human_id=human_id, comment=comment)

            reply_row = (await s.execute(
                select(ChannelPostCommentReply).where(ChannelPostCommentReply.id == reply.id)
            )).scalar_one()
            reply_row.text = "봉인 이후 바뀐 본문(레이스 재현)"
            await s.commit()

            await process_due_publication_commands(s)

        _setup_org_scoped_app(app, Session, org_id, user_id=human_id, agent=False)
        try:
            async with _client_for(app) as client:
                reply_payload, list_payload = await _get_reply_and_list_summary(
                    client, org_id, comment.id, reply.id, pub.id,
                )
                for payload in (reply_payload, list_payload):
                    _assert_four_fields(
                        payload, command_status="voided", failure_kind=None,
                        next_attempt_at_is_none=True, reason_code="GATE_NOT_APPROVED_OR_RESEALED",
                    )
        finally:
            app.dependency_overrides.clear()
    finally:
        await engine.dispose()
