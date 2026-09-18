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


async def test_no_fiction_guard_intercepts_fabricated_escalation_claim(client, fake_llm, db_engine):
    """story #3261 실사고 재현(2026-08-31 dev) — escalate 도구를 안 부르고 "담당자 연결도
    실패했습니다"를 서술하면, 그 텍스트를 그대로 고객에게 보내지 않고 실 에스컬레이션으로
    정정해야 한다. 카디르 QA 축① 지적(qa:changes) 반영 — 유닛테스트의 실사고 원문 그대로
    재사용해 "탐지+정정" 엔드투엔드를 한 테스트로 묶는다(원래는 축약 문구를 썼음)."""
    from tests.test_no_fiction_guard import _REAL_INCIDENT_TEXT

    fake_llm.classify_text = "inquiry"
    fake_llm.interaction_text = _REAL_INCIDENT_TEXT
    resp = await _post_message(client, OTHER_ORG_ID, content="팀원을 초대하려면 어떻게 하나요?")
    assert resp.status_code == 200
    body = resp.json()

    assert body["escalated"] is True
    from app.no_fiction_guard import FALLBACK_REPLY

    assert body["agent_message"]["content"] == FALLBACK_REPLY
    assert "실패" not in body["agent_message"]["content"]

    from sqlalchemy.ext.asyncio import async_sessionmaker

    async with async_sessionmaker(db_engine, expire_on_commit=False)() as session:
        escalations = (await session.execute(select(SupportEscalation))).scalars().all()
        assert len(escalations) == 1
        assert escalations[0].reason == "no_fiction_guard"
        logs = (await session.execute(select(SupportExecutionLog))).scalars().all()
        assert any(log.task_type == "no_fiction_guard" for log in logs)


async def test_no_fiction_guard_does_not_touch_normal_reply(client, fake_llm):
    fake_llm.classify_text = "inquiry"
    fake_llm.interaction_text = "새 스프린트는 백로그에서 '스프린트 만들기'로 시작하세요."
    resp = await _post_message(client, OTHER_ORG_ID)
    assert resp.status_code == 200
    body = resp.json()
    assert body["escalated"] is False
    assert body["agent_message"]["content"] == fake_llm.interaction_text


# story #3277(지원v1·후속) — "지식 미호출 우회" 처방 배선 pin. classify()의 needs_grounding이
# handle_turn을 거쳐 generate_with_tools(force_tool_names=...)로 정확히 전달되는지 — 실
# Gemini ANY 모드 강제 자체(모델이 진짜로 거부 못 하는지)는 페이크로 재현 불가라 수동 SDK
# 스모크 테스트 영역(기존 관례, conftest.py FakeLLMClient 문서 참고)이고, 이 pin은 그
# "배선"만 고정한다 — PO 단서① 경계 pin(잡담=강제 안 걸림·제품 절차=강제 걸림) 실제
# 왕복(HTTP 엔드투엔드) 버전.
async def test_needs_grounding_true_forces_knowledge_search_tool_config(client, fake_llm):
    fake_llm.classify_text = "inquiry"
    fake_llm.classify_needs_grounding = True
    resp = await _post_message(client, OTHER_ORG_ID, content="팀원을 초대하려면 어떻게 하나요?")
    assert resp.status_code == 200
    assert fake_llm.last_force_tool_names == ["knowledge_search"]


async def test_needs_grounding_false_does_not_force_tool_config(client, fake_llm):
    """순수 잡담(needs_grounding=False) — 강제 호출 배선이 안 걸려야 한다(AUTO 그대로)."""
    fake_llm.classify_text = "inquiry"
    fake_llm.classify_needs_grounding = False
    resp = await _post_message(client, OTHER_ORG_ID, content="감사합니다!")
    assert resp.status_code == 200
    assert fake_llm.last_force_tool_names is None


async def test_needs_grounding_reverse_mutation_pin(client, fake_llm):
    """반대 분류 뮤테이션 red pin(PO 단서①) — 위 두 테스트가 서로 다른 결과를 내야
    한다(같은 값으로 뭉치면 배선이 needs_grounding을 실제로 안 읽고 있다는 뜻)."""
    fake_llm.classify_text = "inquiry"
    fake_llm.classify_needs_grounding = True
    await _post_message(client, OTHER_ORG_ID, content="사용법 질문")
    forced = fake_llm.last_force_tool_names

    fake_llm.classify_needs_grounding = False
    await _post_message(client, OTHER_ORG_ID, content="고마워요")
    not_forced = fake_llm.last_force_tool_names

    assert forced == ["knowledge_search"]
    assert not_forced is None
    assert forced != not_forced


# story #3283(지원v1·후속, 2026-09-01 PO 라이브 실증) — 강제 그라운딩 턴이 전 호출 무매치로
# 끝나면 escalate 자체가 mode=ANY(allowed=knowledge_search만)에 의해 봉쇄돼 모델 재량으로는
# 절대 못 부른다 — 조립 문구("연결해 드리는 게 정확합니다")가 실제 행동과 어긋나지 않도록
# 코드가 직접 에스컬레이션을 실행해야 한다.
async def test_forced_grounding_turn_ending_no_match_code_escalates(client, fake_llm, db_engine, monkeypatch):
    import app.execution_tasks as execution_tasks_module

    monkeypatch.setattr(execution_tasks_module, "search", lambda vector, top_k=3, min_score=None: [])

    fake_llm.classify_text = "inquiry"
    fake_llm.classify_needs_grounding = True
    fake_llm.call_tool_name = "knowledge_search"
    fake_llm.call_tool_kwargs = {"query": "에이전트 로컬 설정 방법"}
    resp = await _post_message(client, OTHER_ORG_ID, content="에이전트 로컬 설정 방법")
    assert resp.status_code == 200
    body = resp.json()

    assert body["escalated"] is True
    from app.execution_tasks import NO_MATCH_MESSAGE

    assert body["agent_message"]["content"] == NO_MATCH_MESSAGE  # 문구는 그대로, 실동작만 이행.

    from sqlalchemy.ext.asyncio import async_sessionmaker

    async with async_sessionmaker(db_engine, expire_on_commit=False)() as session:
        escalations = (await session.execute(select(SupportEscalation))).scalars().all()
        assert len(escalations) == 1
        assert escalations[0].reason == "forced_grounding_no_match"
        logs = (await session.execute(select(SupportExecutionLog))).scalars().all()
        assert any(log.task_type == "forced_grounding_escalation" for log in logs)


async def test_forced_grounding_turn_with_near_miss_does_not_code_escalate(client, fake_llm, db_engine, monkeypatch):
    """근접 매치(had_match=True)가 있으면 코드 강제 에스컬이 안 걸려야 한다 — #3281 근접
    사다리 ②단이 강제 턴에서도 여전히 정상 착지하는지 회귀 방지."""
    import app.execution_tasks as execution_tasks_module
    from app.knowledge.corpus import KnowledgeChunk
    from app.knowledge_search import SearchMatch

    chunk = KnowledgeChunk(id="near-x", title="근접문서", content="근접 내용", source_note="test")
    monkeypatch.setattr(
        execution_tasks_module, "search", lambda vector, top_k=3, min_score=None: [SearchMatch(chunk=chunk, score=0.65)]
    )

    fake_llm.classify_text = "inquiry"
    fake_llm.classify_needs_grounding = True
    fake_llm.knowledge_text = "NONE"  # 관련성 판정 LLM이 거부 — 정확 매치가 아니라 근접으로 착지.
    fake_llm.call_tool_name = "knowledge_search"
    fake_llm.call_tool_kwargs = {"query": "질문"}
    resp = await _post_message(client, OTHER_ORG_ID, content="질문")
    assert resp.status_code == 200
    body = resp.json()

    assert body["escalated"] is False
    assert "근접 내용" in body["agent_message"]["content"]

    from sqlalchemy.ext.asyncio import async_sessionmaker

    async with async_sessionmaker(db_engine, expire_on_commit=False)() as session:
        escalations = (await session.execute(select(SupportEscalation))).scalars().all()
        assert escalations == []
