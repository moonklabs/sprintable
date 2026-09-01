"""story #3262 마감 발주(2026-08-31, 페드루 PO 3차 dev 재실측) — 근인수정(2보-b) 배포 후에도
잔존한 2차 날조(had_match=True 상태에서 컨텍스트 밖 UI 명사·경로를 자신만만하게 지어냄:
"활성화 버튼"·"공유 스페이스 화면") + AC2 "인용 포함" 미구현(모델 순응 실패)에 대한 구조
처방. 판독을 자유서술→선택형으로 재설계 — 이 파일은 그 파싱·조립 로직을 단위로 고정한다."""
from __future__ import annotations

import uuid

from app.execution_tasks import NO_MATCH_MESSAGE, _parse_relevant_indices, knowledge_task
from app.knowledge.corpus import KnowledgeChunk
from app.knowledge_search import SearchMatch
from app.vertex_client import EmbedResult, GenerateResult


def test_parse_single_index():
    assert _parse_relevant_indices("1", candidate_count=3) == [1]


def test_parse_multiple_indices_comma_separated():
    assert _parse_relevant_indices("1,3", candidate_count=3) == [1, 3]


def test_parse_none_case_insensitive():
    assert _parse_relevant_indices("NONE", candidate_count=3) == []
    assert _parse_relevant_indices("none", candidate_count=3) == []
    assert _parse_relevant_indices("None.", candidate_count=3) == []


def test_parse_ignores_out_of_range_indices():
    assert _parse_relevant_indices("1,5,2", candidate_count=3) == [1, 2]


def test_parse_dedupes_preserving_first_occurrence_order():
    assert _parse_relevant_indices("2,1,2", candidate_count=3) == [2, 1]


def test_parse_garbage_response_fails_closed_to_empty():
    """애매하거나 형식을 안 지킨 응답은 관대하게 해석하지 않고 무관 처리 — 날조 위험을
    "일단 뭐라도 골라준다" 쪽으로 남기지 않는다(fail-closed)."""
    assert _parse_relevant_indices("잘 모르겠지만 아마도 도움이 될 것 같습니다", candidate_count=3) == []
    assert _parse_relevant_indices("", candidate_count=3) == []


class _StubLLM:
    """knowledge_task를 직접(HTTP 라우터 없이) 단위 검증하기 위한 최소 스텁 — embed는 항상
    같은 3차원 더미(search()는 별도 몽키패치로 통제), generate는 고정된 relevance_text를
    돌려준다."""

    def __init__(self, relevance_text: str) -> None:
        self.relevance_text = relevance_text

    async def embed(self, *, model, texts, task_type):
        return EmbedResult(vectors=[[0.1, 0.2, 0.3] for _ in texts], billable_character_count=10)

    async def generate(self, *, model, system_prompt, user_text):
        return GenerateResult(text=self.relevance_text, input_tokens=10, output_tokens=2)


class _NoopDB:
    def add(self, *args, **kwargs):
        pass


async def test_knowledge_task_answer_is_verbatim_chunk_content_not_model_prose(monkeypatch):
    """핵심 회귀 — 답변 본문이 항상 청크 원문 그대로여야 한다. relevance_text에 모델이
    (지시를 어기고) 산문을 섞어 보내도 그게 고객이 보는 답이 되면 안 된다."""
    chunk = KnowledgeChunk(
        id="invite-how-to",
        title="팀원 초대 방법",
        content="조직 > 멤버 페이지에서 이메일과 역할을 입력해 초대하세요.",
        source_note="test",
    )
    import app.execution_tasks as execution_tasks_module

    monkeypatch.setattr(execution_tasks_module, "search", lambda vector, top_k=3: [SearchMatch(chunk=chunk, score=0.9)])

    # 모델이 지시를 어기고 산문을 섞어 보낸 경우(예: "1번 문서가 활성화 버튼을 언급합니다") —
    # _parse_relevant_indices가 "1"만 뽑아내고, 그 뒤 산문은 답변 조립에 전혀 안 쓰인다.
    llm = _StubLLM(relevance_text="1번 문서가 관련 있습니다. 활성화 버튼도 있다고 생각합니다.")

    result = await knowledge_task(
        _NoopDB(), conversation_id=uuid.uuid4(), org_id=uuid.uuid4(), query="팀원을 초대하려면?", llm=llm
    )

    assert result.had_match is True
    assert chunk.content in result.answer
    assert "활성화 버튼" not in result.answer  # 모델이 산문으로 지어낸 내용은 답변에 안 실린다.
    assert "(참고: 팀원 초대 방법)" in result.answer  # 인용은 코드가 항상 붙인다.


async def test_knowledge_task_returns_honest_message_when_llm_says_none_relevant(monkeypatch):
    """검색이 threshold를 넘겨 후보를 줬어도, 판정 LLM이 "실제로는 무관하다"고 하면 정직한
    모른다로 떨어져야 한다 — 지식가드 위협모델 2(무관 매치가 가드를 해제)의 완충 효과."""
    chunk = KnowledgeChunk(id="onboarding-happy-path", title="온보딩", content="...", source_note="test")
    import app.execution_tasks as execution_tasks_module

    monkeypatch.setattr(execution_tasks_module, "search", lambda vector, top_k=3: [SearchMatch(chunk=chunk, score=0.66)])

    llm = _StubLLM(relevance_text="NONE")
    result = await knowledge_task(
        _NoopDB(), conversation_id=uuid.uuid4(), org_id=uuid.uuid4(), query="오늘 날씨 어때요?", llm=llm
    )

    assert result.had_match is False
    assert result.answer == NO_MATCH_MESSAGE
    assert result.cited_chunk_ids == ()


async def test_knowledge_task_llm_wrong_selection_of_irrelevant_low_score_match_is_rejected(monkeypatch):
    """story #3268(지원v1·후속) 이중 게이트 핵심 pin — 카디르 QA(PR#3651) 재현 시나리오
    그대로: 무관 청크(seat-limit)가 threshold(0.65)는 겨우 넘겼고(score=0.66), 관련성
    판정 LLM도 주제를 오판해 그 청크를 "1"(선택)로 잘못 골랐다. LLM 선택만으로 채택하면
    (구 로직) had_match=True가 되지만, 이중 게이트(원시 스코어도 확신 threshold=0.70을
    넘어야 함)가 이 경계 사례를 독립적으로 걸러 정직한 NO_MATCH로 떨어뜨려야 한다."""
    seat_chunk = KnowledgeChunk(
        id="invite-seat-limit-free-plan", title="무료 플랜에서 멤버 초대 인원 제한",
        content="무료 플랜은 초대할 수 있는 멤버 수에 상한이 있습니다.", source_note="test",
    )
    import app.execution_tasks as execution_tasks_module

    monkeypatch.setattr(
        execution_tasks_module, "search", lambda vector, top_k=3: [SearchMatch(chunk=seat_chunk, score=0.66)]
    )
    llm = _StubLLM(relevance_text="1")  # LLM이 무관 청크를 (잘못) 관련 있다고 선택
    result = await knowledge_task(
        _NoopDB(), conversation_id=uuid.uuid4(), org_id=uuid.uuid4(), query="슬랙 연동은 어떻게 하나요?", llm=llm
    )

    assert result.had_match is False
    assert result.answer == NO_MATCH_MESSAGE
    assert result.cited_chunk_ids == ()
    assert seat_chunk.content not in result.answer  # 무관 청크 내용이 답에 안 실린다.


async def test_knowledge_task_high_confidence_real_match_still_passes_dual_gate(monkeypatch):
    """정상 케이스 무과탐(AC②) — 실측 관련 질문 분포(0.70~0.80, story #3262 AC4)에 드는
    진짜 매치는 이중 게이트를 그대로 통과해 매치+인용된다(과탐으로 정직한 답까지 막으면
    안 됨)."""
    chunk = KnowledgeChunk(
        id="invite-how-to", title="팀원 초대 방법",
        content="조직 > 멤버 페이지에서 이메일과 역할을 입력해 초대하세요.", source_note="test",
    )
    import app.execution_tasks as execution_tasks_module

    monkeypatch.setattr(
        execution_tasks_module, "search", lambda vector, top_k=3: [SearchMatch(chunk=chunk, score=0.75)]
    )
    llm = _StubLLM(relevance_text="1")
    result = await knowledge_task(
        _NoopDB(), conversation_id=uuid.uuid4(), org_id=uuid.uuid4(), query="팀원을 초대하려면?", llm=llm
    )

    assert result.had_match is True
    assert chunk.content in result.answer
    assert result.cited_chunk_ids == ("invite-how-to",)


async def test_knowledge_task_multi_chunk_selection_cites_each(monkeypatch):
    chunk_a = KnowledgeChunk(id="a", title="A문서", content="A 내용", source_note="test")
    chunk_b = KnowledgeChunk(id="b", title="B문서", content="B 내용", source_note="test")
    import app.execution_tasks as execution_tasks_module

    monkeypatch.setattr(
        execution_tasks_module,
        "search",
        lambda vector, top_k=3: [SearchMatch(chunk=chunk_a, score=0.9), SearchMatch(chunk=chunk_b, score=0.8)],
    )

    llm = _StubLLM(relevance_text="1,2")
    result = await knowledge_task(
        _NoopDB(), conversation_id=uuid.uuid4(), org_id=uuid.uuid4(), query="질문", llm=llm
    )

    assert result.had_match is True
    assert result.cited_chunk_ids == ("a", "b")
    assert "A 내용" in result.answer and "(참고: A문서)" in result.answer
    assert "B 내용" in result.answer and "(참고: B문서)" in result.answer
