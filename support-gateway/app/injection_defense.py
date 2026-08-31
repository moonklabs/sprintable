"""story #3259 AC5 — 방어 필터 "자리"(골격). 실 방어 내용(휴리스틱·모델 기반 탐지·거부 정책 등)은
story #6(방어·계측) 스코프 — 여기서는 **진입점을 고정**한다: 고객 텍스트가 시스템에 들어오는
유일한 지점(SupportMessage 저장 직전)에 이 함수가 반드시 호출되게만 배선해둔다.

Blueprint v0.3 §2 "주입 방어 — 고객 텍스트=데이터, 프롬프트 비밀 0, org 교차 차단, v1 쓰기
액션 0"의 첫 번째 원칙("텍스트=데이터")을 구조적으로 강제하는 지점 — Interaction Agent(story #3)
가 이 텍스트를 지시문처럼 실행하지 않도록, 저장 단계에서부터 "이건 데이터"라는 태그를 못 박는다.

⛔지금은 pass-through(원문 그대로 반환) — 탐지/차단 로직 없음. 이 함수를 호출하는 자리가
있다는 것 자체가 story #3259의 산출물이고, 내용 채우기는 story #6 몫이다.
"""
from __future__ import annotations


def sanitize_customer_text(text: str) -> str:
    """고객 발화 저장 직전 진입점. story #6 전까지는 pass-through — 호출 지점 고정이 목적."""
    return text
