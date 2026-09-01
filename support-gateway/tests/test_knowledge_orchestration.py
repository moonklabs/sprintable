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
    # content 자체(모델 재서술이 최종 표면에 실제로 나가는지)는 story #3270 이후 아래
    # test_matched_turn_discards_model_narration_and_delivers_knowledge_task_answer_with_citation가
    # 검증한다 — 이 테스트는 "가드가 오탐으로 escalate하지 않는다"는 원래 관심사만 남긴다.


async def test_matched_turn_discards_model_narration_and_delivers_knowledge_task_answer_with_citation(
    client, fake_llm, monkeypatch
):
    """story #3270(지원v1·후속) AC1/AC2 통합 재설계 핵심 회귀 — knowledge_search가 매치를 찾은
    턴은 모델이 뭐라고 재서술했든(`fake_llm.interaction_text` = `_GROUNDED_LOOKING_TEXT`,
    인용도 없고 지식 원문과 문구도 다름) 고객에게 나가는 최종 답은 항상 knowledge_task가
    code로 조립한 원문+인용이어야 한다 — 모델의 재서술 결과는 완전히 버려진다(구 AC2 "인용
    표면 소실"·구 AC1 "{N} 플레이스홀더 재추정 사고"를 같은 재서술-배제 메커니즘으로 봉쇄)."""
    _patch_search_real_match(monkeypatch)
    fake_llm.classify_text = "inquiry"
    fake_llm.call_tool_name = "knowledge_search"
    fake_llm.call_tool_kwargs = {"query": "팀원을 초대하려면?"}
    fake_llm.interaction_text = _GROUNDED_LOOKING_TEXT  # 모델의 이 텍스트는 고객에게 절대 안 나간다.

    resp = await _post_message(client)
    assert resp.status_code == 200
    body = resp.json()
    assert body["escalated"] is False
    content = body["agent_message"]["content"]
    assert content != _GROUNDED_LOOKING_TEXT
    assert "..." in content  # _patch_search_real_match의 chunk.content 원문 그대로.
    assert "(참고: 팀원 초대 방법)" in content  # 인용이 구조적으로 보장된다.


async def test_mixed_turn_matched_and_no_match_answers_both_survive_in_call_order(client, fake_llm, monkeypatch):
    """story #3270 조건③ 설계 pin — 한 턴에 knowledge_search가 매치+무매치로 섞여 여러 번
    불리면(고객이 한 메시지에 두 가지를 물은 경우), 어느 한쪽도 조용히 누락되지 않고 호출
    순서대로 이어붙여 전달된다. 모델의 자연스러운 연결 서술은 버려진다(위 테스트와 동일 원칙)."""
    from app.execution_tasks import NO_MATCH_MESSAGE

    chunk = KnowledgeChunk(id="invite-how-to", title="팀원 초대 방법", content="첫 매치 원문 그대로", source_note="test")
    call_count = {"n": 0}

    def _search(vector, top_k=3):
        call_count["n"] += 1
        return [SearchMatch(chunk=chunk, score=0.9)] if call_count["n"] == 1 else []

    monkeypatch.setattr(execution_tasks_module, "search", _search)
    fake_llm.classify_text = "inquiry"
    fake_llm.call_tool_calls = [
        ("knowledge_search", {"query": "팀원을 초대하려면?"}),
        ("knowledge_search", {"query": "결제 카드를 변경하려면?"}),
    ]
    fake_llm.interaction_text = "이 문장은 절대 고객에게 안 나가야 한다."

    resp = await _post_message(client, content="팀원 초대랑 결제 카드 변경 둘 다 어떻게 하나요?")
    assert resp.status_code == 200
    body = resp.json()
    assert body["escalated"] is False
    content = body["agent_message"]["content"]
    assert "이 문장은 절대 고객에게 안 나가야 한다" not in content
    assert "첫 매치 원문 그대로" in content
    assert "(참고: 팀원 초대 방법)" in content
    assert NO_MATCH_MESSAGE in content
    # 호출 순서 보존 — 매치(1번째 호출) 답이 무매치(2번째 호출) 답보다 앞선다.
    assert content.index("첫 매치 원문 그대로") < content.index(NO_MATCH_MESSAGE)


async def test_repeated_identical_knowledge_answer_in_one_turn_is_deduped(client, fake_llm, monkeypatch):
    """story #3270 조건③ — 같은 답(예: 같은 무매치 폴백 문구)이 한 턴에 여러 번 나오면
    한 번만 남긴다(연속 중복 방지 — 순서 보존 dedupe)."""
    from app.execution_tasks import NO_MATCH_MESSAGE

    _patch_search_no_match(monkeypatch)
    fake_llm.classify_text = "inquiry"
    fake_llm.call_tool_calls = [
        ("knowledge_search", {"query": "질문 A"}),
        ("knowledge_search", {"query": "질문 B"}),
    ]
    fake_llm.interaction_text = "무시될 텍스트"

    resp = await _post_message(client)
    assert resp.status_code == 200
    body = resp.json()
    content = body["agent_message"]["content"]
    assert content == NO_MATCH_MESSAGE  # 두 번 다 같은 폴백이라 한 번만.
