"""story #3261 no-fiction 위반 후처리 가드(2026-08-31, 페드루 PO dev 실 왕복 실측 발견).

**실측된 사고**: 「팀원을 초대하려면?」질문에 Interaction 모델(gemini-2.5-pro)이
`escalate` 도구를 **한 번도 호출하지 않고**(SupportExecutionLog에 escalation 행 0·
support_escalations 테이블 0행) "내부 시스템에 오류가 발생하여 담당자 연결도 실패했습니다"를
텍스트로만 서술했다 — 일어나지 않은 실패를 고객에게 사실인 것처럼 전달한 것(no-fiction
원칙 위반, Blueprint §0 BAO/S "모르면 모른다"의 정반대).

시스템 프롬프트 강화(app/interaction.py)만으론 확실히 못 막는다 — LLM은 지시를 무시할 수
있다. 이 모듈은 **구조적 안전망**: escalate 도구가 실제로 호출됐는지(불리언, 클로저가
직접 기록)와 응답 텍스트의 표면 패턴을 대조해, "escalate 미호출인데 연결 실패/완료를
서술"하는 조합만 좁게 잡아낸다(과탐 방지 — 이 패턴 밖의 텍스트는 절대 안 건드린다).
"""
from __future__ import annotations

import re

# "담당자"/"연결"/"에스컬레이션" 같은 사람-연결 어휘 + "실패"/"완료"/"해드렸"류 완료·결과
# 서술이 함께 나오면, escalate 도구 미호출 상태에서는 100% 지어낸 것이다(그 조합을 만들
# 다른 방법이 없다 — 실제로 연결됐다면 escalate가 불렸을 것).
_HUMAN_HANDOFF_CLAIM = re.compile(r"(담당자|사람|에스컬레이션).{0,20}(연결|전달)")
_RESULT_CLAIM = re.compile(r"(실패|완료|드렸|되었습니다|됐습니다|끝났)")

FALLBACK_REPLY = (
    "죄송합니다, 지금 바로 답변드리기 어려운 질문이네요. 담당자에게 연결해 드릴게요."
)


def looks_like_fabricated_handoff_claim(reply_text: str) -> bool:
    return bool(_HUMAN_HANDOFF_CLAIM.search(reply_text) and _RESULT_CLAIM.search(reply_text))
