"""story #2620(P3, delivery-contract-blueprint-v0-1 §5) — webhook 전달이 DeliveryDecision
단일 판정을 소비하는지 실 HTTP 왕복(AsyncClient+ASGITransport)으로 고정.

PO 확定 행동 변경(2026-08-13): 멘션이 있고 비멘션 webhook-구독 agent가 있어도, 수신 집합
자체는(mentions-기본값 off라) 그대로 — 종전엔 비멘션 agent가 webhook 대상에서 빠져
SSE로만 받았는데(SSE 폴백), 이제는 webhook으로 직접 받는다(파이프만 이동).

AC 대응:
①webhook authorized_member_ids ⊆ SSE 판정과 같은 decisions(대조 테스트)
②이중수신 0 비회귀 — webhook_covered 확대가 SSE-skip 확대와 대칭이라 겹치지 않음
③fleet 실왕복(human-less 대화 포함, 08-13 재상륙 조건 준용)
"""
from __future__ import annotations

import uuid

import pytest
from sqlalchemy import select

from tests.test_1994_backlink_api_realdb import (
    _client_for,
    _make_agent_member,
    _make_conversation,
    _make_org,
    _make_project,
    _session_factory,
    _setup_app_agent,
)
from tests.test_2301_story_body_mentions_realdb import _REAL_DB_URL

pytestmark = [
    pytest.mark.skipif(not _REAL_DB_URL, reason="통합 테스트는 실 PG(PARITY/ALEMBIC_DATABASE_URL) 필요"),
    pytest.mark.anyio,
]


@pytest.fixture
def anyio_backend():
    return "asyncio"


async def _seed_webhook(session, *, org_id, project_id, member_id):
    from app.models.webhook_config import WebhookConfig

    session.add(WebhookConfig(
        id=uuid.uuid4(), org_id=org_id, project_id=project_id, member_id=member_id,
        url=f"https://example.invalid/{uuid.uuid4()}", is_active=True,
        events=["conversation.message_created"],
    ))
    await session.commit()


async def test_mentioned_message_still_webhook_delivers_to_unmentioned_subscriber():
    """행동 변경(PO 확定, 2026-08-13): sender가 agent_b만 멘션해도, webhook-구독
    agent_c(무멘션)는 여전히 webhook 대상 — 수신 집합은 그대로(mentions-기본값 off),
    파이프만 SSE→webhook으로 이동. 종전(멘션 있으면 멘션만) 규칙이었다면 agent_c는
    webhook 목록에서 빠졌을 것 — 이 테스트가 그 회귀를 잠근다."""
    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org = await _make_org(s)
            project = await _make_project(s, org.id)
            agent_sender = await _make_agent_member(s, org.id, project.id)
            agent_b = await _make_agent_member(s, org.id, project.id)  # 멘션 대상
            agent_c = await _make_agent_member(s, org.id, project.id)  # 무멘션 webhook 구독자
            conv_id = await _make_conversation(
                s, org.id, project.id, [agent_sender, agent_b, agent_c], created_by=agent_sender,
            )
            await _seed_webhook(s, org_id=org.id, project_id=project.id, member_id=agent_c)

        captured: list = []

        async def _fake_deliver(*args, **kwargs):
            captured.append(kwargs.get("targets"))

        from app.services import conversation_webhook as cw_mod
        original = cw_mod.deliver_conversation_message_webhook
        cw_mod.deliver_conversation_message_webhook = _fake_deliver
        try:
            from app.main import app
            await _setup_app_agent(app, Session, agent_sender, org.id)
            async with _client_for(app) as client:
                resp = await client.post(
                    f"/api/v2/conversations/{conv_id}/messages",
                    json={"content": "@b만 멘션", "mentioned_ids": [str(agent_b)]},
                )
            app.dependency_overrides.clear()
            assert resp.status_code == 201, resp.text
        finally:
            cw_mod.deliver_conversation_message_webhook = original

        assert captured, "webhook delivery가 호출 안 됨 — 배선 확認 필요"
        target_member_ids = {t.member_id for t in captured[0]}
        assert agent_c in target_member_ids, (
            "무멘션 webhook 구독자가 여전히 대상이어야(#2620 통합 후 mentions는 배제가 아님)"
        )
    finally:
        await engine.dispose()


async def test_webhook_covered_agent_gets_no_duplicate_sse_event():
    """이중수신 0 비회귀(PO 조건②) — webhook 대상으로 잡힌 agent는 SSE Event가 안 생기고
    (webhook_covered_ids 스킵), webhook 미구독 agent는 SSE Event가 생긴다. 두 집합이
    같은 decisions에서 파생되므로 대칭 — 겹침도 누락도 없다."""
    from app.models.conversation import ConversationMessage
    from app.models.event import Event

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org = await _make_org(s)
            project = await _make_project(s, org.id)
            agent_sender = await _make_agent_member(s, org.id, project.id)
            agent_webhook = await _make_agent_member(s, org.id, project.id)   # webhook 구독
            agent_sse_only = await _make_agent_member(s, org.id, project.id)  # webhook 미구독
            conv_id = await _make_conversation(
                s, org.id, project.id, [agent_sender, agent_webhook, agent_sse_only],
                created_by=agent_sender,
            )
            await _seed_webhook(s, org_id=org.id, project_id=project.id, member_id=agent_webhook)

        captured: list = []

        async def _fake_deliver(*args, **kwargs):
            captured.append(kwargs.get("targets"))

        from app.services import conversation_webhook as cw_mod
        original = cw_mod.deliver_conversation_message_webhook
        cw_mod.deliver_conversation_message_webhook = _fake_deliver
        try:
            from app.main import app
            await _setup_app_agent(app, Session, agent_sender, org.id)
            async with _client_for(app) as client:
                resp = await client.post(
                    f"/api/v2/conversations/{conv_id}/messages",
                    json={"content": "무멘션 브로드캐스트"},
                )
            app.dependency_overrides.clear()
            assert resp.status_code == 201, resp.text
            msg_id = uuid.UUID(resp.json()["data"]["id"])
        finally:
            cw_mod.deliver_conversation_message_webhook = original

        target_member_ids = {t.member_id for t in captured[0]} if captured else set()
        assert agent_webhook in target_member_ids

        async with Session() as s:
            events = (await s.execute(
                select(Event.recipient_id).where(Event.source_entity_id == msg_id)
            )).scalars().all()
        event_recipients = set(events)
        assert agent_webhook not in event_recipients, (
            "webhook 대상 agent에게 SSE Event까지 생기면 이중수신(covered-skip 실패)"
        )
        assert agent_sse_only in event_recipients, (
            "webhook 미구독 agent는 SSE로 받아야(둘 다 빠지면 침묵)"
        )
    finally:
        await engine.dispose()


async def test_human_less_conversation_webhook_fleet_roundtrip():
    """AC③ fleet 실왕복(08-13 재상륙 조건 준용) — human 참가자가 없는 대화에서도 webhook
    대상 산출·전달이 정상 동작한다(2620 리팩터가 human-presence 예외(#2617)와 충돌 없음을
    실증)."""
    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org = await _make_org(s)
            project = await _make_project(s, org.id)
            agent_sender = await _make_agent_member(s, org.id, project.id)
            agent_b = await _make_agent_member(s, org.id, project.id)
            conv_id = await _make_conversation(
                s, org.id, project.id, [agent_sender, agent_b], created_by=agent_sender,
                conv_type="dm",
            )
            await _seed_webhook(s, org_id=org.id, project_id=project.id, member_id=agent_b)

        captured: list = []

        async def _fake_deliver(*args, **kwargs):
            captured.append(kwargs.get("targets"))

        from app.services import conversation_webhook as cw_mod
        original = cw_mod.deliver_conversation_message_webhook
        cw_mod.deliver_conversation_message_webhook = _fake_deliver
        try:
            from app.main import app
            await _setup_app_agent(app, Session, agent_sender, org.id)
            async with _client_for(app) as client:
                resp = await client.post(
                    f"/api/v2/conversations/{conv_id}/messages",
                    json={"content": "human-less DM webhook 실왕복"},
                )
            app.dependency_overrides.clear()
            assert resp.status_code == 201, resp.text
        finally:
            cw_mod.deliver_conversation_message_webhook = original

        assert captured, "human-less 대화에서 webhook delivery가 호출 안 됨"
        target_member_ids = {t.member_id for t in captured[0]}
        assert agent_b in target_member_ids
    finally:
        await engine.dispose()
