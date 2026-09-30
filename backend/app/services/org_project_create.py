"""story 4427 (나) piece 1 (PO 2026-09-30 01:38Z · design doc 9a4cb445 §4) — the writes of «create an organization» and
«create a project», taken out of their routers so one request can make both inside a single transaction.

Nothing here commits. `POST /organizations` and `POST /projects` call these and then commit exactly where they did before
(behaviour unchanged). The desktop setup's `confirm-new-org` (piece 2) will call them inside the confirmation's own
transaction, so a failure anywhere leaves no organization behind. The checks a caller needs first (e-mail verification,
plan limits) are the `check_*` functions, kept in the order the routers ran them."""
from __future__ import annotations

import uuid

from fastapi import HTTPException
from sqlalchemy import select, text
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.config import settings
from app.models.organization import Organization
from app.models.project import Project
from app.models.user import User
from app.repositories.organization import OrganizationRepository
from app.repositories.project import ProjectRepository
from app.services.agent_anchor_sync import ensure_human_member
from app.services.entity_slug import (
    RESERVED_WORKSPACE_SLUGS,
    is_project_slug_taken,
    is_valid_slug_format,
    resolve_unique_project_slug,
    resolve_unique_workspace_slug,
    slugify_ascii_or_fallback,
)


async def lock_first_org_path(session: AsyncSession, user_id: str | uuid.UUID) -> None:
    """story 4427 (나) · Qadir lens + PO 02:57Z — the three ways a person's organization comes to be (`confirm-new-org`, accepting
    an invite, `POST /organizations`) take this per-user lock first, so two tabs doing two of them at once cannot leave the
    person with two organizations: the second waits, then sees the first's membership. Transaction-scoped (released at commit
    or rollback) · 64-bit key (`hashtextextended`)."""
    await session.execute(text("SELECT pg_advisory_xact_lock(hashtextextended(:u, 0))"), {"u": str(user_id)})


async def check_org_create_allowed(session: AsyncSession, user_id: str) -> None:
    """E-mail verification, then the plan's owned-organization limit (EE) — what `POST /organizations` checks first."""
    await require_verified_email_for_org(session, user_id)
    await check_owned_org_limit(session, user_id)


async def require_verified_email_for_org(session: AsyncSession, user_id: str) -> None:
    """403 EMAIL_VERIFICATION_REQUIRED for an unverified person when the setting asks for it."""
    # 이메일 미인증 사용자는 org 생성 차단 — provider 미설정 셀프호스트는 설정으로 완화(SPR-13).
    if settings.require_verified_email_for_org_create:
        user = (await session.execute(select(User).where(User.id == uuid.UUID(user_id)))).scalar_one_or_none()
        if user and not user.email_verified:
            # story #2441 — dict detail so the FE can branch on the code (#2437: raw English with no next step).
            raise HTTPException(
                status_code=403,
                detail={
                    "code": "EMAIL_VERIFICATION_REQUIRED",
                    "message": "Email verification required to create organization",
                },
            )


async def check_owned_org_limit(session: AsyncSession, user_id: str) -> None:
    """The plan's owned-organization limit (EE only)."""
    # EE: Free 플랜 org 생성 제한 (OSS에서는 로드되지 않음)
    if settings.is_ee_enabled:
        from ee.plan_limits import check_org_create_limit  # type: ignore[import]

        await check_org_create_limit(session, user_id)


async def create_org_with_owner(
    session: AsyncSession,
    *,
    name: str,
    slug: str | None,
    user_id: str | None,
    owner_member_id: uuid.UUID | None,
    repo: OrganizationRepository | None = None,
) -> Organization:
    """The organization, its participation roles (repository), and its owner: `owner_member_id` when given (repository),
    else the calling person (`user_id`) as an `org_members` owner plus their human member anchor. Never commits.
    `repo` is the route's injected repository (its dependency stays overridable); other callers leave it out."""
    repo = repo or OrganizationRepository(session)
    if slug is not None:
        # story 139d2405(S-slug-infra): workspace slug=root bare 경로라 앱 라우트 예약어와 충돌
        # 방지(형식도 함께 방어 — URL path segment).
        if not is_valid_slug_format(slug):
            raise HTTPException(status_code=400, detail="Invalid slug format")
        if slug in RESERVED_WORKSPACE_SLUGS:
            raise HTTPException(status_code=400, detail="Slug is reserved")
    else:
        # story 4427: no slug sent → derive it (ASCII part of the name, or `workspace-<8 hex>` for a name with none)
        # and make it unique (reserved words and taken slugs get `-2`, `-3`…), the same helpers projects use.
        slug = await resolve_unique_workspace_slug(session, slugify_ascii_or_fallback(name, fallback_prefix="workspace"))
    org = await repo.create(name=name, slug=slug, owner_member_id=owner_member_id)
    if org is None:
        raise HTTPException(status_code=409, detail="Slug already exists")

    # OSS bootstrap: owner_member_id 미전달 시 auth.user_id로 직접 org_member 생성
    if owner_member_id is None and user_id:
        await session.execute(
            text(
                "INSERT INTO org_members (id, org_id, user_id, role)"
                " VALUES (gen_random_uuid(), :org_id, :user_id, 'owner')"
                " ON CONFLICT (org_id, user_id) DO NOTHING"
            ),
            {"org_id": str(org.id), "user_id": user_id},
        )
        # 휴먼 members 앵커 보장(#1317 휴먼판): org_member.id를 (신규/기존 무관) 재조회 후
        # ensure_human_member 호출. ON CONFLICT DO NOTHING이라 RETURNING 불가 → SELECT로 캡처.
        om_id = await _org_member_id(session, org.id, user_id)
        if om_id is not None:
            await ensure_human_member(session, om_id)
    return org


async def check_project_create_allowed(session: AsyncSession, org_id: uuid.UUID) -> None:
    """The plan's project limit (EE) — what `POST /projects` checks first."""
    if settings.is_ee_enabled:
        from ee.plan_limits import check_project_create_limit  # type: ignore[import]

        await check_project_create_limit(session, org_id)


async def create_project_with_member(
    session: AsyncSession,
    *,
    org_id: uuid.UUID,
    name: str,
    description: str | None,
    slug: str | None,
    user_id: str | None,
) -> Project:
    """The project (a sent slug is checked, else derived and made unique in the organization) and the calling person as an
    organization member (`member` when not one already) with their human member anchor. Never commits."""
    # story 139d2405(S-slug-infra): 명시 지정 시 형식 검증 + org 내 유일성(충돌 시 409 — organizations
    # create와 동형: 사용자가 명시한 값은 조용히 안 바꾼다). 미지정 시 name→kebab 파생 후 자동 유일화
    # (충돌 -n suffix — 시스템 파생값이라 조용히 바꿔도 됨).
    if slug is not None:
        if not is_valid_slug_format(slug):
            raise HTTPException(status_code=400, detail="Invalid slug format")
        if await is_project_slug_taken(session, org_id, slug):
            raise HTTPException(status_code=409, detail="Slug already exists")
    else:
        # story #2039(P0): 이전엔 slugify()(유니코드 보존)가 한글 등 비ASCII 이름을 그대로
        # slug에 실어 URL 라우팅이 깨졌다(app/services/entity_slug.py 상단 주석 근거 기록 참고).
        # ASCII 산출 실패(순수 비ASCII 이름) 시 id-fallback — name 자체는 그대로 저장/표시.
        slug = await resolve_unique_project_slug(session, org_id, slugify_ascii_or_fallback(name))
    project = await ProjectRepository(session, org_id).create(name=name, description=description, slug=slug)
    # project_memberships 테이블 미존재 — agent 자동 첨부는 agent 생성 시 project_id로 직접 연결.
    # Ensure the creating user is in org_members (S5: human type team_member 신규 생성 제거).
    if user_id:
        await session.execute(
            text(
                "INSERT INTO org_members (id, org_id, user_id, role)"
                " VALUES (gen_random_uuid(), :org_id, :user_id, 'member')"
                " ON CONFLICT (org_id, user_id) DO NOTHING"
            ),
            {"org_id": str(org_id), "user_id": user_id},
        )
        om_id = await _org_member_id(session, org_id, user_id)
        if om_id is not None:
            await ensure_human_member(session, om_id)
    return project


async def _org_member_id(session: AsyncSession, org_id: uuid.UUID, user_id: str):
    return (
        await session.execute(
            text(
                "SELECT id FROM org_members"
                " WHERE org_id = :org_id AND user_id = :user_id"
                " AND deleted_at IS NULL LIMIT 1"
            ),
            {"org_id": str(org_id), "user_id": user_id},
        )
    ).scalar_one_or_none()


async def has_active_org(session: AsyncSession, user_id: str | uuid.UUID) -> bool:
    """Whether the person belongs to any organization (a membership they left — `deleted_at` set — does not count: PO 02:57Z)."""
    return (await session.execute(
        text("SELECT EXISTS (SELECT 1 FROM org_members WHERE user_id = :u AND deleted_at IS NULL)"), {"u": str(user_id)},
    )).scalar_one()
