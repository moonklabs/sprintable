"""story #2282(E-CONNECT) — 참조 토큰 빌더. 단일 SSOT(AC2).

⛔이 문자열 포맷은 FE `apps/web/src/components/chat/chat-input.tsx`의 `applyEntity`가
`#`-검색 picker로 엔티티를 선택할 때 만드는 것과 **정확히 같은 것**이어야 한다 — 같은 규칙이
JS/Python 두 군데에 따로 있으면 한쪽이 조용히 뒤처진다(이 세션 내내 잡은 "쌍둥이 체계" 함정과
동형: 빌드 프로필 플래그·MCP 경로 선언·브랜치 기반·알림 두 소스). 그래서 응답 필드(각 response
schema의 `reference_token` computed field)와 MCP 도구 설명(AC6) 둘 다 이 함수 하나만 부른다.

⛔⭐PO 판정(2026-07-28, critical) — AC3 실측이 «보안 결함»이었다: FE `applyEntity`는 title을
전혀 escape하지 않는데, 형제 함수 `applyAsset`(파일명 삽입)은 `[ ] ( ) \\`와 개행을
escape한다(그 함수 자신의 코멘트: "markdown-link 토큰 구조를 변조 → phishing 링크 렌더
차단"). **한쪽은 위험을 알고 막았는데 다른 쪽은 안 막은 것**이라 — 그 주석 자체가 "이게
위험하다"는 선언이니 "몰랐다"로 볼 수 없는 자리다. 그리고 실측(2026-07-28): `[TAG] 제목`류
접두사가 이 조직의 실제 명명 관례라(`[E-ARCH]`·`[E-CONNECT]`·`[C-8]` 등, entities/search
쿼리 4개가 전부 캡(10건)까지 찬 것으로 확인) — escape 없이 나갔으면 그런 제목 거의 전부가
첫 배포부터 깨진 토큰을 냈을 것이다.

⇒ 이 함수는 **`applyAsset`과 같은 규칙**으로 title을 escape한다(두 FE 함수끼리도 규칙이
갈리면 그게 또 다른 비대칭이 되므로, 새 규칙을 발명하지 않고 이미 있는 안전한 규칙을 그대로
가져온다). FE `applyEntity` 자체의 수정은 별도 스토리(critical, 미르코군 담당)로 분리했다 —
이 함수(BE 응답이 실제로 내보내는 토큰)는 이 PR에서 즉시 안전해진다.

⛔FE의 trailing space(`) `)는 텍스트에어리어 삽입 편의(캐럿을 스페이스 뒤에 두는 것)이지
토큰 자체의 일부가 아니다 — 이 함수가 반환하는 토큰 문자열엔 trailing space가 없다. parity
검증(AC3)은 `[title](entity:type:id)` 몸통에 대해서만 한다.
"""
from __future__ import annotations

import re
import uuid

from app.services.reference_registry import is_registered_entity_type

# FE `applyAsset`(chat-input.tsx)과 동일 규칙: `\ [ ] ( )`를 backslash-escape.
_UNSAFE_CHARS_RE = re.compile(r"[\\\[\]()]")
_NEWLINE_RUN_RE = re.compile(r"[\r\n]+")


def _escape_title(title: str) -> str:
    escaped = _UNSAFE_CHARS_RE.sub(lambda m: "\\" + m.group(0), title)
    return _NEWLINE_RUN_RE.sub(" ", escaped)


def build_reference_token(entity_type: str, entity_id: uuid.UUID, title: str) -> str | None:
    """이 엔티티를 가리키는 참조 토큰을 만든다.

    AC5: `entity_type`이 `ENTITY_RESOLVERS`(존재판정 가능·현재 doc/story/epic)에 없으면
    `None`을 반환한다 — 줄 수 없는 것을 준 것처럼 보이면 그게 거짓이다. 호출부(각 response
    schema의 computed field)는 `None`이면 필드를 그대로 `None`으로 낸다(생략이 아니라 명시적
    null — 필드 자체는 항상 존재하되 "지원 안 함"이 값으로 드러난다)."""
    if not is_registered_entity_type(entity_type):
        return None
    return f"[{_escape_title(title)}](entity:{entity_type}:{entity_id})"
