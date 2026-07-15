"""story 139d2405(S-slug-infra): workspace(organization)/project slug 유일성·예약어·이력.

slugify 자체는 app.services.doc_slug.slugify 재사용(유니코드 NFC 계약 동일·발명 0) — 여기선
workspace(전역 유일)·project(org-scoped 유일) 두 스코프의 충돌 해소 + workspace 전용 예약어
denylist만 추가한다.
"""
from __future__ import annotations

import re
import uuid

from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.services.doc_slug import MAX_SLUG_LEN, slugify

# 클라이언트가 직접 slug를 지정하는 경로(org/project 생성·rename) 용 형식 가드 — slugify()
# 산출물과 동형 문자 집합(소문자 라틴+숫자+하이픈, 앞뒤 하이픈 금지)만 허용. 유니코드(한글 등)
# slug는 auto-derive(slugify) 경로로만 나오게 하고 client raw 입력은 URL-safe ASCII로 제한
# (workspace/project slug는 URL path segment라 인코딩 이슈 회피가 우선).
_SLUG_FORMAT_RE = re.compile(r"^[a-z0-9]+(-[a-z0-9]+)*$")


def is_valid_slug_format(slug: str) -> bool:
    return bool(slug) and bool(_SLUG_FORMAT_RE.match(slug))

# 유나 doc org-1st-class-surface-ia-design-b §2a — root bare workspace slug라 앱 라우트와
# 충돌 방지(GitHub org 예약어 관례). project slug는 workspace 하위(non-root)라 denylist 불요.
RESERVED_WORKSPACE_SLUGS: frozenset[str] = frozenset({
    "api", "login", "logout", "onboarding", "settings", "organization", "o", "admin",
    "help", "static", "_next", "404",
})


class ReservedSlugError(ValueError):
    """workspace slug가 예약어 denylist에 해당."""


async def is_workspace_slug_taken(
    session: AsyncSession, slug: str, exclude_org_id: uuid.UUID | None = None,
) -> bool:
    """workspace(organization) slug는 root bare 네임스페이스라 org 무관 전역 유일."""
    from app.models.organization import Organization

    conds = [Organization.slug == slug]
    if exclude_org_id is not None:
        conds.append(Organization.id != exclude_org_id)
    row = await session.execute(select(func.count()).select_from(Organization).where(*conds))
    return (row.scalar() or 0) > 0


async def resolve_unique_workspace_slug(
    session: AsyncSession, base: str, exclude_org_id: uuid.UUID | None = None,
) -> str:
    """base가 예약어거나 충돌이면 `-2`,`-3`… suffix로 유일 slug 산출.

    base는 이미 slugify된 비어있지 않은 값 가정. 예약어인 base 자체는 무조건 suffix부터
    시작(그래야 "admin"이 "admin-2"로 자동 우회되지 재시도 없이 400 나지 않는다).
    """
    n = 2
    candidate = base
    while candidate in RESERVED_WORKSPACE_SLUGS or await is_workspace_slug_taken(
        session, candidate, exclude_org_id,
    ):
        suffix = f"-{n}"
        trimmed = base[: MAX_SLUG_LEN - len(suffix)].rstrip("-")
        candidate = f"{trimmed}{suffix}"
        n += 1
    return candidate


async def is_project_slug_taken(
    session: AsyncSession, org_id: uuid.UUID, slug: str, exclude_project_id: uuid.UUID | None = None,
) -> bool:
    """project slug는 workspace(org) 내 유일 — 다른 org의 동일 slug는 무관."""
    from app.models.project import Project

    conds = [Project.org_id == org_id, Project.slug == slug, Project.deleted_at.is_(None)]
    if exclude_project_id is not None:
        conds.append(Project.id != exclude_project_id)
    row = await session.execute(select(func.count()).select_from(Project).where(*conds))
    return (row.scalar() or 0) > 0


async def resolve_unique_project_slug(
    session: AsyncSession, org_id: uuid.UUID, base: str, exclude_project_id: uuid.UUID | None = None,
) -> str:
    if not await is_project_slug_taken(session, org_id, base, exclude_project_id):
        return base
    n = 2
    while True:
        suffix = f"-{n}"
        trimmed = base[: MAX_SLUG_LEN - len(suffix)].rstrip("-")
        candidate = f"{trimmed}{suffix}"
        if not await is_project_slug_taken(session, org_id, candidate, exclude_project_id):
            return candidate
        n += 1


__all__ = [
    "slugify",
    "is_valid_slug_format",
    "RESERVED_WORKSPACE_SLUGS",
    "ReservedSlugError",
    "is_workspace_slug_taken",
    "resolve_unique_workspace_slug",
    "is_project_slug_taken",
    "resolve_unique_project_slug",
]
