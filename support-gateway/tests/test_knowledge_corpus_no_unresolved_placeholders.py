"""story #3270(지원v1·후속) AC1 조건② — corpus 원문에 미해결 템플릿 플레이스홀더('{N}'류)가
남아있으면 CI에서 잡는다. 근인 실측(2026-08-31): `invite-seat-limit-free-plan` 청크가 실
에러 메시지 문자열을 '{N}명까지'로 그대로 인용해뒀는데, Interaction 재서술 단계에서 모델이
그 플레이스홀더를 그럴듯한 구체 숫자로 채워 넣는 사고가 발생(완전 새 org·이력 0에서도
재현 — knowledge_search 도구 반환값에 미해결 템플릿이 실려 있으면, 그걸 넘겨받은 모델이
"고객에게 {N}을 그대로 보여줄 순 없다"며 대신 지어낸다).

⛔이 가드가 잡는 것은 딱 하나의 구문 모양뿐이다 — `{word}` 형태의 중괄호 플레이스홀더.
"OO명"·"XX원"·"[숫자]"류처럼 중괄호를 안 쓰는 산문형 미해결 값은 이 정규식이 못 잡는다
(일반적인 "이 문서에 확정 안 된 값이 있는지"는 사람 리뷰의 몫 — 이 테스트는 그 중 코드로
기계적으로 검출 가능한 한 가지 재발 패턴만 좁게 막는다)."""
from __future__ import annotations

import re

from app.knowledge.corpus import KNOWLEDGE_CHUNKS

_BRACE_PLACEHOLDER = re.compile(r"\{[^{}]+\}")


def test_no_chunk_content_contains_a_brace_style_placeholder():
    offenders = {
        chunk.id: matches
        for chunk in KNOWLEDGE_CHUNKS
        if (matches := _BRACE_PLACEHOLDER.findall(chunk.content))
    }
    assert not offenders, (
        f"corpus 청크에 미해결 템플릿 플레이스홀더가 남아있습니다: {offenders} — "
        "고정 숫자/값을 확정할 수 없으면 플레이스홀더를 그대로 인용하지 말고, "
        "실제 값을 어디서 확인할 수 있는지로 서술을 바꾸세요(story #3270 근인 재발 방지)."
    )
