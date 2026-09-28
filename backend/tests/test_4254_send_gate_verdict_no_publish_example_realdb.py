"""story #4254 — 뉴스레터 «발송 요청» 게이트 승인 알림이 다음 단계(send_checked) 발행 예시를 싣지 않는다.

발송 게이트는 승인 → 예약 시각에 크론이 발송 → 발송이 성공하면 **서버가** 다음 단계 이벤트를 낸다(story 4214). 예전엔 판정
렌더러의 일반 갈래가 다음 단계 발행 예시를 실어, 그대로 따른 에이전트가 실제 발송 전에 send_checked를 냈고 서버 emit은
중복으로 건너뛰어 흐름이 거짓 완료됐다(4177 체인 실측). 이제 «할 일 없음 · 서버가 넘김» 한 줄이다.

세팅은 4242 하네스 그대로(실 뉴스레터 시드 0398 · 4191 발행물 체인). 승인은 서비스 `transition_gate`(사람 resolver) —
판정 알림(preset.gate.verdict)이 실제로 발행되는 경로다.
"""
from __future__ import annotations

import os
from datetime import datetime, timedelta, timezone

import pytest

from tests.recipe_stage_walk import prepare_stage_publish
from tests.test_3312_approve_stage_gate_auto_creation import _auth, _fake_request
from tests.test_3330_gate_verdict_notification import _seed_preset_gate_verdict_definition
from tests.test_4242_server_stage_routes_to_next_agent_realdb import _SEED, _bind_agent, _setup_newsletter
from tests.test_e4fc29fa_site_post_orchestration import _session_factory

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
    from cryptography.fernet import Fernet

    import app.core.config as config_module
    from app.services.channel_credential_crypto import _get_multi_fernet

    monkeypatch.setattr(config_module.settings, "channel_credential_encryption_key", Fernet.generate_key().decode())
    _get_multi_fernet.cache_clear()
    yield
    _get_multi_fernet.cache_clear()


async def _approved_send_gate_verdict(Session, ctx):
    """발송 요청 단계 발행(봉인 필드 실값) → 발송 게이트 → 사람 승인 → 판정 알림 본문."""
    from fastapi import BackgroundTasks
    from sqlalchemy import select, text

    from app.models.conversation import ConversationMessage
    from app.models.event_definition import EventDefinition
    from app.models.gate import Gate
    from app.routers.events import EventPublishRequest, publish_registry_event
    from app.services.gate_service import transition_gate

    async with Session() as s:
        await _seed_preset_gate_verdict_definition(s)
        definition = (await s.execute(
            select(EventDefinition).where(EventDefinition.key == _SEED._KEY, EventDefinition.org_id.is_(None))
        )).scalar_one()
    # story #4251 — 발송 요청은 캠페인 생성(서버 stage) 뒤 발송 단계 담당(sender · 이미 바인딩)이 낸다. 그 앞 상태를 깐다.
    await prepare_stage_publish(
        Session, org_id=ctx["org_id"], project_id=ctx["project_id"], definition=definition,
        work_item_id=ctx["story_id"], stage="send_requested", publisher_id=ctx["sender_id"],
    )
    scheduled_at = datetime.now(timezone.utc) + timedelta(hours=2)
    async with Session() as s:
        await publish_registry_event(
            EventPublishRequest(definition_key=_SEED._KEY, payload={
                "stage": "send_requested", "work_item_type": "story", "work_item_id": str(ctx["story_id"]),
                "publication_id": str(ctx["pub"].id), "segment_name": "test-recipients",
                "scheduled_at": scheduled_at.isoformat(),
            }),
            BackgroundTasks(), _fake_request(), db=s, auth=_auth(ctx["sender_id"], ctx["org_id"]), org_id=ctx["org_id"],
        )
        await s.commit()
    async with Session() as s:
        gate = (await s.execute(
            select(Gate).where(Gate.org_id == ctx["org_id"], Gate.gate_type == "newsletter_send")
        )).scalar_one()
        await transition_gate(s, ctx["org_id"], gate.id, "approved", resolver_id=ctx["owner_member_id"])
        await s.commit()
    async with Session() as s:
        message = (await s.execute(
            select(ConversationMessage).where(
                text("conversation_messages.metadata->'event'->>'event_key' = 'preset.gate.verdict'"),
                text("conversation_messages.metadata->'event'->'payload'->>'gate_id' = :gate_id"),
            ).params(gate_id=str(gate.id))
        )).scalars().first()
    assert message is not None, "발송 게이트 승인 알림이 안 났다"
    return message


@pytest.mark.anyio
async def test_send_gate_approval_notice_has_no_next_stage_publish_example_and_says_server_advances():
    """⭐AC1 — 발송 게이트 승인 알림: send_checked 발행 예시 0 · «서버가 넘김» 안내 1.
    뮤테이션: 판정 렌더러의 `server_sends` 갈래 제거(일반 갈래로 되돌림) → 발행 예시가 실려 RED."""
    from app.services.i18n_catalog import t

    engine, Session = await _session_factory()
    try:
        ctx = await _setup_newsletter(Session)
        await _bind_agent(Session, ctx, definition_key=_SEED._KEY, stage="send_requested", agent_id=ctx["sender_id"])

        message = await _approved_send_gate_verdict(Session, ctx)

        assert "publish_event(" not in message.content, message.content
        assert '"send_checked"' not in message.content, message.content
        assert t("events.gate_verdict_next_action_recipe_server_sends", "ko") in message.content, message.content
    finally:
        await engine.dispose()
