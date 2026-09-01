"""story #3259 AC5(진입점 고정) → story #3264(지원v1·6방어·계측, 2026-08-31)에서 **실 구현**.
고객 텍스트가 시스템에 들어오는 유일한 지점(SupportMessage 저장 직전)에서 동작 — Blueprint
v0.3 §2 "주입 방어 — 고객 텍스트=데이터·프롬프트 비밀 0·org 교차 차단·v1 쓰기 액션 0"의
첫 번째 원칙("텍스트=데이터")을 구조적으로 강제한다.

**1차 방어(항상 유효, 이 파일과 무관)**: LLM 호출부(app/interaction.py 등)는 고객 텍스트를
`system_instruction`이 아니라 `contents`/`user_text` 파라미터로만 넘긴다 — Vertex API 레벨의
역할 분리라 애초에 "지시로 해석"될 문법적 통로가 없다(구조적, 프롬프트 지시에 안 기댐).

**이 파일이 잡는 구체적 착지점**: app/memory.py의 요약 프롬프트가 여러 메시지를
`f"{role}: {content}"`로 직렬화해 이어붙인다(대화 이력을 하나의 텍스트 블록으로 재구성).
고객 텍스트 안에 줄 시작에서 "system:"/"assistant:"/"agent:"/"customer:" 같은 역할 표시가
나오면, 그 직렬화 결과에서 요약 모델이 그걸 진짜 새 발화 턴(다른 화자가 실제로 한 말)으로
오인할 수 있다 — "지시 위장" 공격이 실제로 착지하는 지점. 콜론을 전각(：)으로 바꿔 패턴만
깨고 원문 가독성은 유지한다(내용을 지우거나 거부하지 않는다 — "데이터로 취급"이지
"검열"이 아니다).
"""
from __future__ import annotations

import re

# 줄 시작(멀티라인 모드)에서 "역할:" 형태 — memory.py 직렬화가 실제로 쓰는 4개 role 값만
# 좁게 잡는다(과탐 방지: 고객이 일상적으로 "system: 부팅이 안 돼요" 같은 무관한 문장을 써도
# 그 자체는 위협이 아니지만, 좁게 잡아도 실제 공격 착지점은 정확히 이 4개뿐이라 손해가 없다).
_FAKE_ROLE_LINE_PATTERN = re.compile(r"(?im)^(system|assistant|agent|customer)\s*:")


def sanitize_customer_text(text: str) -> str:
    """고객 발화 저장 직전 진입점. app/memory.py 직렬화 착지점을 겨냥한 가짜 역할줄 무력화."""
    return _FAKE_ROLE_LINE_PATTERN.sub(lambda m: f"{m.group(1)}：", text)
