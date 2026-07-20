import uuid

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy import select, text
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.config import settings
from app.dependencies.auth import AuthContext, get_current_user
from app.dependencies.database import get_db
from app.models.user import User
from app.repositories.organization import OrganizationRepository
from app.services.agent_anchor_sync import ensure_human_member
from app.services.entity_slug import (
    RESERVED_WORKSPACE_SLUGS,
    is_valid_slug_format,
    is_workspace_slug_taken,
)
from app.schemas.organization import (
    CreateOrganization,
    DeleteOrganization,
    MyOrganizationResponse,
    OrgImpactResponse,
    OrganizationResponse,
    UpdateOrganization,
)

router = APIRouter(prefix="/api/v2/organizations", tags=["organizations", "Organization"])


def _get_repo(session: AsyncSession = Depends(get_db)) -> OrganizationRepository:
    return OrganizationRepository(session)


@router.get("", response_model=list[MyOrganizationResponse])
async def list_my_organizations(
    auth: AuthContext = Depends(get_current_user),
    repo: OrganizationRepository = Depends(_get_repo),
) -> list[MyOrganizationResponse]:
    """인증된 사용자가 속한 Organization 목록 조회."""
    items = await repo.list_for_user(uuid.UUID(auth.user_id))
    return [
        MyOrganizationResponse(id=o.id, name=o.name, slug=o.slug, plan=o.plan, role=o.role)
        for o in items
    ]


@router.post("", response_model=OrganizationResponse, status_code=201)
async def create_organization(
    body: CreateOrganization,
    auth: AuthContext = Depends(get_current_user),
    repo: OrganizationRepository = Depends(_get_repo),
    session: AsyncSession = Depends(get_db),
) -> OrganizationResponse:
    # 이메일 미인증 사용자는 org 생성 차단
    user_result = await session.execute(select(User).where(User.id == uuid.UUID(auth.user_id)))
    user = user_result.scalar_one_or_none()
    if user and not user.email_verified:
        raise HTTPException(status_code=403, detail="Email verification required to create organization")

    # EE: Free 플랜 org 생성 제한 (OSS에서는 로드되지 않음)
    if settings.is_ee_enabled:
        from ee.plan_limits import check_org_create_limit  # type: ignore[import]
        await check_org_create_limit(session, auth.user_id)

    # story 139d2405(S-slug-infra): workspace slug=root bare 경로라 앱 라우트 예약어와 충돌
    # 방지(형식도 함께 방어 — URL path segment).
    if not is_valid_slug_format(body.slug):
        raise HTTPException(status_code=400, detail="Invalid slug format")
    if body.slug in RESERVED_WORKSPACE_SLUGS:
        raise HTTPException(status_code=400, detail="Slug is reserved")

    org = await repo.create(name=body.name, slug=body.slug, owner_member_id=body.owner_member_id)
    if org is None:
        raise HTTPException(status_code=409, detail="Slug already exists")

    # OSS bootstrap: owner_member_id 미전달 시 auth.user_id로 직접 org_member 생성
    if body.owner_member_id is None and auth.user_id:
        await session.execute(
            text(
                "INSERT INTO org_members (id, org_id, user_id, role)"
                " VALUES (gen_random_uuid(), :org_id, :user_id, 'owner')"
                " ON CONFLICT (org_id, user_id) DO NOTHING"
            ),
            {"org_id": str(org.id), "user_id": auth.user_id},
        )
        # 휴먼 members 앵커 보장(#1317 휴먼판): org_member.id를 (신규/기존 무관) 재조회 후
        # ensure_human_member 호출. ON CONFLICT DO NOTHING이라 RETURNING 불가 → SELECT로 캡처.
        om_id = (
            await session.execute(
                text(
                    "SELECT id FROM org_members"
                    " WHERE org_id = :org_id AND user_id = :user_id"
                    " AND deleted_at IS NULL LIMIT 1"
                ),
                {"org_id": str(org.id), "user_id": auth.user_id},
            )
        ).scalar_one_or_none()
        if om_id is not None:
            await ensure_human_member(session, om_id)
        await session.commit()

    return OrganizationResponse.model_validate(org)


@router.get("/resolve", response_model=MyOrganizationResponse)
async def resolve_organization_by_slug(
    slug: str,
    auth: AuthContext = Depends(get_current_user),
    repo: OrganizationRepository = Depends(_get_repo),
) -> MyOrganizationResponse:
    """story 139d2405(S-slug-infra): workspace slug → org 해소(S-route-workspace FE middleware가
    소비 예정). 전역 유일이라 org_id 사전지정 불요. 비소속이면 404(존재 노출 금지 — get_organization
    과 동형 원칙). ⚠️`/{id}` 라우트보다 먼저 등록해야 "resolve"가 UUID 파싱으로 새지 않는다."""
    org = await repo.get_by_slug(slug)
    if org is None:
        raise HTTPException(status_code=404, detail="Organization not found")
    role = await repo.get_member_role(org_id=org.id, user_id=uuid.UUID(auth.user_id))
    if role is None:
        raise HTTPException(status_code=404, detail="Organization not found")
    return MyOrganizationResponse(id=org.id, name=org.name, slug=org.slug, plan=org.plan, role=role)


@router.get("/{id}", response_model=OrganizationResponse)
async def get_organization(
    id: uuid.UUID,
    auth: AuthContext = Depends(get_current_user),
    repo: OrganizationRepository = Depends(_get_repo),
) -> OrganizationResponse:
    """단일 Organization 조회 — 소속 멤버만."""
    role = await repo.get_member_role(org_id=id, user_id=uuid.UUID(auth.user_id))
    if role is None:
        raise HTTPException(status_code=404, detail="Organization not found")
    org = await repo.get(id)
    if org is None:
        raise HTTPException(status_code=404, detail="Organization not found")
    return OrganizationResponse.model_validate(org)


@router.patch("/{id}", response_model=OrganizationResponse)
async def update_organization(
    id: uuid.UUID,
    body: UpdateOrganization,
    auth: AuthContext = Depends(get_current_user),
    repo: OrganizationRepository = Depends(_get_repo),
    session: AsyncSession = Depends(get_db),
) -> OrganizationResponse:
    """Organization 이름/슬러그 수정 — owner/admin만 가능."""
    role = await repo.get_member_role(org_id=id, user_id=uuid.UUID(auth.user_id))
    if role is None:
        raise HTTPException(status_code=404, detail="Organization not found")
    if role not in ("owner", "admin"):
        raise HTTPException(status_code=403, detail="owner or admin role required")

    org = await repo.get(id)
    if org is None:
        raise HTTPException(status_code=404, detail="Organization not found")

    if body.name is not None:
        org.name = body.name

    # story 139d2405(S-slug-infra): workspace rename — 형식/예약어/전역 유일성(자기 제외) 검증 +
    # 이력 기록(향후 S-route-workspace의 301 해소용). old==new(무변경 재전송)면 이력 skip.
    if body.slug is not None and body.slug != org.slug:
        if not is_valid_slug_format(body.slug):
            raise HTTPException(status_code=400, detail="Invalid slug format")
        if body.slug in RESERVED_WORKSPACE_SLUGS:
            raise HTTPException(status_code=400, detail="Slug is reserved")
        if await is_workspace_slug_taken(session, body.slug, exclude_org_id=id):
            raise HTTPException(status_code=409, detail="Slug already exists")
        from app.models.entity_slug_history import EntitySlugHistory
        session.add(EntitySlugHistory(
            org_id=id, entity_type="organization", entity_id=id,
            old_slug=org.slug, new_slug=body.slug,
        ))
        org.slug = body.slug

    await session.flush()
    await session.refresh(org)
    await session.commit()
    return OrganizationResponse.model_validate(org)


@router.get("/{id}/impact", response_model=OrgImpactResponse)
async def get_org_impact(
    id: uuid.UUID,
    auth: AuthContext = Depends(get_current_user),
    repo: OrganizationRepository = Depends(_get_repo),
) -> OrgImpactResponse:
    """삭제 전 영향도 조회 — owner만 호출 가능."""
    role = await repo.get_member_role(org_id=id, user_id=uuid.UUID(auth.user_id))
    if role is None:
        raise HTTPException(status_code=404, detail="Organization not found")
    if role != "owner":
        raise HTTPException(status_code=403, detail="owner role required")

    impact = await repo.get_impact(org_id=id)
    return OrgImpactResponse(
        project_count=impact.project_count,
        member_count=impact.member_count,
        has_active_subscription=impact.has_active_subscription,
    )


@router.delete("/{id}", status_code=200)
async def delete_organization(
    id: uuid.UUID,
    body: DeleteOrganization,
    auth: AuthContext = Depends(get_current_user),
    repo: OrganizationRepository = Depends(_get_repo),
    session: AsyncSession = Depends(get_db),
) -> dict:
    """Organization 삭제 — owner만 가능, org name 확인 입력 필수."""
    result = await repo.delete_by_user(
        org_id=id,
        user_id=uuid.UUID(auth.user_id),
        confirmation=body.confirmation,
    )
    if not result["ok"]:
        reason = result.get("reason")
        if reason == "not_found":
            raise HTTPException(status_code=404, detail="Organization not found")
        if reason == "forbidden":
            raise HTTPException(status_code=403, detail="Only owner can delete organization")
        if reason == "confirmation_mismatch":
            raise HTTPException(status_code=422, detail="Confirmation does not match organization name")
        if reason == "active_subscription":
            raise HTTPException(status_code=409, detail="Cannot delete organization with active subscription")
    await session.commit()
    return {"ok": True}
