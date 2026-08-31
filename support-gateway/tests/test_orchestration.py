"""story #3261 — Interaction/Execution 2층 루프 + 인입 분류기 + 비용 상한. 실 Vertex 호출 0
(FakeLLMClient, tests/conftest.py) — 오케스트레이션 로직(라우팅·에스컬레이션·캡)만 검증한다."""
from __future__ import annotations

from sqlalchemy import select

from app.config import settings
from app.models import SupportEscalation, SupportExecutionLog, SupportMessage
from tests.conftest import MOONKLABS_ORG_ID, OTHER_ORG_ID, make_token


async def _post_message(client, org_id, content="hello"):
    headers = {"Authorization": f"Bearer {make_token(org_id)}"}
    session = await client.post("/api/v1/sessions", headers=headers)
    session_id = session.json()["id"]
    resp = await client.post(f"/api/v1/sessions/{session_id}/messages", json={"content": content}, headers=headers)
    return resp


async def test_normal_inquiry_gets_interaction_reply_not_escalated(client, fake_llm):
    fake_llm.classify_text = "inquiry"
    fake_llm.interaction_text = "네, 도와드릴게요."
    resp = await _post_message(client, OTHER_ORG_ID)
    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert body["escalated"] is False
    assert body["agent_message"]["role"] == "agent"
    assert ("generate_with_tools", settings.model_interaction) in fake_llm.calls


async def test_needs_human_bypasses_interaction_entirely(client, fake_llm, db_engine):
    fake_llm.classify_text = "needs_human"
    resp = await _post_message(client, OTHER_ORG_ID)
    assert resp.status_code == 200
    body = resp.json()
    assert body["escalated"] is True
    # Interaction(generate_with_tools)이 아예 안 불렸는지 — AC2 "우회" 실측.
    assert not any(kind == "generate_with_tools" for kind, _ in fake_llm.calls)

    from sqlalchemy.ext.asyncio import async_sessionmaker

    async with async_sessionmaker(db_engine, expire_on_commit=False)() as session:
        escalations = (await session.execute(select(SupportEscalation))).scalars().all()
        assert len(escalations) == 1
        assert escalations[0].reason == "classifier"


async def test_moonklabs_needs_human_identical_to_other_org(client, fake_llm):
    """AC4 연속성 — 오케스트레이션 레이어도 moonklabs 특례가 없어야 한다."""
    fake_llm.classify_text = "needs_human"
    resp = await _post_message(client, MOONKLABS_ORG_ID)
    assert resp.status_code == 200
    assert resp.json()["escalated"] is True


async def test_cost_cap_exceeded_returns_honest_delay_not_silent_downgrade(client, fake_llm, db_engine, monkeypatch):
    monkeypatch.setattr(settings, "cost_cap_org_daily_usd", 0.0)  # 즉시 초과 상태로 만든다.
    fake_llm.classify_text = "inquiry"  # 분류기는 정상 통과 — 캡이 그 다음 단계에서 막아야 한다.
    resp = await _post_message(client, OTHER_ORG_ID)
    assert resp.status_code == 200
    body = resp.json()
    assert body["escalated"] is True
    from app.cost_cap import HONEST_DELAY_MESSAGE

    async def _fetch_agent_text():
        from sqlalchemy.ext.asyncio import async_sessionmaker

        async with async_sessionmaker(db_engine, expire_on_commit=False)() as session:
            msg = (
                await session.execute(
                    select(SupportMessage).where(SupportMessage.role == "agent").order_by(SupportMessage.created_at.desc())
                )
            ).scalars().first()
            return msg.content

    assert await _fetch_agent_text() == HONEST_DELAY_MESSAGE
    # 캡 초과 시엔 Interaction을 아예 안 부른다 — "몰래 강등"이 아니라 "안 부름"(원칙 실측).
    assert not any(kind == "generate_with_tools" for kind, _ in fake_llm.calls)


async def test_execution_log_recorded_for_classifier_and_interaction(client, fake_llm, db_engine):
    fake_llm.classify_text = "inquiry"
    await _post_message(client, OTHER_ORG_ID)

    from sqlalchemy.ext.asyncio import async_sessionmaker

    async with async_sessionmaker(db_engine, expire_on_commit=False)() as session:
        logs = (await session.execute(select(SupportExecutionLog))).scalars().all()
    task_types = {log.task_type for log in logs}
    assert "classifier" in task_types
    assert "interaction" in task_types


async def test_memory_summarized_after_threshold(client, fake_llm, db_engine, monkeypatch):
    monkeypatch.setattr(settings, "memory_summarize_after_messages", 2)  # customer+agent = 2행/턴이라 1턴 후 트리거.
    fake_llm.classify_text = "inquiry"
    await _post_message(client, OTHER_ORG_ID, content="first")

    from sqlalchemy.ext.asyncio import async_sessionmaker

    from app.models import SupportConversation

    async with async_sessionmaker(db_engine, expire_on_commit=False)() as session:
        conv = (await session.execute(select(SupportConversation).where(SupportConversation.org_id == OTHER_ORG_ID))).scalars().one()
        assert conv.memory_summary is not None
        assert conv.memory_summarized_through_message_id is not None
