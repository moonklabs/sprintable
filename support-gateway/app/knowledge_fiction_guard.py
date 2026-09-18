"""story #3262(지원v1·4지식원) 하드 AC — story #3261 done 처리 직후 페드루 PO 재실측(2026-08-31
12시)에서 드러난 **2차 날조 얼굴**의 구조적 차단. story #3261의 no_fiction_guard.py가 막는
것("escalate 안 불렀는데 연결됐다/실패했다 서술")과는 다른 축이다 — 이건 "지식 Task가 실
결과를 못 준 상태에서 구체적인 제품 조작법·링크를 자유 생성"하는 축.

**실측된 사고(재현 원문, 회귀 테스트에 그대로 박음)**: 「팀원을 초대하려면?」질문에 지식원이
아직 없던 시점, Interaction 모델이 확신조로 "설정>사용자 및 권한>사용자 초대" 메뉴 경로와
"example.com/invite" 가짜 링크를 지어내 답했다(8.7초·escalated=false, knowledge_search
호출도 안 됨). 이제 지식원이 연결됐지만(이 스토리), knowledge_search가 관련 문서를 못 찾은
경우(고아 질문·오타·범위 밖 질문)엔 여전히 같은 지어내기가 재발할 수 있어 구조적 안전망이
필요하다 — 시스템 프롬프트 강화만으론 LLM이 지시를 무시할 수 있다(no_fiction_guard.py와
동일 원리).

탐지 대상은 "구체적인 제품 조작 정보처럼 보이는 두 패턴"만 좁게 잡는다(과탐 방지 — 이
패턴 밖 일반 안내문은 절대 안 건드린다):
- URL/도메인: 실제 지식원 근거가 없는데 링크를 언급하면 그 자체가 지어낸 것이다(진짜
  링크라도 지식원 밖에서 나왔다면 이 서비스 입장에선 검증 안 된 주장 — 안전측으로 차단).
- 메뉴 브레드크럼: "설정>권한>초대"류 ">" 구분 경로 서술 — 실제 UI 구조를 안다는 확신조
  서술은 지식원 근거 없이는 나올 수 없다."""
from __future__ import annotations

import re

_URL_PATTERN = re.compile(r"https?://\S+|\b[a-zA-Z0-9][a-zA-Z0-9-]*\.(com|io|net|dev|app|co\.kr|kr)\b")
_MENU_BREADCRUMB_PATTERN = re.compile(r"[가-힣A-Za-z0-9]+ ?> ?[가-힣A-Za-z0-9]+")

FALLBACK_REPLY = (
    "죄송합니다, 정확한 안내를 드리기 위해 확인이 필요한 질문이네요. 담당자에게 연결해 드릴게요."
)


def looks_like_fabricated_product_instructions(reply_text: str) -> bool:
    return bool(_URL_PATTERN.search(reply_text) or _MENU_BREADCRUMB_PATTERN.search(reply_text))
