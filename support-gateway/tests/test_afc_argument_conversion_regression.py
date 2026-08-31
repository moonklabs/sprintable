"""story #3262 2보-b — 근인 확定 회귀 가드(2026-08-31, 페드루 PO+디디 교차실측).

**정확한 결함 클래스**: `app/interaction.py`에 `from __future__ import annotations`(PEP 563)가
있으면 `_make_tools`가 만드는 도구 클로저의 파라미터 어노테이션이 지연평가 문자열이 된다.
google-genai SDK 2.20.0의 실 인자변환 경로(`google.genai._extra_utils.
convert_argument_from_function`)는 `inspect.signature(...).parameters[...].annotation`을
그대로(문자열이어도 재해석 없이) `isinstance(value, annotation)`에 넘겨 `TypeError: isinstance()
arg 2 must be a type...`를 던진다 — **선언(스키마 생성, `FunctionDeclaration.
from_callable_with_api_option`)은 이 결함에서 멀쩡히 성공한다**(직접 실측 확認 — 그래서 "도구
파라미터 스키마가 비어있지 않음"류 검사로는 이 결함이 안 잡힌다). 실 디스패치 단계에서만
조용히 깨지고, SDK가 그 TypeError를 삼켜 도구가 아예 안 불리며 모델이 정형 사과문을 대신
생성한다(2026-08-31 dev 3차 실측 실사고와 동일 서명).

이 테스트는 SDK가 실제로 쓰는 그 변환 함수를 `app/interaction.py::_make_tools`가 만든 진짜
클로저에 직접 태워, "인자가 정상 변환되는가"를 단언한다 — future-import가 이 파일에 재도입되면
정확히 이 테스트가 RED로 떨어진다(실측으로 확認한 유일한 신뢰할 수 있는 회귀선)."""
from __future__ import annotations

import uuid

import pytest
from google.genai._extra_utils import convert_argument_from_function

from app.interaction import _make_tools


class _NoopDB:
    def add(self, *args, **kwargs):
        pass


def _build_tools():
    return _make_tools(
        _NoopDB(),
        conversation_id=uuid.uuid4(),
        org_id=uuid.uuid4(),
        user_id=uuid.uuid4(),
        escalation_state={"called": False},
        knowledge_state={"called": False, "had_match": False},
        llm=None,
    )


@pytest.mark.parametrize(
    "tool_name,args",
    [
        ("knowledge_search", {"query": "팀원을 초대하려면 어떻게 하나요?"}),
        ("org_status_lookup", {"question": "우리 조직 플랜이 뭔가요?"}),
        ("escalate", {"reason": "고객이 사람 연결을 요청함"}),
    ],
)
def test_sdk_can_convert_tool_call_arguments_without_typeerror(tool_name, args):
    """SDK가 모델의 function_call 인자를 실제로 도구에 전달하기 직전 단계 — 여기서
    TypeError가 나면 도구가 절대 안 불린다(2026-08-31 실사고의 정확한 메커니즘)."""
    tools = _build_tools()
    tool = next(t for t in tools if t.__name__ == tool_name)

    converted = convert_argument_from_function(args, tool)

    assert converted == args


def test_tool_parameter_annotations_are_real_types_not_deferred_strings():
    """근인 그 자체를 직접 단언 — `from __future__ import annotations`가 이 파일에 재도입되면
    `inspect.signature(...).annotation`이 문자열이 된다(str 타입 객체가 아니라 리터럴 "str").
    위 SDK 변환 테스트보다 한 단계 더 근본적인 신호라 같이 고정해둔다."""
    import inspect

    tools = _build_tools()
    for tool in tools:
        for name, param in inspect.signature(tool).parameters.items():
            assert isinstance(param.annotation, type), (
                f"{tool.__name__}의 파라미터 {name!r} 어노테이션이 실 타입이 아니라 "
                f"{param.annotation!r}({type(param.annotation).__name__}) — "
                "app/interaction.py에 `from __future__ import annotations`가 있는지 확인하세요."
            )
