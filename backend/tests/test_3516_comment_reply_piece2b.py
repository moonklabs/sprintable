"""story #3516 조각②-b(additive, 미르코 3517② 그라운딩 갭 2026-09-06 · 유나
16회차) — 댓글 목록 GET `reply{id,status,external_reply_url,command_id}|null`
(배치 조인, N+1 X) · ReplyView `command_id`/`target_text` additive · 목록
`comments_next_allowed_at`(429 창 미리 앎) · submit 시 `neutral_facts.target_text`
저장(§22-⑤ 「봉인 축 셋」의 세 번째 — 대상 댓글 본문 표시용).

세팅 헬퍼는 test_3516_comment_reply.py(조각②)와 동형(중복 재발명 금지)."""
from __future__ import annotations

import hashlib
import os
import uuid
from datetime import datetime, timedelta, timezone

import pytest

from tests.test_e4fc29fa_site_post_orchestration import (
    _seed_default_role, _seed_human, _seed_org, _session_factory,
)
from tests.test_3497_insight_snapshots import _seed_channel_connection
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


# ─── command_id 백필(게이트 승인 훅) ──────────────────────────────────────────


@pytest.mark.anyio
async def test_command_id_backfilled_on_gate_approval():
    """뿌리 원인 수정 — 조각②부터 모델엔 있었지만 승인 훅이 한 번도 채운 적 없던
    reply.command_id를 이제 채운다(FE "발송 대기" 판정의 실제 근거)."""
    from app.models.channel_post_comment import ChannelPostCommentReply
    from app.models.publication_command import PublicationCommand
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

            refreshed = await s.get(ChannelPostCommentReply, reply.id)
            command = (await s.execute(
                select(PublicationCommand).where(PublicationCommand.gate_id == reply.gate_id)
            )).scalar_one()
            assert refreshed.command_id == command.id
    finally:
        await engine.dispose()


@pytest.mark.anyio
async def test_command_id_backfill_is_idempotent_on_second_approval_attempt():
    """뮤테이션류 자가검증 — 멱등 재호출(이미 명령이 있는 상태)에도 같은 값을
    다시 대입할 뿐 에러가 안 나야 한다(create_or_get_publication_command의 기존
    멱등 계약과 어긋나면 안 됨)."""
    from app.services.gate_service import _maybe_create_scheduled_publication_command
    from app.models.gate import Gate

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org_id, project_id = await _seed_org(s)
            await _seed_default_role(s, org_id)
            human_id, _ = await _seed_human(s, org_id, role="owner")
            _, _, _, pub = await _seed_full_publication_chain(s, org_id=org_id, project_id=project_id)
            comment = await _seed_comment(s, org_id=org_id, publication_id=pub.id)

            reply = await _submit_and_approve_reply(s, org_id=org_id, human_id=human_id, comment=comment)
            first_command_id = reply.command_id

            gate = await s.get(Gate, reply.gate_id)
            await _maybe_create_scheduled_publication_command(s, gate, human_id)  # 재호출 — 에러 없이 통과해야.
            await s.commit()

            from app.models.channel_post_comment import ChannelPostCommentReply
            refreshed = await s.get(ChannelPostCommentReply, reply.id)
            assert refreshed.command_id == first_command_id
    finally:
        await engine.dispose()


# ─── ReplyView: command_id·target_text ────────────────────────────────────────


@pytest.mark.anyio
async def test_reply_view_target_text_is_null_before_submit_and_set_after():
    from app.main import app

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org_id, project_id = await _seed_org(s)
            await _seed_default_role(s, org_id)
            human_id, _ = await _seed_human(s, org_id, role="owner")
            _, _, _, pub = await _seed_full_publication_chain(s, org_id=org_id, project_id=project_id)
            comment = await _seed_comment(s, org_id=org_id, publication_id=pub.id, text="원본 댓글 본문")

        _setup_org_scoped_app(app, Session, org_id, user_id=human_id, agent=False)
        try:
            async with _client_for(app) as client:
                r_draft = await client.post(
                    f"/api/v2/organizations/{org_id}/comments/{comment.id}/replies", json={"text": "답변 초안"},
                )
                assert r_draft.status_code == 201, r_draft.text
                assert r_draft.json()["target_text"] is None
                assert r_draft.json()["command_id"] is None
                reply_id = r_draft.json()["id"]

                r_submit = await client.post(
                    f"/api/v2/organizations/{org_id}/comments/{comment.id}/replies/{reply_id}/submit",
                )
                assert r_submit.status_code == 200, r_submit.text
                assert r_submit.json()["target_text"] == "원본 댓글 본문"
                assert r_submit.json()["command_id"] is None  # 승인 前엔 아직 명령 0.
        finally:
            app.dependency_overrides.clear()
    finally:
        await engine.dispose()


@pytest.mark.anyio
async def test_reply_view_command_id_appears_after_approval():
    from app.main import app

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org_id, project_id = await _seed_org(s)
            await _seed_default_role(s, org_id)
            human_id, _ = await _seed_human(s, org_id, role="owner")
            _, _, _, pub = await _seed_full_publication_chain(s, org_id=org_id, project_id=project_id)
            comment = await _seed_comment(s, org_id=org_id, publication_id=pub.id)

            reply = await _submit_and_approve_reply(s, org_id=org_id, human_id=human_id, comment=comment)

        _setup_org_scoped_app(app, Session, org_id, user_id=human_id, agent=False)
        try:
            async with _client_for(app) as client:
                r_get = await client.get(f"/api/v2/organizations/{org_id}/comments/{comment.id}/replies/{reply.id}")
                assert r_get.status_code == 200, r_get.text
                assert r_get.json()["command_id"] is not None
                assert r_get.json()["status"] == "pending"
        finally:
            app.dependency_overrides.clear()
    finally:
        await engine.dispose()


# ─── 댓글 목록: reply 배치 조인(N+1 X) ────────────────────────────────────────


@pytest.mark.anyio
async def test_comment_list_reply_summary_null_for_unreplied_and_populated_for_replied():
    from app.services.channel_post_comments import list_comments_for_publication

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org_id, project_id = await _seed_org(s)
            await _seed_default_role(s, org_id)
            human_id, _ = await _seed_human(s, org_id, role="owner")
            _, _, _, pub = await _seed_full_publication_chain(s, org_id=org_id, project_id=project_id)
            unreplied = await _seed_comment(s, org_id=org_id, publication_id=pub.id, external_comment_id="c-no-reply")
            replied = await _seed_comment(s, org_id=org_id, publication_id=pub.id, external_comment_id="c-has-reply")

            reply = await _submit_and_approve_reply(s, org_id=org_id, human_id=human_id, comment=replied)

            result = await list_comments_for_publication(s, org_id=org_id, publication_id=pub.id)
            reply_by_comment_id = result["reply_by_comment_id"]

            assert unreplied.id not in reply_by_comment_id
            assert replied.id in reply_by_comment_id
            summary = reply_by_comment_id[replied.id]
            assert summary.id == reply.id
            assert summary.status == "pending"
            assert summary.command_id is not None
    finally:
        await engine.dispose()


@pytest.mark.anyio
async def test_comment_list_reply_summary_picks_latest_of_multiple_drafts():
    """댓글 1건에 초안 답변을 2개 만들면(재상신 API가 없어 "새 초안" 관례,
    스토리 본문 명시) 배치 조인이 **created_at 최신** 1건만 내야 한다.

    카디르 뮤테이션 발견(2026-09-06, 페드루 판단) — 원래 이 테스트는 두 초안을
    삽입 순서 그대로(먼저 만든 게 물리적으로도 먼저) 만들어, `_latest_reply_
    by_comment_ids`의 `rn==1` 필터(ORDER BY created_at DESC)를 완전히 빼도
    "마지막 삽입 행이 우연히 마지막에 옴"이라는 Postgres 물리 순서 우연으로
    초록이 나왔다 — ORDER BY 자체를 검증한 게 아니었다. 여기서는 **물리
    삽입 순서와 created_at 순서를 일부러 어긋나게** 만든다(나중에 삽입한
    행에 더 이른 created_at을 명시로 대입) — `rn==1` 필터를 빼면 이제
    확실히 RED, 있으면 초록이어야 진짜 검증."""
    from app.services.channel_post_comment_replies import create_comment_reply_draft
    from app.services.channel_post_comments import list_comments_for_publication

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org_id, project_id = await _seed_org(s)
            await _seed_default_role(s, org_id)
            human_id, _ = await _seed_human(s, org_id, role="owner")
            _, _, _, pub = await _seed_full_publication_chain(s, org_id=org_id, project_id=project_id)
            comment = await _seed_comment(s, org_id=org_id, publication_id=pub.id)

            # 물리 삽입 순서: newer_by_time(진짜 최신) 먼저 → older_by_time(진짜
            # 과거) 나중 — 물리 순서 기준 "마지막 삽입 행"은 older_by_time이라,
            # rn==1 필터 없이 dict comprehension(마지막 행 승리)만 쓰면 이제
            # older_by_time이 잘못 선택돼야 정상(=RED 재현).
            newer_by_time = await create_comment_reply_draft(
                s, org_id=org_id, comment_id=comment.id, text="진짜 최신(먼저 삽입)",
                created_by_member_id=human_id, created_by_kind="human",
            )
            older_by_time = await create_comment_reply_draft(
                s, org_id=org_id, comment_id=comment.id, text="진짜 과거(나중 삽입)",
                created_by_member_id=human_id, created_by_kind="human",
            )
            newer_by_time.created_at = datetime.now(timezone.utc)
            older_by_time.created_at = datetime.now(timezone.utc) - timedelta(days=1)
            await s.commit()

            result = await list_comments_for_publication(s, org_id=org_id, publication_id=pub.id)
            summary = result["reply_by_comment_id"][comment.id]
            assert summary.id == newer_by_time.id, "created_at 최신 답변이 나와야 함(물리 삽입 순서와 무관)"
            assert summary.id != older_by_time.id
    finally:
        await engine.dispose()


# ─── 댓글 목록: comments_next_allowed_at ──────────────────────────────────────


@pytest.mark.anyio
async def test_comments_next_allowed_at_null_when_never_collected():
    from app.services.channel_post_comments import list_comments_for_publication

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org_id, project_id = await _seed_org(s)
            _, _, _, pub = await _seed_full_publication_chain(s, org_id=org_id, project_id=project_id)

            result = await list_comments_for_publication(s, org_id=org_id, publication_id=pub.id)
            assert result["comments_next_allowed_at"] is None
    finally:
        await engine.dispose()


@pytest.mark.anyio
async def test_comments_next_allowed_at_set_within_5min_window():
    from app.models.channel_post_comment import CommentCollectionSchedule
    from app.services.channel_post_comments import list_comments_for_publication

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org_id, project_id = await _seed_org(s)
            _, _, _, pub = await _seed_full_publication_chain(s, org_id=org_id, project_id=project_id)

            captured_at = datetime.now(timezone.utc) - timedelta(minutes=2)  # 5분 창 안.
            s.add(CommentCollectionSchedule(
                id=uuid.uuid4(), org_id=org_id, publication_id=pub.id, channel=pub.channel,
                external_id=pub.external_id, due_at=captured_at, captured_at=captured_at, status="captured",
            ))
            await s.commit()

            result = await list_comments_for_publication(s, org_id=org_id, publication_id=pub.id)
            assert result["comments_next_allowed_at"] is not None
            expected = captured_at + timedelta(minutes=5)
            assert abs((result["comments_next_allowed_at"] - expected).total_seconds()) < 2
    finally:
        await engine.dispose()


@pytest.mark.anyio
async def test_comments_next_allowed_at_null_after_5min_elapsed():
    from app.models.channel_post_comment import CommentCollectionSchedule
    from app.services.channel_post_comments import list_comments_for_publication

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org_id, project_id = await _seed_org(s)
            _, _, _, pub = await _seed_full_publication_chain(s, org_id=org_id, project_id=project_id)

            captured_at = datetime.now(timezone.utc) - timedelta(minutes=10)  # 창 지남.
            s.add(CommentCollectionSchedule(
                id=uuid.uuid4(), org_id=org_id, publication_id=pub.id, channel=pub.channel,
                external_id=pub.external_id, due_at=captured_at, captured_at=captured_at, status="captured",
            ))
            await s.commit()

            result = await list_comments_for_publication(s, org_id=org_id, publication_id=pub.id)
            assert result["comments_next_allowed_at"] is None
    finally:
        await engine.dispose()


# ─── HTTP e2e — 목록 응답에 reply·comments_next_allowed_at 실림 ──────────────


@pytest.mark.anyio
async def test_api_comment_list_includes_reply_and_next_allowed_at():
    from app.main import app

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org_id, project_id = await _seed_org(s)
            await _seed_default_role(s, org_id)
            human_id, _ = await _seed_human(s, org_id, role="owner")
            _, _, _, pub = await _seed_full_publication_chain(s, org_id=org_id, project_id=project_id)
            comment = await _seed_comment(s, org_id=org_id, publication_id=pub.id)
            reply = await _submit_and_approve_reply(s, org_id=org_id, human_id=human_id, comment=comment)

        _setup_org_scoped_app(app, Session, org_id, user_id=human_id, agent=False)
        try:
            async with _client_for(app) as client:
                resp = await client.get(f"/api/v2/organizations/{org_id}/publications/{pub.id}/comments")
                assert resp.status_code == 200, resp.text
                body = resp.json()
                assert "comments_next_allowed_at" in body
                item = next(c for c in body["comments"] if c["id"] == str(comment.id))
                assert item["reply"]["id"] == str(reply.id)
                assert item["reply"]["command_id"] is not None
        finally:
            app.dependency_overrides.clear()
    finally:
        await engine.dispose()
