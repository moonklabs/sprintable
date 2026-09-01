"""story #3277(지원v1·후속) — classifier.py의 needs_grounding 축(PO 단서①: 경계 pin
양방향). 순수 함수 테스트 — DB/HTTP 불요, FakeLLMClient만 직결."""
from __future__ import annotations

from app.classifier import Category, classify
from tests.conftest import FakeLLMClient


async def test_pure_chitchat_does_not_force_grounding():
    """순수 잡담/감사 인사 — needs_grounding=False가 나와야 한다(강제 호출 대상 아님)."""
    llm = FakeLLMClient(classify_text="inquiry", classify_needs_grounding=False)
    result = await classify("감사합니다!", llm)
    assert result.category == Category.INQUIRY
    assert result.needs_grounding is False


async def test_product_procedure_question_forces_grounding():
    """제품 사용법/절차 질문 — needs_grounding=True가 나와야 한다(knowledge_search 강제 대상)."""
    llm = FakeLLMClient(classify_text="inquiry", classify_needs_grounding=True)
    result = await classify("팀원을 초대하려면 어떻게 하나요?", llm)
    assert result.category == Category.INQUIRY
    assert result.needs_grounding is True


async def test_needs_grounding_independent_of_category():
    """needs_grounding은 category와 독립 축이다 — onboarding_stuck이어도 절차 질문이면 True."""
    llm = FakeLLMClient(classify_text="onboarding_stuck", classify_needs_grounding=True)
    result = await classify("초대 이메일이 안 와요, 어디서 재발송하나요?", llm)
    assert result.category == Category.ONBOARDING_STUCK
    assert result.needs_grounding is True


async def test_malformed_output_missing_separator_fails_closed_to_no_grounding():
    """PO 단서① — 파싱 실패(구분자 없음)는 보수적으로 False. 순수 잡담에 강제 호출이
    걸리는 새 회귀보다, 미호출 우회가 남는(기존 결함 그대로, 신규 회귀 아님) 쪽이 낫다."""
    llm = FakeLLMClient()
    llm.classify_text = "inquiry"  # "|" 없는 원시 출력을 직접 재현(구분자 자체가 없는 케이스)
    result = await classify("아무 텍스트", llm)
    assert result.needs_grounding is False


async def test_malformed_grounding_value_fails_closed_to_no_grounding():
    """두 번째 값이 true/false가 아닌 이상한 값이면(모델 일탈) 역시 False로 fail-closed."""

    class _WeirdLLM(FakeLLMClient):
        async def generate(self, *, model, system_prompt, user_text):
            from app.vertex_client import GenerateResult
            if "카테고리" in system_prompt or "라우터" in system_prompt:
                return GenerateResult(text="inquiry|maybe", input_tokens=10, output_tokens=1)
            return await super().generate(model=model, system_prompt=system_prompt, user_text=user_text)

    result = await classify("아무 텍스트", _WeirdLLM())
    assert result.category == Category.INQUIRY
    assert result.needs_grounding is False


async def test_reverse_mutation_pin_true_and_false_actually_differ():
    """반대 분류 뮤테이션 red pin(PO 단서①) — classify_needs_grounding을 True/False로
    뒤집으면 result.needs_grounding도 반드시 따라 뒤집힌다(파싱이 상수를 무시하고 고정값을
    반환하도록 망가지면 이 테스트가 정확히 RED가 된다)."""
    llm_true = FakeLLMClient(classify_text="inquiry", classify_needs_grounding=True)
    llm_false = FakeLLMClient(classify_text="inquiry", classify_needs_grounding=False)
    result_true = await classify("사용법을 알려주세요", llm_true)
    result_false = await classify("감사합니다", llm_false)
    assert result_true.needs_grounding is True
    assert result_false.needs_grounding is False
    assert result_true.needs_grounding != result_false.needs_grounding
