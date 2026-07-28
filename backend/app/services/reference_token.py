"""story #2282(E-CONNECT) — 참조 토큰 빌더. 단일 SSOT(AC2).

⛔이 문자열 포맷은 FE `apps/web/src/components/chat/chat-input.tsx`의 `applyEntity`가
`#`-검색 picker로 엔티티를 선택할 때 만드는 것과 **정확히 같은 것**이어야 한다 — 같은 규칙이
JS/Python 두 군데에 따로 있으면 한쪽이 조용히 뒤처진다(이 세션 내내 잡은 "쌍둥이 체계" 함정과
동형: 빌드 프로필 플래그·MCP 경로 선언·브랜치 기반·알림 두 소스). 그래서 응답 필드(각 response
schema의 `reference_token` computed field)와 MCP 도구 설명(AC6) 둘 다 이 함수 하나만 부른다.

⛔AC3 실측(2026-07-28, origin/develop): FE `applyEntity`는 title을 **전혀 escape하지
않는다** — `` `[${title}](entity:${entityType}:${entityId}) ` `` 리터럴 삽입 그대로다.
형제 함수 `applyAsset`(파일명 삽입)은 `[ ] ( ) \\`와 개행을 escape하는데(그 함수 자신의
코멘트: "markdown-link 토큰 구조를 변조 → phishing 링크 렌더 차단") `applyEntity`에는 그
escape가 없다 — 즉 doc/story/epic **제목에 `]`나 `)`가 들어가면 토큰 구조가 깨질 수 있는
실제 취약점**이다. 이 함수는 그 부재를 "있는 척" 하지 않고 FE와 **동일하게 escape 없이**
만든다(AC3이 요구하는 건 parity 검증이지 새 escape 규칙을 여기서 발명하는 게 아니다 — FE도
같이 고쳐야 하는 별건이라 PO에게 별도 보고했다).

⛔FE의 trailing space(`) `)는 텍스트에어리어 삽입 편의(캐럿을 스페이스 뒤에 두는 것)이지
토큰 자체의 일부가 아니다 — 이 함수가 반환하는 토큰 문자열엔 trailing space가 없다. parity
검증(AC3)은 `[title](entity:type:id)` 몸통에 대해서만 한다.
"""
from __future__ import annotations

import uuid

from app.services.reference_registry import is_registered_entity_type


def build_reference_token(entity_type: str, entity_id: uuid.UUID, title: str) -> str | None:
    """이 엔티티를 가리키는 참조 토큰을 만든다.

    AC5: `entity_type`이 `ENTITY_RESOLVERS`(존재판정 가능·현재 doc/story/epic)에 없으면
    `None`을 반환한다 — 줄 수 없는 것을 준 것처럼 보이면 그게 거짓이다. 호출부(각 response
    schema의 computed field)는 `None`이면 필드를 그대로 `None`으로 낸다(생략이 아니라 명시적
    null — 필드 자체는 항상 존재하되 "지원 안 함"이 값으로 드러난다)."""
    if not is_registered_entity_type(entity_type):
        return None
    return f"[{title}](entity:{entity_type}:{entity_id})"
