import uuid
from datetime import datetime, timezone

from fastapi import APIRouter, Depends, HTTPException, status
from sqlalchemy import update
from sqlalchemy.ext.asyncio import AsyncSession

from app.dependencies.auth import AuthContext, get_current_user, get_verified_org_id
from app.dependencies.database import get_db
from app.models.user import RefreshToken
from app.repositories.org_member import OrgMemberRepository
from app.schemas.org_member import ORG_ROLES, OrgMemberCreate, OrgMemberResponse, OrgMemberUpdate

router = APIRouter(prefix="/api/v2/org-members", tags=["org-members"])


def _get_repo(
    session: AsyncSession = Depends(get_db),
    org_id: uuid.UUID = Depends(get_verified_org_id),
) -> OrgMemberRepository:
    return OrgMemberRepository(session, org_id)


async def _require_admin(
    repo: OrgMemberRepository = Depends(_get_repo),
    auth: AuthContext = Depends(get_current_user),
) -> OrgMemberRepository:
    """DB에서 caller의 OrgMember role 확인 — owner 또는 admin만 통과."""
    caller = await repo.get_by_user(uuid.UUID(auth.user_id))
    if caller is None or caller.role not in ("owner", "admin"):
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="org admin 또는 owner 권한 필요",
        )
    return repo


@router.get("", response_model=list[OrgMemberResponse])
async def list_org_members(
    repo: OrgMemberRepository = Depends(_get_repo),
) -> list[OrgMemberResponse]:
    members = await repo.list()
    return [OrgMemberResponse.model_validate(m) for m in members]


@router.post("", response_model=OrgMemberResponse, status_code=201)
async def create_org_member(
    body: OrgMemberCreate,
    repo: OrgMemberRepository = Depends(_require_admin),
) -> OrgMemberResponse:
    if body.role not in ORG_ROLES:
        raise HTTPException(status_code=400, detail=f"role must be one of: {', '.join(ORG_ROLES)}")
    # repo.org_id는 JWT에서 추출됨 — body.org_id 무시 (org_id 조작 방지)
    member = await repo.create(user_id=body.user_id, role=body.role)
    return OrgMemberResponse.model_validate(member)


@router.get("/{id}", response_model=OrgMemberResponse)
async def get_org_member(
    id: uuid.UUID,
    repo: OrgMemberRepository = Depends(_get_repo),
) -> OrgMemberResponse:
    member = await repo.get(id)
    if member is None:
        raise HTTPException(status_code=404, detail="Org member not found")
    return OrgMemberResponse.model_validate(member)


async def _revoke_user_refresh_tokens(session: AsyncSession, user_id: uuid.UUID) -> None:
    """해당 사용자의 refresh token 전량 revoke."""
    await session.execute(
        update(RefreshToken)
        .where(RefreshToken.user_id == user_id, RefreshToken.revoked_at.is_(None))
        .values(revoked_at=datetime.now(timezone.utc))
    )


@router.patch("/{id}", response_model=OrgMemberResponse)
async def update_org_member(
    id: uuid.UUID,
    body: OrgMemberUpdate,
    repo: OrgMemberRepository = Depends(_require_admin),
) -> OrgMemberResponse:
    if body.role and body.role not in ORG_ROLES:
        raise HTTPException(status_code=400, detail=f"role must be one of: {', '.join(ORG_ROLES)}")
    data = body.model_dump(exclude_unset=True)
    if "role" in data:
        existing = await repo.get(id)
        if existing is None:
            raise HTTPException(status_code=404, detail="Org member not found")
        if existing.role != data["role"]:
            await _revoke_user_refresh_tokens(repo.session, existing.user_id)
    member = await repo.update(id, **data)
    if member is None:
        raise HTTPException(status_code=404, detail="Org member not found")
    await repo.session.commit()
    return OrgMemberResponse.model_validate(member)


@router.delete("/{id}", status_code=200)
async def delete_org_member(
    id: uuid.UUID,
    repo: OrgMemberRepository = Depends(_require_admin),
) -> dict:
    existing = await repo.get(id)
    if existing is None:
        raise HTTPException(status_code=404, detail="Org member not found")
    await _revoke_user_refresh_tokens(repo.session, existing.user_id)
    ok = await repo.soft_delete(id)
    if not ok:
        raise HTTPException(status_code=404, detail="Org member not found")
    return {"ok": True}
