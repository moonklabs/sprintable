"""story #4258 — 레시피 문맥의 서버 비동기 발행이 사람 손이 필요한 멈춤(dead_letter · 연결 끊김 blocked)이 되면 실패 통지
(`preset.recipe.publish_failed`) 1 — 그 발행을 연 게이트를 실제로 승인한 사람 ∪ 요청 stage에 바인딩된 에이전트에게.
레시피는 다음 단계로 넘어가지 않는다. 아직 재시도가 도는 일시 실패는 통지 0.

경로 셋(전수 · PR 본문 표): 뉴스레터 발송 · 채널 게시 · 외부 블로그. 하네스는 경로마다 기존 것 그대로(4242 뉴스레터 · 4093 채널
예약 발행 · 4192 외부 블로그). 통지 정의는 이 PR의 시드 마이그레이션 `upgrade()`를 그대로 실행해 심는다(create_all 하네스).
"""
from __future__ import annotations

import os
import uuid
from datetime import datetime, timedelta, timezone

import pytest

_REAL_DB_URL = os.getenv("PARITY_TEST_DATABASE_URL") or os.getenv("ALEMBIC_DATABASE_URL")

pytestmark = [
    pytest.mark.destructive_schema,
    pytest.mark.skipif(not _REAL_DB_URL, reason="real Postgres 필요"),
]

_NOTICE_KEY = "preset.recipe.publish_failed"


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
    from cryptography.fernet import Fernet

    import app.core.config as config_module
    from app.services.channel_credential_crypto import _get_multi_fernet

    monkeypatch.setattr(config_module.settings, "channel_credential_encryption_key", Fernet.generate_key().decode())
    _get_multi_fernet.cache_clear()
    yield
    _get_multi_fernet.cache_clear()


def _install_notice_definition() -> None:
    """이 PR의 시드 마이그레이션(`preset.recipe.publish_failed`)의 시드 단계를 alembic과 같은 동기 드라이버로 그대로. 스키마 쪽
    (`stop_notice_state` 컬럼 · CHECK · 인덱스)은 create_all 하네스가 모델 미러로 이미 갖고 있다."""
    import importlib.util
    from pathlib import Path

    from alembic.migration import MigrationContext
    from alembic.operations import Operations
    from sqlalchemy import create_engine

    path = next((Path(__file__).resolve().parents[1] / "alembic" / "versions").glob("*_preset_recipe_publish_failed.py"))
    spec = importlib.util.spec_from_file_location("_m_publish_failed_4258", path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    url = _REAL_DB_URL
    for prefix in ("postgresql+asyncpg://", "postgresql://"):
        if url.startswith(prefix):
            url = "postgresql+psycopg2://" + url[len(prefix):]
            break
    engine = create_engine(url)
    try:
        with engine.begin() as conn, Operations.context(MigrationContext.configure(connection=conn)):
            module.seed_notice_definition()
    finally:
        engine.dispose()


async def _notices(Session, org_id):
    from sqlalchemy import select, text

    from app.models.conversation import Conversation, ConversationMessage

    async with Session() as s:
        return (await s.execute(
            select(ConversationMessage).join(Conversation, Conversation.id == ConversationMessage.conversation_id).where(
                Conversation.org_id == org_id,
                text("conversation_messages.metadata->'event'->>'event_key' = :k"),
            ).params(k=_NOTICE_KEY)
        )).scalars().all()


async def _notice_recipients(Session, org_id, message) -> set:
    from app.services.event_routing_resolver import _resolve_recipe_publish_failure

    async with Session() as s:
        return await _resolve_recipe_publish_failure(s, org_id=org_id, payload=message.msg_metadata["event"]["payload"])


# ── 뉴스레터 발송 ──────────────────────────────────────────────────────────────────────────────────────


@pytest.mark.anyio
async def test_newsletter_send_dead_letter_notifies_approver_and_send_agent_and_does_not_advance():
    """뉴스레터 발송이 sandbox 발송 실패로 dead_letter → 통지 1(승인자 owner ∪ 발송 요청 담당 에이전트) · send_checked 0.
    발송 코드는 매핑표 밖이라 needs_check(«나갔는지 모름») · 앱에 재시도 자리가 없어 «아직 다시 시도할 수 없어요»."""
    from fastapi import BackgroundTasks

    from app.routers.events import EventPublishRequest, publish_registry_event
    from app.services.i18n_catalog import t
    from app.services.newsletter_send_execution import process_due_newsletter_sends
    from app.services.publication_command import process_due_publication_commands
    from tests.test_3312_approve_stage_gate_auto_creation import _auth, _fake_request
    from tests.test_3806_ads_boost_gate import _approve_gate
    from tests.test_4214_newsletter_send_recipe_stage_realdb import _stage_event_count
    from tests.test_4242_server_stage_routes_to_next_agent_realdb import _SEED, _bind_agent, _setup_newsletter
    from tests.test_e4fc29fa_site_post_orchestration import _session_factory

    engine, Session = await _session_factory()
    try:
        _install_notice_definition()
        ctx = await _setup_newsletter(Session)
        await _bind_agent(Session, ctx, definition_key=_SEED._KEY, stage="send_requested", agent_id=ctx["sender_id"])
        scheduled_at = datetime.now(timezone.utc) + timedelta(hours=2)
        async with Session() as s:
            await publish_registry_event(
                EventPublishRequest(definition_key=_SEED._KEY, payload={
                    "stage": "send_requested", "work_item_type": "story", "work_item_id": str(ctx["story_id"]),
                    "publication_id": str(ctx["pub"].id), "segment_name": "[sandbox:send-failed] 수신 목록",
                    "scheduled_at": scheduled_at.isoformat(),
                }),
                BackgroundTasks(), _fake_request(), db=s, auth=_auth(ctx["sender_id"], ctx["org_id"]), org_id=ctx["org_id"],
            )
            await s.commit()
        from sqlalchemy import select

        from app.models.gate import Gate

        async with Session() as s:
            gate = (await s.execute(
                select(Gate).where(Gate.org_id == ctx["org_id"], Gate.gate_type == "newsletter_send")
            )).scalar_one()
            await _approve_gate(s, gate.id, ctx["owner_member_id"])
        async with Session() as s:
            assert (await process_due_newsletter_sends(s, now=scheduled_at + timedelta(minutes=1))).get("queued") == 1
        async with Session() as s:
            counts = await process_due_publication_commands(s, now=scheduled_at + timedelta(minutes=2))
        assert counts["dead_letter"] == 1, counts

        notices = await _notices(Session, ctx["org_id"])
        assert len(notices) == 1, "dead_letter인데 레시피 실패 통지가 정확히 1이 아니다"
        assert await _notice_recipients(Session, ctx["org_id"], notices[0]) == {ctx["owner_member_id"], ctx["sender_id"]}
        payload = notices[0].msg_metadata["event"]["payload"]
        assert payload["stop_kind"] == "dead_letter" and payload["stage"] == "send_requested"
        assert t("events.recipe_publish_failed_what_newsletter_send", "ko") in notices[0].content
        # story #4262 AC2 — 발송 게이트 상세에 사람 재시도 자리가 섰다. «아직 앱에서 다시 시도할 수 없어요» 대신 그 자리로의 링크 줄
        # (needs_check · 채널에서 확인 뒤 다시 시도 — 발송 코드는 보냈는지 모름).
        assert t("events.recipe_publish_failed_next_newsletter_unavailable", "ko") not in notices[0].content
        assert t("events.recipe_publish_failed_next_needs_check", "ko", retry_url=f"/gates/{gate.id}") in notices[0].content
        assert await _stage_event_count(Session, {**ctx, "definition_key": _SEED._KEY}, "send_checked") == 0
    finally:
        await engine.dispose()


# ── 채널 게시(예약 발행 워커) ──────────────────────────────────────────────────────────────────────────


async def _channel_world(Session, *, text: str):
    from app.services.channel_posts import create_channel_post_draft_version, submit_channel_post_draft
    from app.services.gate_service import transition_gate
    from tests.conftest import seed_org_with_human_owner
    from tests.recipe_reviewed_draft import reviewed_draft_for
    from tests.test_4093_scheduled_publish_event_realdb import (
        _seed_agent, _seed_default_role, _seed_definition, _seed_recipe_channel_binding, _seed_sandbox_connection,
        _seed_story, _seed_system_publisher_teammember_shim, _walk_to_pending_approval_with_abc_approved,
    )

    async with Session() as s:
        org_id, project_id, owner_member_id = await seed_org_with_human_owner(
            s, slug=f"p4258-{uuid.uuid4().hex[:6]}", org_name="Org4258",
        )
        await _seed_default_role(s, org_id)
        await _seed_system_publisher_teammember_shim(s, org_id, project_id)
        creator_id = await _seed_agent(s, org_id, project_id, name="댄")
        story_id = await _seed_story(s, org_id, project_id)
        await _seed_definition(s)
        connection_id = await _seed_sandbox_connection(s, org_id)
        await _seed_recipe_channel_binding(s, org_id, connection_id)
        gate_d_id = await _walk_to_pending_approval_with_abc_approved(
            s, org_id=org_id, story_id=story_id, creator_id=creator_id, owner_member_id=owner_member_id,
        )
        version, _channel, _violations = await create_channel_post_draft_version(
            s, org_id=org_id, work_item_id=story_id, connection_id=connection_id,
            text=text, link_url=None, author_member_id=creator_id, author_kind="agent",
        )
        await submit_channel_post_draft(
            s, org_id=org_id, draft_id=version.draft_id, version_id=None, requester_member_id=creator_id,
            scheduled_at=datetime.now(timezone.utc) + timedelta(minutes=5),
        )
        await transition_gate(
            s, org_id, gate_d_id, "approved", owner_member_id, "발행 승인",
            reviewed_draft=await reviewed_draft_for(s, org_id=org_id, work_item_id=story_id),
        )
        await s.commit()
    return {
        "org_id": org_id, "owner_member_id": owner_member_id, "story_id": story_id, "connection_id": connection_id,
        "draft_id": version.draft_id,
    }


async def _run_channel_worker(Session):
    from app.services.publication_command import process_due_publication_commands

    async with Session() as s:
        return await process_due_publication_commands(s, now=datetime.now(timezone.utc) + timedelta(minutes=10))


async def _published_events(Session, w) -> int:
    from app.routers.events import _find_existing_stage_publish
    from tests.test_4093_scheduled_publish_event_realdb import _KEY

    async with Session() as s:
        return 0 if await _find_existing_stage_publish(
            s, org_id=w["org_id"], definition_key=_KEY, work_item_type="story", work_item_id=str(w["story_id"]),
            stage="published",
        ) is None else 1


async def _last_attempt(Session, w) -> None:
    """재시도 상한 한 번 전으로 둔다(test_3414 `test_cron_max_retries_reaches_dead_letter`와 같은 방식) — 이번 틱의 일시 실패가
    곧 재시도 소진(dead_letter)이 된다."""
    from sqlalchemy import update

    from app.models.publication_command import PublicationCommand
    from app.services.publication_command import MAX_RETRIES

    async with Session() as s:
        await s.execute(
            update(PublicationCommand).where(PublicationCommand.org_id == w["org_id"]).values(attempt_count=MAX_RETRIES - 1)
        )
        await s.commit()


@pytest.mark.anyio
async def test_channel_publish_retries_exhausted_dead_letter_notifies_approver_with_retry_link():
    """채널 게시가 일시 실패를 재시도 상한까지 되풀이해 dead_letter → 통지 1(승인자 owner) · «자동 재시도를 멈췄어요(코드 …)» ·
    채널 초안 화면 재시도 링크 · published 0. 뮤테이션: 워커의 통지 호출을 지우면 0 → RED."""
    from tests.test_4093_scheduled_publish_event_realdb import _realdb_session
    from app.services.i18n_catalog import t

    engine, Session = await _realdb_session()
    try:
        _install_notice_definition()
        w = await _channel_world(Session, text="[sandbox:provider-error] 본문")
        await _last_attempt(Session, w)
        counts = await _run_channel_worker(Session)
        assert counts["dead_letter"] == 1, counts

        notices = await _notices(Session, w["org_id"])
        assert len(notices) == 1
        assert await _notice_recipients(Session, w["org_id"], notices[0]) == {w["owner_member_id"]}
        content = notices[0].content
        payload = notices[0].msg_metadata["event"]["payload"]
        assert payload["failure_kind"] == "transient" and payload["reason_code"]
        assert t("events.recipe_publish_failed_what_channel_post", "ko") in content
        assert t("events.recipe_publish_failed_reason_dead_letter_code", "ko", code=payload["reason_code"]) in content
        assert t(
            "events.recipe_publish_failed_next_dead_letter", "ko", retry_url=f"/content/channel-posts/{w['draft_id']}",
        ) in content, content
        assert await _published_events(Session, w) == 0
    finally:
        await engine.dispose()


@pytest.mark.anyio
async def test_channel_publish_blocked_by_dropped_connection_notifies_with_reconnect_line():
    """예약 대기 중 연결이 끊겨(연결 비활성) blocked → 통지 1 · «연결 문제로 멈췄어요» · 재연결 뒤 다시 시도 줄."""
    from app.models.channel_connection import ChannelConnection
    from app.services.i18n_catalog import t
    from tests.test_4093_scheduled_publish_event_realdb import _realdb_session

    engine, Session = await _realdb_session()
    try:
        _install_notice_definition()
        w = await _channel_world(Session, text="연결 끊김 본문")
        async with Session() as s:
            connection = await s.get(ChannelConnection, w["connection_id"])
            connection.status = "expired"
            await s.commit()
        counts = await _run_channel_worker(Session)
        assert counts["blocked"] == 1, counts

        notices = await _notices(Session, w["org_id"])
        assert len(notices) == 1
        assert notices[0].msg_metadata["event"]["payload"]["stop_kind"] == "blocked"
        assert t("events.recipe_publish_failed_reason_blocked", "ko") in notices[0].content
        assert t(
            "events.recipe_publish_failed_next_blocked", "ko", retry_url=f"/content/channel-posts/{w['draft_id']}",
        ) in notices[0].content
        assert await _published_events(Session, w) == 0
    finally:
        await engine.dispose()


@pytest.mark.anyio
async def test_channel_publish_transient_failure_still_retrying_sends_no_notice():
    """일시 실패(공급자 오류 · transient) 첫 시도 → 재시도 대기(pending) → 통지 0(아직 도는 중)."""
    from tests.test_4093_scheduled_publish_event_realdb import _realdb_session

    engine, Session = await _realdb_session()
    try:
        _install_notice_definition()
        w = await _channel_world(Session, text="[sandbox:provider-error] 본문")
        counts = await _run_channel_worker(Session)
        assert counts["pending_retry"] == 1, counts
        assert await _notices(Session, w["org_id"]) == []
    finally:
        await engine.dispose()


# ── 외부 블로그(WordPress) ─────────────────────────────────────────────────────────────────────────────


@pytest.mark.anyio
async def test_external_blog_dead_letter_notifies_the_draft_gate_approver_with_the_draft_link():
    """외부 블로그 발행 명령이 도달 불가 사이트로 dead_letter → 통지 1(초안 게이트를 승인한 사람) · 글 초안 화면 링크 ·
    published 0."""
    from app.main import app
    from app.services.publication_command import process_due_publication_commands
    from tests.test_4192_site_publish_recipe_event_realdb import (
        _approve, _published_events, _session_factory, _submit_external, _walk_to_pending_approval, _walk_to_verification, _world,
    )

    engine, Session = await _session_factory()
    try:
        _install_notice_definition()
        w = await _world(Session)
        await _walk_to_verification(Session, w)
        gate_id, draft_id = await _submit_external(app, Session, w, "https://unreachable.invalid", "ext-fail-4258")
        await _walk_to_pending_approval(Session, w, draft_id=draft_id)
        await _approve(Session, w, gate_id)
        async with Session() as s:
            counts = await process_due_publication_commands(s)
            await s.commit()
        assert counts["dead_letter"] == 1, counts

        notices = await _notices(Session, w["org_id"])
        assert len(notices) == 1
        assert await _notice_recipients(Session, w["org_id"], notices[0]) == {w["human_id"]}
        assert f"/content/{draft_id}" in notices[0].content
        assert await _published_events(Session, w) == 0
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()


@pytest.mark.anyio
async def test_non_recipe_publish_dead_letter_sends_no_recipe_notice():
    """레시피 밖 발행(레시피 게이트 없는 채널 초안)이 dead_letter여도 레시피 통지는 0(추측 0)."""
    from tests.test_4093_scheduled_publish_event_realdb import _realdb_session
    from app.models.recipe_role_binding import RecipeRoleBinding
    from sqlalchemy import delete

    engine, Session = await _realdb_session()
    try:
        _install_notice_definition()
        w = await _channel_world(Session, text="[sandbox:provider-error] 본문")
        await _last_attempt(Session, w)
        # 바인딩이 사라지면 레시피 문맥 판정(resolve_recipe_context_for_scheduled_publication)이 None — 레시피 밖과 같은 모양.
        async with Session() as s:
            await s.execute(delete(RecipeRoleBinding).where(RecipeRoleBinding.org_id == w["org_id"]))
            await s.commit()
        counts = await _run_channel_worker(Session)
        assert counts["dead_letter"] == 1, counts
        assert await _notices(Session, w["org_id"]) == []
    finally:
        await engine.dispose()
