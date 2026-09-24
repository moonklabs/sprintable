"""story #4224(페드루 PO 판단 2026-09-23 22:35Z) — 요청 로케일이 없는 발행(서버 자동 발행 · 헤더 없는 HTTP 발행)이 쓸
«org 기준 언어». 조직엔 locale 컬럼이 없다(있는 건 `users.locale` · 요청 헤더) — 그래서 정책을 여기 한 곳에 둔다:

- org 기준 언어 = **가장 먼저 소유자가 된 사람 중 지원 로케일을 설정해 둔 사람**의 `users.locale`
  (소유자 여럿 → `org_members.created_at` 오름차순 · 같으면 id 순으로 첫 번째. 로케일 미설정·미지원 소유자는 건너뜀).
- 그런 소유자가 없으면(소유자 0 · 전원 미설정) `DEFAULT_LOCALE`.

나중에 조직 로케일 컬럼이 생기면 이 함수만 바꾼다(호출부는 «org 기준 언어»만 묻는다). HTTP 발행의 요청 로케일 우선
(`resolve_locale_from_request`)은 그대로 — 이 함수는 요청 로케일이 없을 때의 폴백이다.
"""
from __future__ import annotations

import uuid

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.project import OrgMember
from app.models.user import User
from app.services.agent_onboarding_config import DEFAULT_LOCALE, SUPPORTED_LOCALES

__all__ = ["resolve_org_locale"]


async def resolve_org_locale(db: AsyncSession, org_id: uuid.UUID) -> str:
    rows = (await db.execute(
        select(User.locale)
        .join(OrgMember, OrgMember.user_id == User.id)
        .where(
            OrgMember.org_id == org_id,
            OrgMember.role == "owner",
            OrgMember.deleted_at.is_(None),
            User.locale.in_(SUPPORTED_LOCALES),
        )
        .order_by(OrgMember.created_at.asc(), OrgMember.id.asc())
        .limit(1)
    )).scalars().first()
    return rows if rows in SUPPORTED_LOCALES else DEFAULT_LOCALE
