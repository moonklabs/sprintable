"""story #4262 — 뉴스레터 발송 실패 분류(②)와 연결 비활성 멈춤의 사람 재시도(③) — PO 13:49Z · 13:51Z.

② 두 뉴스레터 코드(`NEWSLETTER_SEND_CONNECTION_UNAVAILABLE` · `NEWSLETTER_SEND_CHANNEL_UNSUPPORTED`)는 «확실히 안 나감»(`not_sent`) —
   곧바로 dead_letter · 자동 재시도 0. 기존 세 값의 매핑은 그대로.
③ 연결이 비활성이면 발송 명령은 `blocked_unapproved`로 서고 사유 코드가 남는다. 뉴스레터에 한해 사람이 재시도할 수 있고, 연결을
   고친 뒤면 발송 1 · 안 고친 채면 다시 `blocked_unapproved`(무한 재시도 0). 다른 종류의 `blocked_unapproved`는 예전대로 거부.
"""
from __future__ import annotations

import os
import uuid
from datetime import datetime, timedelta, timezone

import pytest

_REAL_DB_URL = os.getenv("PARITY_TEST_DATABASE_URL") or os.getenv("ALEMBIC_DATABASE_URL")

# 파일 전체가 destructive 하네스(한 세션에 destructive · 비파괴를 섞지 않는 conftest 가드) — 앞의 순수 분류 테스트도 같은 파일에서 돈다.
pytestmark = [
    pytest.mark.destructive_schema,
    pytest.mark.skipif(not _REAL_DB_URL, reason="real Postgres 필요"),
]


@pytest.fixture
def anyio_backend():
    return "asyncio"


# ── ② 분류(순수 · DB 없음) ─────────────────────────────────────────────────────────────────────────────


def _command():
    from app.models.publication_command import PublicationCommand

    return PublicationCommand(
        id=uuid.uuid4(), org_id=uuid.uuid4(), gate_id=uuid.uuid4(), destination=uuid.uuid4(), approved_version=uuid.uuid4(),
        content_kind="newsletter_send", status="in_progress", attempt_count=0, requested_by_member_id=uuid.uuid4(),
    )


@pytest.mark.parametrize("code", ["NEWSLETTER_SEND_CONNECTION_UNAVAILABLE", "NEWSLETTER_SEND_CHANNEL_UNSUPPORTED"])
@pytest.mark.anyio
async def test_a_definitely_unsent_newsletter_code_stops_at_once_without_retries(code):
    """뮤테이션: `apply_command_failure`의 not_sent 갈래를 지우면 백오프 재시도(pending)로 떨어져 RED."""
    from app.services.publication_command import FAILURE_KIND_NOT_SENT, apply_command_failure, classify_failure_kind

    assert classify_failure_kind(code) == FAILURE_KIND_NOT_SENT
    command = _command()
    now = datetime.now(timezone.utc)
    await apply_command_failure(None, command, error_code=code, last_error="x", now=now)
    assert (command.status, command.failure_kind, command.reason_code) == ("dead_letter", "not_sent", code)
    assert command.next_attempt_at is None and command.dead_letter_at == now and command.attempt_count == 1


def test_existing_classification_is_unchanged():
    from app.services.publication_command import classify_failure_kind

    assert {
        code: classify_failure_kind(code) for code in (
            "CHANNEL_TOKEN_EXPIRED", "CHANNEL_CONNECTION_REVOKED", "CHANNEL_PUBLISH_PROVIDER_ERROR", "CHANNEL_RATE_LIMITED",
            "CHANNEL_PUBLISH_IN_PROGRESS", "INSTAGRAM_IMAGE_REQUIRED", "STIBEE_PLAN_RESTRICTED",
            "NEWSLETTER_SEND_PROVIDER_ERROR", "SOMETHING_UNKNOWN", None,
        )
    } == {
        "CHANNEL_TOKEN_EXPIRED": "connection", "CHANNEL_CONNECTION_REVOKED": "connection",
        "CHANNEL_PUBLISH_PROVIDER_ERROR": "transient", "CHANNEL_RATE_LIMITED": "transient",
        "CHANNEL_PUBLISH_IN_PROGRESS": "needs_check", "INSTAGRAM_IMAGE_REQUIRED": "needs_check",
        # 채널 게시와 겹치는 코드 · 보냈는지 모르는 코드는 이 카드에서 그대로(4264).
        "STIBEE_PLAN_RESTRICTED": "needs_check", "NEWSLETTER_SEND_PROVIDER_ERROR": "needs_check",
        "SOMETHING_UNKNOWN": "needs_check", None: "needs_check",
    }


# ── ③ 연결 비활성 → blocked_unapproved → 사람 재시도(실 PG) ────────────────────────────────────────────────


@pytest.fixture(autouse=True)
def _configure_secrets(monkeypatch):
    from cryptography.fernet import Fernet

    import app.core.config as config_module
    from app.services.channel_credential_crypto import _get_multi_fernet

    monkeypatch.setattr(config_module.settings, "channel_credential_encryption_key", Fernet.generate_key().decode())
    _get_multi_fernet.cache_clear()
    yield
    _get_multi_fernet.cache_clear()


@pytest.fixture(autouse=True)
async def _dispose_global_engine_after_test():
    yield
    from app.core.database import engine as _global_engine

    await _global_engine.dispose()


async def _blocked_send(Session):
    """발송 요청 → 발송 게이트 승인 → 크론이 명령을 만든 뒤 연결이 끊긴 채 워커가 돈다 → blocked_unapproved."""
    from fastapi import BackgroundTasks
    from sqlalchemy import select

    from app.models.gate import Gate
    from app.routers.events import EventPublishRequest, publish_registry_event
    from app.services.newsletter_send_execution import process_due_newsletter_sends
    from app.services.publication_command import process_due_publication_commands
    from tests.test_3312_approve_stage_gate_auto_creation import _auth, _fake_request
    from tests.test_3806_ads_boost_gate import _approve_gate
    from tests.test_4242_server_stage_routes_to_next_agent_realdb import _SEED, _bind_agent, _setup_newsletter

    ctx = await _setup_newsletter(Session)
    await _bind_agent(Session, ctx, definition_key=_SEED._KEY, stage="send_requested", agent_id=ctx["sender_id"])
    scheduled_at = datetime.now(timezone.utc) + timedelta(hours=2)
    async with Session() as s:
        await publish_registry_event(
            EventPublishRequest(definition_key=_SEED._KEY, payload={
                "stage": "send_requested", "work_item_type": "story", "work_item_id": str(ctx["story_id"]),
                "publication_id": str(ctx["pub"].id), "segment_name": "수신 목록", "scheduled_at": scheduled_at.isoformat(),
            }),
            BackgroundTasks(), _fake_request(), db=s, auth=_auth(ctx["sender_id"], ctx["org_id"]), org_id=ctx["org_id"],
        )
        await s.commit()
    async with Session() as s:
        gate = (await s.execute(select(Gate).where(Gate.org_id == ctx["org_id"], Gate.gate_type == "newsletter_send"))).scalar_one()
        await _approve_gate(s, gate.id, ctx["owner_member_id"])
    async with Session() as s:
        assert (await process_due_newsletter_sends(s, now=scheduled_at + timedelta(minutes=1))).get("queued") == 1
    await _set_connection(Session, ctx, "expired")
    async with Session() as s:
        await process_due_publication_commands(s, now=scheduled_at + timedelta(minutes=2))
    return ctx, scheduled_at


async def _set_connection(Session, ctx, status: str) -> None:
    from app.models.channel_connection import ChannelConnection

    async with Session() as s:
        conn = await s.get(ChannelConnection, ctx["pub"].connection_id)
        conn.status = status
        await s.commit()


async def _send_command(Session, ctx):
    from sqlalchemy import select

    from app.models.publication_command import PublicationCommand

    async with Session() as s:
        return (await s.execute(select(PublicationCommand).where(
            PublicationCommand.org_id == ctx["org_id"], PublicationCommand.content_kind == "newsletter_send",
        ))).scalar_one()


async def _retry(Session, ctx, command_id):
    from app.services.publication_command import retry_dead_letter_command

    async with Session() as s:
        result = await retry_dead_letter_command(s, org_id=ctx["org_id"], command_id=command_id)
        await s.commit()
        return result


async def _tick(Session, at):
    from app.services.publication_command import process_due_publication_commands

    async with Session() as s:
        return await process_due_publication_commands(s, now=at)


@pytest.mark.parametrize("fix_connection", [True, False])
@pytest.mark.anyio
async def test_a_connection_blocked_newsletter_send_can_be_retried_by_a_person(fix_connection):
    from tests.test_e4fc29fa_site_post_orchestration import _session_factory

    engine, Session = await _session_factory()
    try:
        ctx, scheduled_at = await _blocked_send(Session)
        command = await _send_command(Session, ctx)
        assert (command.status, command.reason_code) == ("blocked_unapproved", "NEWSLETTER_SEND_CONNECTION_UNAVAILABLE")

        if fix_connection:
            await _set_connection(Session, ctx, "active")
        assert await _retry(Session, ctx, command.id) is not None
        assert (await _send_command(Session, ctx)).status == "pending"
        await _tick(Session, scheduled_at + timedelta(minutes=5))
        after = await _send_command(Session, ctx)
        if fix_connection:
            assert after.status == "completed", "연결을 고친 뒤 재시도했는데 발송되지 않았다"
        else:
            assert (after.status, after.reason_code) == ("blocked_unapproved", "NEWSLETTER_SEND_CONNECTION_UNAVAILABLE")
    finally:
        await engine.dispose()


@pytest.mark.anyio
async def test_blocked_unapproved_of_other_kinds_is_still_not_retryable():
    """다른 종류(채널 게시)의 `blocked_unapproved`는 예전대로 재시도 거부(엔드포인트는 404). 뮤테이션: 종류 조건을 빼면 RED."""
    from app.models.publication_command import PublicationCommand
    from tests.test_e4fc29fa_site_post_orchestration import _seed_org, _session_factory

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org_id, _project_id = await _seed_org(s)
            command = PublicationCommand(
                id=uuid.uuid4(), org_id=org_id, gate_id=uuid.uuid4(), destination=uuid.uuid4(), approved_version=uuid.uuid4(),
                content_kind="channel_post", status="blocked_unapproved", requested_by_member_id=uuid.uuid4(),
            )
            s.add(command)
            await s.commit()
        assert await _retry(Session, {"org_id": org_id}, command.id) is None
    finally:
        await engine.dispose()


@pytest.mark.anyio
async def test_only_a_person_can_retry_through_the_endpoint():
    """재시도 엔드포인트는 사람 전용(에이전트 403) — 뉴스레터 blocked_unapproved를 받게 된 뒤에도 그대로."""
    from app.main import app
    from tests.test_3475_publishing_metrics import _client_for, _setup_org_scoped_app
    from tests.test_e4fc29fa_site_post_orchestration import _session_factory

    engine, Session = await _session_factory()
    try:
        ctx, _ = await _blocked_send(Session)
        command = await _send_command(Session, ctx)
        _setup_org_scoped_app(app, Session, ctx["org_id"], user_id=ctx["sender_id"], agent=True)
        async with _client_for(app) as client:
            r = await client.post(f"/api/v2/organizations/{ctx['org_id']}/publication-commands/{command.id}/retry")
        assert r.status_code == 403, r.text
        assert (await _send_command(Session, ctx)).status == "blocked_unapproved"
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()
