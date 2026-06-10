"""Doc slug 파생·유일화 (Part A 4dd399c6).

slugify 계약(FE `generateSlug`와 parity·언어차 드리프트 방지):
  1. **유니코드 NFC 정규화**(맨 앞·필수) — 한글 조합형/분해형 코드포인트 분기 제거.
     없으면 ① 입력원별 슬러그 바이트 분기(parity 깨짐) ② 같은 제목→다른 슬러그(uniqueness 무력화)
     ③ max200이 NFD 자모 단위로 왜곡.
  2. strip → lower(라틴 등 cased만 실효, 한글은 no-op)
  3. 공백 run → 단일 `-`
  4. 보존 = 유니코드 letter(`L*`) ∪ number(`N*`); `_` 포함 그 외 기호 제거
  5. `-` 축약 + 양끝 trim
  6. max 200 codepoint(초과 시 자르고 끝 `-` 정리)
정규화 후 빈 문자열 가능 — 호출부가 auto(=untitled 유지) vs explicit(=422) 분기.

⚠️ Python stdlib `re`는 `\\p{L}` 미지원 → `unicodedata.category()` 앞글자로 동치 구현
   (JS `/u` `\\p{L}/\\p{N}`와 동일 결과 보장).
"""
from __future__ import annotations

import re
import unicodedata
import uuid

from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

MAX_SLUG_LEN = 200

_WS_RE = re.compile(r"\s+")
_DASH_RUN_RE = re.compile(r"-{2,}")


def slugify(title: str) -> str:
    """제목 → slug. 계약은 모듈 docstring 참조. 빈 결과 가능(호출부 분기)."""
    if not title:
        return ""
    s = unicodedata.normalize("NFC", title).strip().lower()
    s = _WS_RE.sub("-", s)
    chars: list[str] = []
    for ch in s:
        if ch == "-":
            chars.append("-")
            continue
        # 유니코드 letter/number만 보존 ( '_'(Pc) 및 기타 기호·구두점 제거 )
        if unicodedata.category(ch)[0] in ("L", "N"):
            chars.append(ch)
    slug = _DASH_RUN_RE.sub("-", "".join(chars)).strip("-")
    if len(slug) > MAX_SLUG_LEN:
        slug = slug[:MAX_SLUG_LEN].rstrip("-")
    return slug


async def is_slug_taken(
    session: AsyncSession,
    org_id: uuid.UUID,
    project_id: uuid.UUID,
    slug: str,
    exclude_doc_id: uuid.UUID | None = None,
) -> bool:
    """동일 project 내 비삭제 doc 가 이 slug 를 이미 쓰는지(자기 제외)."""
    from app.models.doc import Doc

    conds = [
        Doc.org_id == org_id,
        Doc.project_id == project_id,
        Doc.slug == slug,
        Doc.deleted_at.is_(None),
    ]
    if exclude_doc_id is not None:
        conds.append(Doc.id != exclude_doc_id)
    row = await session.execute(select(func.count()).select_from(Doc).where(*conds))
    return (row.scalar() or 0) > 0


async def resolve_unique_slug(
    session: AsyncSession,
    org_id: uuid.UUID,
    project_id: uuid.UUID,
    base: str,
    exclude_doc_id: uuid.UUID | None = None,
) -> str:
    """base 가 충돌이면 `-2`,`-3` … suffix 로 유일 slug 산출. 길이 가드 포함.

    base 는 이미 slugify 된 비어있지 않은 값 가정.
    """
    if not await is_slug_taken(session, org_id, project_id, base, exclude_doc_id):
        return base
    n = 2
    while True:
        suffix = f"-{n}"
        trimmed = base[: MAX_SLUG_LEN - len(suffix)].rstrip("-")
        candidate = f"{trimmed}{suffix}"
        if not await is_slug_taken(session, org_id, project_id, candidate, exclude_doc_id):
            return candidate
        n += 1
