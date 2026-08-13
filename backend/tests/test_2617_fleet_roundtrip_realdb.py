"""story #2617 AC3: "자기 fleet 시나리오"(무인간 DM·무인간 group) 실왕복 테스트 — 실 HTTP
(AsyncClient+ASGITransport)로 POST /api/v2/conversations/{id}/messages를 태워, human-less
대화의 chain-depth 초과가 더 이상 recipient의 Event(SSE 전달의 실 근거)를 침묵시키지
않음을 고정한다. 오늘(2026-08-13) 페드루↔디디 DM에서 실측된 정확한 실패 모드의 회귀가드다.

human 있는 대화는 원 #2608 AC(A↔B 핑퐁 방지)가 비회귀임도 같은 방식으로 고정(AC2).
"""
from __future__ import annotations

import uuid
from datetime import datetime, timedelta, timezone

import pytest
from sqlalchemy import select

from tests.test_1994_backlink_api_realdb import (
    _add_message,
    _client_for,
    _make_agent_member,
    _make_conversation,
    _make_human_member,
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


def _t(offset_sec: int) -> datetime:
    return datetime.now(timezone.utc) - timedelta(seconds=100 - offset_sec)


async def _seed_chain_exceeding_history(session, conv_id, agent_a, agent_b, *, count: int = 5):
    """cap(4)을 넘는 human-less 연쇄 이력 — A/B가 번갈아 count건 발신(전부 agent, human 0)."""
    for i in range(count):
        sender = agent_a if i % 2 == 0 else agent_b
        await _add_message(session, conv_id, sender, f"msg-{i}", _t(i))


async def _event_exists_for_recipient(session, message_id: uuid.UUID, recipient_id: uuid.UUID) -> bool:
    from app.models.event import Event
    row = (await session.execute(
        select(Event.id).where(
            Event.source_entity_id == message_id,
            Event.recipient_id == recipient_id,
        )
    )).scalar_one_or_none()
    return row is not None


async def test_human_less_group_chain_exceeded_still_delivers_event():
    """AC1 — human 참가자가 없는 group 대화는 연쇄가 cap을 넘어도 recipient에게 Event가
    생성된다(침묵 안 됨). 카디르 QA가 실왕복으로 재현한 "3-agent group 5번째부터 무응답"의
    정확한 형태."""
    from app.main import app

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org = await _make_org(s)
            project = await _make_project(s, org.id)
            agent_a = await _make_agent_member(s, org.id, project.id)
            agent_b = await _make_agent_member(s, org.id, project.id)
            conv_id = await _make_conversation(
                s, org.id, project.id, [agent_a, agent_b], created_by=agent_a, conv_type="group",
            )
            await _seed_chain_exceeding_history(s, conv_id, agent_a, agent_b, count=5)

        await _setup_app_agent(app, Session, agent_a, org.id)
        client = _client_for(app)
        try:
            resp = await client.post(
                f"/api/v2/conversations/{conv_id}/messages",
                json={"content": "무멘션 후속 메시지"},
            )
        finally:
            await client.aclose()
            app.dependency_overrides.clear()

        assert resp.status_code == 201, resp.text
        msg_id = uuid.UUID(resp.json()["data"]["id"])

        async with Session() as s:
            assert await _event_exists_for_recipient(s, msg_id, agent_b) is True, (
                "human-less group에서 chain-expired가 recipient Event를 여전히 막고 있다 — "
                "AC1 회귀"
            )
    finally:
        await engine.dispose()


async def test_human_less_dm_chain_exceeded_still_delivers_event():
    """오늘 실측된 원 사고(페드루↔디디 DM)의 정확한 회귀가드 — DM 특칭이 아니라 human-less
    일반화(#2617)로도 여전히 살아있는지 실 HTTP로 확인."""
    from app.main import app

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org = await _make_org(s)
            project = await _make_project(s, org.id)
            agent_a = await _make_agent_member(s, org.id, project.id)
            agent_b = await _make_agent_member(s, org.id, project.id)
            conv_id = await _make_conversation(
                s, org.id, project.id, [agent_a, agent_b], created_by=agent_a, conv_type="dm",
            )
            await _seed_chain_exceeding_history(s, conv_id, agent_a, agent_b, count=5)

        await _setup_app_agent(app, Session, agent_a, org.id)
        client = _client_for(app)
        try:
            resp = await client.post(
                f"/api/v2/conversations/{conv_id}/messages",
                json={"content": "무멘션 DM 후속"},
            )
        finally:
            await client.aclose()
            app.dependency_overrides.clear()

        assert resp.status_code == 201, resp.text
        msg_id = uuid.UUID(resp.json()["data"]["id"])

        async with Session() as s:
            assert await _event_exists_for_recipient(s, msg_id, agent_b) is True
    finally:
        await engine.dispose()


async def test_human_present_group_chain_exceeded_still_blocks_agent_recipient():
    """AC2 비회귀 — human이 1명이라도 있는 대화는 원 #2608 AC(연쇄 cap 초과 시 agent
    recipient 차단) 그대로 유지돼야 한다. human-less 예외가 과확장돼 human 있는 대화까지
    새면 A↔B 무한루프 방지 자체가 무력화된다."""
    from app.main import app

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org = await _make_org(s)
            project = await _make_project(s, org.id)
            human_id, human_user_id = await _make_human_member(s, org.id, project.id)
            agent_a = await _make_agent_member(s, org.id, project.id)
            agent_b = await _make_agent_member(s, org.id, project.id)
            conv_id = await _make_conversation(
                s, org.id, project.id, [human_id, agent_a, agent_b], created_by=agent_a, conv_type="group",
            )
            await _seed_chain_exceeding_history(s, conv_id, agent_a, agent_b, count=5)

        await _setup_app_agent(app, Session, agent_a, org.id)
        client = _client_for(app)
        try:
            resp = await client.post(
                f"/api/v2/conversations/{conv_id}/messages",
                json={"content": "무멘션 후속(human 존재)"},
            )
        finally:
            await client.aclose()
            app.dependency_overrides.clear()

        assert resp.status_code == 201, resp.text
        msg_id = uuid.UUID(resp.json()["data"]["id"])

        async with Session() as s:
            assert await _event_exists_for_recipient(s, msg_id, agent_b) is False, (
                "human이 있는 대화인데 chain-expired agent recipient가 통과했다 — "
                "원 #2608 AC(A↔B 핑퐁 방지) 회귀"
            )
            # human recipient는 애초에 이 게이트 대상 밖(#2608 원 AC) — 무회귀 확인.
            assert await _event_exists_for_recipient(s, msg_id, human_id) is True
    finally:
        await engine.dispose()
