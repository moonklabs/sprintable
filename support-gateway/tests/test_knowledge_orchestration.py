"""story #3262 — 지식 Task(app/execution_tasks.py::knowledge_task) + 지식 날조 가드
(app/interaction.py 배선)의 엔드투엔드. 실 Vertex 호출 0(FakeLLMClient) — `app.execution_tasks.
search`(app/knowledge_search.search를 execution_tasks.py가 이름째로 import)를 몽키패치해
"매치 있음/없음"을 결정론적으로 재현한다."""
from __future__ import annotations

from sqlalchemy import select

import app.execution_tasks as execution_tasks_module
from app.knowledge.corpus import KnowledgeChunk
from app.knowledge_fiction_guard import FALLBACK_REPLY as KNOWLEDGE_FALLBACK_REPLY
from app.knowledge_search import SearchMatch
from app.models import SupportEscalation, SupportExecutionLog
from tests.conftest import OTHER_ORG_ID, make_token

# 페드루 PO 재실측(2026-08-31) 2차 실사고 재현 원문 — tests/test_knowledge_fiction_guard.py와 동일.
_FABRICATED_TEXT = (
    "팀원을 초대하시려면 설정 > 사용자 및 권한 > 사용자 초대 메뉴로 이동하신 후, "
    "https://example.com/invite 에서 이메일을 입력해 초대를 보내시면 됩니다."
)
_GROUNDED_LOOKING_TEXT = "조직 > 멤버 페이지에서 이메일을 입력해 초대하실 수 있어요."


async def _post_message(client, org_id=OTHER_ORG_ID, content="팀원을 초대하려면 어떻게 하나요?"):
    headers = {"Authorization": f"Bearer {make_token(org_id)}"}
    session = await client.post("/api/v1/sessions", headers=headers)
    session_id = session.json()["id"]
    resp = await client.post(f"/api/v1/sessions/{session_id}/messages", json={"content": content}, headers=headers)
    return resp


def _patch_search_no_match(monkeypatch):
    monkeypatch.setattr(execution_tasks_module, "search", lambda vector, top_k=3: [])


def _patch_search_real_match(monkeypatch):
    chunk = KnowledgeChunk(id="invite-how-to", title="팀원 초대 방법", content="...", source_note="test")
    monkeypatch.setattr(
        execution_tasks_module, "search", lambda vector, top_k=3: [SearchMatch(chunk=chunk, score=0.9)]
    )


async def test_knowledge_task_logs_no_match_honestly(client, fake_llm, db_engine, monkeypatch):
    _patch_search_no_match(monkeypatch)
    fake_llm.classify_text = "inquiry"
    fake_llm.call_tool_name = "knowledge_search"
    fake_llm.call_tool_kwargs = {"query": "아무도 답 못 하는 질문"}
    fake_llm.interaction_text = "죄송하지만 확인이 필요한 질문이라 담당자에게 연결해 드릴게요."

    resp = await _post_message(client)
    assert resp.status_code == 200

    from sqlalchemy.ext.asyncio import async_sessionmaker

    async with async_sessionmaker(db_engine, expire_on_commit=False)() as session:
        logs = (await session.execute(select(SupportExecutionLog))).scalars().all()
    knowledge_logs = [log for log in logs if log.task_type == "knowledge"]
    assert len(knowledge_logs) == 1
    assert "no match" in knowledge_logs[0].summary


async def test_knowledge_guard_blocks_fabrication_when_never_called(client, fake_llm, db_engine):
    """실사고 그대로 — knowledge_search를 아예 안 부르고 확신조로 조작법/링크를 지어냄."""
    fake_llm.classify_text = "inquiry"
    fake_llm.interaction_text = _FABRICATED_TEXT

    resp = await _post_message(client)
    assert resp.status_code == 200
    body = resp.json()
    assert body["escalated"] is True
    assert body["agent_message"]["content"] == KNOWLEDGE_FALLBACK_REPLY

    from sqlalchemy.ext.asyncio import async_sessionmaker

    async with async_sessionmaker(db_engine, expire_on_commit=False)() as session:
        escalations = (await session.execute(select(SupportEscalation))).scalars().all()
        assert len(escalations) == 1
        assert escalations[0].reason == "knowledge_fiction_guard"
        logs = (await session.execute(select(SupportExecutionLog))).scalars().all()
        assert any(log.task_type == "knowledge_fiction_guard" for log in logs)


async def test_knowledge_guard_blocks_fabrication_when_called_but_no_match(client, fake_llm, db_engine, monkeypatch):
    """knowledge_search를 부르긴 했지만(정직하게 "모른다"를 받았지만) 그래도 확신조로
    지어내면 여전히 걸려야 한다 — "호출했다"만으론 면제되지 않는다, "실 매치가 있었는지"가 기준."""
    _patch_search_no_match(monkeypatch)
    fake_llm.classify_text = "inquiry"
    fake_llm.call_tool_name = "knowledge_search"
    fake_llm.call_tool_kwargs = {"query": "팀원을 초대하려면?"}
    fake_llm.interaction_text = _FABRICATED_TEXT

    resp = await _post_message(client)
    assert resp.status_code == 200
    body = resp.json()
    assert body["escalated"] is True
    assert body["agent_message"]["content"] == KNOWLEDGE_FALLBACK_REPLY


async def test_knowledge_guard_does_not_block_when_real_match_found(client, fake_llm, monkeypatch):
    """knowledge_search가 실제로 매치를 찾은 턴엔, 답이 메뉴 경로처럼 생긴 문장을 포함해도
    가드가 손대면 안 된다 — 이게 하드 AC의 핵심 경계("실 결과 없이"가 아니면 통과)."""
    _patch_search_real_match(monkeypatch)
    fake_llm.classify_text = "inquiry"
    fake_llm.call_tool_name = "knowledge_search"
    fake_llm.call_tool_kwargs = {"query": "팀원을 초대하려면?"}
    fake_llm.interaction_text = _GROUNDED_LOOKING_TEXT

    resp = await _post_message(client)
    assert resp.status_code == 200
    body = resp.json()
    assert body["escalated"] is False
    assert body["agent_message"]["content"] == _GROUNDED_LOOKING_TEXT
