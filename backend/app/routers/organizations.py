import uuid

from fastapi import APIRouter, Depends, HTTPException, Query, status
from sqlalchemy import select, text
from sqlalchemy.ext.asyncio import AsyncSession

from app.dependencies.auth import AuthContext, get_current_user
from app.dependencies.database import get_db
from app.models.user import User
from app.repositories.organization import OrganizationRepository
from app.schemas.organization import CreateOrganization, OrganizationResponse

router = APIRouter(prefix="/api/v2/organizations", tags=["organizations"])


def _get_repo(session: AsyncSession = Depends(get_db)) -> OrganizationRepository:
    return OrganizationRepository(session)


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


@router.delete("/{id}", status_code=200)
async def delete_organization(
    id: uuid.UUID,
    requester_member_id: uuid.UUID = Query(...),
    _auth: AuthContext = Depends(get_current_user),
    repo: OrganizationRepository = Depends(_get_repo),
) -> dict:
    result = await repo.delete(org_id=id, requester_member_id=requester_member_id)
    if not result["ok"]:
        reason = result.get("reason")
        if reason == "not_found":
            raise HTTPException(status_code=404, detail="Organization not found")
        if reason == "forbidden":
            raise HTTPException(status_code=403, detail="Only owner can delete organization")
        if reason == "active_subscription":
            raise HTTPException(status_code=409, detail="Cannot delete organization with active subscription")
    return {"ok": True}
