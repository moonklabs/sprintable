import uuid

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.dependencies.auth import AuthContext, get_current_user
from app.dependencies.database import get_db
from app.models.user import User
from app.repositories.org_invite import OrgInviteRepository
from app.schemas.invite_accept import (
    AcceptInviteRequest,
    AcceptInviteResponse,
    InvitePreviewResponse,
    MyInvite,
    MyInvitesResponse,
)

router = APIRouter(prefix="/api/v2/invites", tags=["invites", "Organization"])


def _get_repo(session: AsyncSession = Depends(get_db)) -> OrgInviteRepository:
    return OrgInviteRepository(session)


@router.get("/mine", response_model=MyInvitesResponse)
async def get_my_invites(
    auth: AuthContext = Depends(get_current_user),
    session: AsyncSession = Depends(get_db),
    repo: OrgInviteRepository = Depends(_get_repo),
) -> MyInvitesResponse:
    """story #4427 (PO 01:21Z) — the pending invites to the signed-in person's own email, so a new sign-up joins by invite
    instead of making a new org. Only a **verified** email is looked up (an unverified one could be anyone's address): no
    user · unverified · an agent key → an empty list. No tokens in the answer — accepting stays the mail link.
    Declared before `/{token}` so «mine» is never read as a token."""
    # An agent key is refused by name (Qadir 4833 · PO 05:12Z), with this endpoint's own answer for «not a person» — an
    # empty list, like no user and unverified above. Before, it was empty only because an agent's member id happens not to
    # be a users.id. Same signal the rest of the API reads an agent key by (stories.py actor type: app_metadata.api_key_id).
    if (auth.claims or {}).get("app_metadata", {}).get("api_key_id"):
        return MyInvitesResponse(invites=[])
    try:
        user_id = uuid.UUID(str(auth.user_id))
    except (TypeError, ValueError):
        return MyInvitesResponse(invites=[])
    user = (await session.execute(select(User).where(User.id == user_id))).scalar_one_or_none()
    if user is None or not user.email_verified or not user.email:
        return MyInvitesResponse(invites=[])
    return MyInvitesResponse(invites=[MyInvite(**i) for i in await repo.pending_for_email(user.email, user.id)])


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
    # story 4427 (나): the per-person first-organization lock is taken in OrgInviteRepository.accept — the one place every
    # accept path goes through (this route, sign-in auto-accept, sign-up with an invite token)
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

    # story #3217(Referral 계측, 착지 후 PO 라이브 probe 발견) — 이메일 가입 경로 실
    # 여정은 register()가 invite_token을 받는 게 아니라: 비로그인 수락 → /login?
    # returnUrl → 가입 → **이 authenticated accept**로 흐른다(OAuth 경로만 register()
    # 훅이 유효). register()/oauth_callback()의 A축 훅은 그대로 두고(OAuth·API 클라
    # 유효), 여기에 결정론 규칙으로 귀속을 보강한다: 계정 생성이 이 초대 생성 **이후**
    # (invite→signup 인과, `user.created_at >= invite_created_at`)면 이 초대가 유발한
    # 신규 가입 — referral 기록. 계정이 초대보다 오래면(기존 유저의 통상 수락) 그
    # 계정의 기존 귀속(가입 시점 값)을 건드리지 않는다(무기록).
    invite_created_at = result.get("invite_created_at")
    if invite_created_at is not None and user.created_at >= invite_created_at:
        from app.routers.auth import _apply_referral_attribution
        _apply_referral_attribution(user, result)

    await session.commit()
    return AcceptInviteResponse(ok=True, org_id=result["org_id"], role=result["role"])
