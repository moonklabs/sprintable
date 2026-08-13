"""story #2603 P0(delivery-contract-blueprint-v0-1) — 에이전트 안정 @handle: 생성 + 파싱.

FE 구조화 피커가 채우는 `ConversationMessage.mentioned_ids`(UUID 배열)는 API/MCP 발신
경로엔 대응하는 필드가 없다(#2602 지도 ⑦ 발견 — `SendChatInput`엔 entity-mention용
`mentions`만 있고 팀원 @멘션 필드가 없음). 그래서 Hermes/OpenClaw 같은 외부 런타임이
응답 본문에 "@다른에이전트" 텍스트를 써도 서버는 그걸 구조화 신호로 못 본다 — require_mention/
mentions 계약이 정확히 이 시나리오에서 헛돌게 되는 근본 갭. 이 모듈이 그 갭을 닫는다.

`extract_handle_mentions`는 본문에서 `@handle` 토큰을 뽑아 `members.handle`(org+type='agent'
스코프, 대소문자 무관 **정확 일치**)로 member_id를 해소한다 — 부분 문자열 오매칭 금지(AC4):
word-boundary 정규식 + DB WHERE lower(handle)=lower(token) 정확 일치만 사용, LIKE/substring
비교를 쓰지 않는다. 호출부(conversations.py)가 이 결과를 FE의 `mentioned_ids`와 **합집합**
한다 — 이 모듈은 대체가 아니라 보완이다(entity-mention `mention_parser.py`와는 완전히
별개 개념·문법·write-target — 저 모듈은 건드리지 않는다).
"""
from __future__ import annotations

import re
import unicodedata
import uuid

from sqlalchemy import select, func
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.member import Member

# word-boundary: `@` 앞이 단어문자가 아니어야(이메일 `user@host`의 `@host`를 멘션으로 오인 안 함).
# handle 문자셋은 슬러그 규칙(영숫자+하이픈)과 대칭 — generate_unique_handle이 만드는 형태만 매치.
_HANDLE_TOKEN_RE = re.compile(r"(?<![\w@])@([a-zA-Z0-9][a-zA-Z0-9-]{0,63})\b")


def extract_handle_tokens(content: str) -> list[str]:
    """본문에서 `@handle` 토큰 후보를 순서 보존 + 중복 제거로 뽑는다(DB 조회 없는 순수 함수).
    존재 여부/정확 일치는 `resolve_handle_mentions`가 DB에서 판정한다 — 이 함수는 모양만 본다."""
    if not content:
        return []
    seen: set[str] = set()
    result: list[str] = []
    for m in _HANDLE_TOKEN_RE.finditer(content):
        token = m.group(1)
        key = token.lower()
        if key not in seen:
            seen.add(key)
            result.append(token)
    return result


async def resolve_handle_mentions(
    db: AsyncSession, *, org_id: uuid.UUID, content: str,
) -> set[uuid.UUID]:
    """본문의 `@handle` 토큰을 실재하는 에이전트 member_id 집합으로 해소한다.

    정확 일치만(대소문자 무관) — 존재하지 않는 handle·휴먼(handle 없음)·타 org 에이전트는
    자연히 매치 0(별도 존재-검사 불요, WHERE 자체가 org+type로 스코프됨). 빈 결과 = 빈 집합
    (DB 왕복 없이 조기 반환 — 토큰이 없으면 조회도 없다)."""
    tokens = extract_handle_tokens(content)
    if not tokens:
        return set()
    lowered = {t.lower() for t in tokens}
    rows = (await db.execute(
        select(Member.id).where(
            Member.org_id == org_id,
            Member.type == "agent",
            Member.handle.isnot(None),
            func.lower(Member.handle).in_(lowered),
        )
    )).scalars().all()
    return set(rows)


def slugify_handle_base(name: str) -> str:
    """이름 → ASCII 슬러그 후보(고유성 보장 전 base). 결과가 빈 문자열이면(이름이 전부
    비ASCII, 예: 순한글 이름) 호출부가 "agent" 폴백을 쓴다 — @handle 파서가 word-boundary
    정규식으로 매칭하므로 handle 자체는 ASCII 토큰이어야 안전(0241 마이그의 백필 로직과 동형,
    런타임 신규 생성용으로 별도 보관 — 마이그는 훗날 재실행 안 되므로 독립 사본이 맞다)."""
    normalized = unicodedata.normalize("NFKD", name).encode("ascii", "ignore").decode("ascii")
    return re.sub(r"[^a-zA-Z0-9]+", "-", normalized).strip("-").lower()


async def generate_unique_handle(db: AsyncSession, *, org_id: uuid.UUID, name: str) -> str:
    """신규 에이전트 생성 시 handle 자동 채번 — base가 org 내에서 겹치면 -2/-3...로 해소.

    호출부(agent_anchor_sync.py)가 members INSERT **전에** 이 값을 계산해 넣는다(그 INSERT
    자체는 ON CONFLICT DO NOTHING(id)뿐이라 handle 충돌은 여기서 미리 막아야 함 — DB의
    partial unique index(uq_members_org_handle_lower)가 최종 방어선)."""
    base = slugify_handle_base(name) or "agent"
    existing = set((await db.execute(
        select(func.lower(Member.handle)).where(
            Member.org_id == org_id, Member.handle.isnot(None),
        )
    )).scalars().all())
    candidate = base
    n = 2
    while candidate.lower() in existing:
        candidate = f"{base}-{n}"
        n += 1
    return candidate
