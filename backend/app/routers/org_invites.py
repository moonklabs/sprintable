import uuid

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.ext.asyncio import AsyncSession

from app.dependencies.auth import AuthContext, get_current_user
from app.dependencies.database import get_db
from app.repositories.org_invite import OrgInviteRepository
from app.repositories.organization import OrganizationRepository
from app.schemas.org_invite import CreateOrgInvite, OrgInviteResponse

router = APIRouter(prefix="/api/v2/organizations", tags=["org-invites"])


def _get_invite_repo(session: AsyncSession = Depends(get_db)) -> OrgInviteRepository:
    return OrgInviteRepository(session)


def _get_org_repo(session: AsyncSession = Depends(get_db)) -> OrganizationRepository:
    return OrganizationRepository(session)


async def _require_owner_or_admin(
    id: uuid.UUID,
    auth: AuthContext,
    org_repo: OrganizationRepository,
) -> None:
    role = await org_repo.get_member_role(org_id=id, user_id=uuid.UUID(auth.user_id))
    if role is None:
        raise HTTPException(status_code=404, detail="Organization not found")
    if role not in ("owner", "admin"):
        raise HTTPException(status_code=403, detail="owner or admin role required")


@router.get("/{id}/invites", response_model=list[OrgInviteResponse])
async def list_org_invites(
    id: uuid.UUID,
    auth: AuthContext = Depends(get_current_user),
    invite_repo: OrgInviteRepository = Depends(_get_invite_repo),
    org_repo: OrganizationRepository = Depends(_get_org_repo),
) -> list[OrgInviteResponse]:
    """pending 초대 목록 — owner/admin만 조회 가능."""
    await _require_owner_or_admin(id, auth, org_repo)
    items = await invite_repo.list_pending(org_id=id)
    return [OrgInviteResponse.model_validate(i) for i in items]


@router.post("/{id}/invites", response_model=OrgInviteResponse, status_code=201)
async def create_org_invite(
    id: uuid.UUID,
    body: CreateOrgInvite,
    auth: AuthContext = Depends(get_current_user),
    invite_repo: OrgInviteRepository = Depends(_get_invite_repo),
    org_repo: OrganizationRepository = Depends(_get_org_repo),
    session: AsyncSession = Depends(get_db),
) -> OrgInviteResponse:
    """초대 생성 — owner/admin만 가능. 이미 가입된 email이나 중복 초대 시 409."""
    await _require_owner_or_admin(id, auth, org_repo)

    if await invite_repo.is_already_member(org_id=id, email=body.email):
        raise HTTPException(status_code=409, detail="Email already a member of this organization")

    invite = await invite_repo.create(
        org_id=id,
        email=body.email,
        role=body.role,
        created_by=uuid.UUID(auth.user_id),
    )
    if invite is None:
        raise HTTPException(status_code=409, detail="Invite already exists for this email")

    await session.commit()
    return OrgInviteResponse.model_validate(invite)


@router.delete("/{id}/invites/{invite_id}", response_model=OrgInviteResponse)
async def revoke_org_invite(
    id: uuid.UUID,
    invite_id: uuid.UUID,
    auth: AuthContext = Depends(get_current_user),
    invite_repo: OrgInviteRepository = Depends(_get_invite_repo),
    org_repo: OrganizationRepository = Depends(_get_org_repo),
    session: AsyncSession = Depends(get_db),
) -> OrgInviteResponse:
    """초대 취소 — owner/admin만 가능."""
    await _require_owner_or_admin(id, auth, org_repo)

    invite = await invite_repo.revoke(invite_id=invite_id, org_id=id)
    if invite is None:
        raise HTTPException(status_code=404, detail="Invite not found")

    await session.commit()
    return OrgInviteResponse.model_validate(invite)
