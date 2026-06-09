import uuid

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.dependencies.auth import AuthContext, get_current_user
from app.dependencies.database import get_db
from app.models.user import User
from app.repositories.org_invite import OrgInviteRepository
from app.schemas.invite_accept import AcceptInviteRequest, AcceptInviteResponse, InvitePreviewResponse

router = APIRouter(prefix="/api/v2/invites", tags=["invites"])


def _get_repo(session: AsyncSession = Depends(get_db)) -> OrgInviteRepository:
    return OrgInviteRepository(session)


@router.get("/{token}", response_model=InvitePreviewResponse)
async def get_invite_preview(
    token: str,
    repo: OrgInviteRepository = Depends(_get_repo),
) -> InvitePreviewResponse:
    """초대 링크 미리보기 — 미인증 사용자도 조회 가능."""
    preview = await repo.get_preview(token=token)
    if preview is None:
        raise HTTPException(status_code=404, detail="Invite not found")
    return InvitePreviewResponse(
        org_name=preview.org_name,
        role=preview.role,
        status=preview.status,
        expires_at=preview.expires_at,
        email=preview.email,
        projects=preview.projects,
    )


@router.post("/accept", response_model=AcceptInviteResponse)
async def accept_invite(
    body: AcceptInviteRequest,
    auth: AuthContext = Depends(get_current_user),
    repo: OrgInviteRepository = Depends(_get_repo),
    session: AsyncSession = Depends(get_db),
) -> AcceptInviteResponse:
    """초대 수락 — 인증된 사용자만, email 일치 필수."""
    user_result = await session.execute(
        select(User).where(User.id == uuid.UUID(auth.user_id), User.is_active.is_(True))
    )
    user = user_result.scalar_one_or_none()
    if user is None:
        raise HTTPException(status_code=404, detail="User not found")

    result = await repo.accept(
        token=body.token,
        user_id=user.id,
        user_email=user.email,
    )

    if not result["ok"]:
        reason = result.get("reason")
        if reason == "not_found":
            raise HTTPException(status_code=404, detail="Invite not found")
        if reason == "already_accepted":
            raise HTTPException(status_code=409, detail="Invite already accepted")
        if reason == "expired":
            raise HTTPException(status_code=410, detail="Invite has expired")
        if reason == "email_mismatch":
            raise HTTPException(status_code=403, detail="Email does not match invite")
        raise HTTPException(status_code=400, detail="Cannot accept invite")

    await session.commit()
    return AcceptInviteResponse(ok=True, org_id=result["org_id"], role=result["role"])
