import uuid

from fastapi import APIRouter, Depends, HTTPException, Query, status
from sqlalchemy import select, text
from sqlalchemy.ext.asyncio import AsyncSession

from app.dependencies.auth import AuthContext, get_current_user
from app.dependencies.database import get_db
from app.models.user import User
from app.repositories.organization import OrganizationRepository
from app.schemas.organization import (
    CreateOrganization,
    DeleteOrganization,
    MyOrganizationResponse,
    OrgImpactResponse,
    OrganizationResponse,
    UpdateOrganization,
)

router = APIRouter(prefix="/api/v2/organizations", tags=["organizations"])


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
        await session.commit()

    return OrganizationResponse.model_validate(org)


@router.patch("/{id}", response_model=OrganizationResponse)
async def update_organization(
    id: uuid.UUID,
    body: UpdateOrganization,
    auth: AuthContext = Depends(get_current_user),
    repo: OrganizationRepository = Depends(_get_repo),
    session: AsyncSession = Depends(get_db),
) -> OrganizationResponse:
    """Organization 이름 수정 — owner/admin만 가능."""
    role = await repo.get_member_role(org_id=id, user_id=uuid.UUID(auth.user_id))
    if role is None:
        raise HTTPException(status_code=404, detail="Organization not found")
    if role not in ("owner", "admin"):
        raise HTTPException(status_code=403, detail="owner or admin role required")

    org = await repo.update_name(org_id=id, name=body.name)
    if org is None:
        raise HTTPException(status_code=404, detail="Organization not found")

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
