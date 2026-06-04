import uuid
from datetime import datetime, timezone

from fastapi import APIRouter, Depends, HTTPException, Query
from sqlalchemy import select, text
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.config import settings
from app.dependencies.auth import AuthContext, get_current_user, get_verified_org_id, require_admin
from app.dependencies.database import get_db
from app.models.invitation import Invitation
from app.models.project import OrgMember
from app.repositories.invitation import InvitationRepository
from app.schemas.invitation import AcceptInvitation, CreateInvitation, InvitationPreviewResponse, InvitationResponse
from app.services.org_invite_email import send_invite_email

router = APIRouter(prefix="/api/v2/invitations", tags=["invitations"])


def _get_repo(
    session: AsyncSession = Depends(get_db),
    org_id: uuid.UUID = Depends(get_verified_org_id),
) -> InvitationRepository:
    return InvitationRepository(session, org_id)


def _to_response(inv: Invitation) -> InvitationResponse:
    base = InvitationResponse.model_validate(inv)
    invite_url = None
    if inv.status == "pending" and inv.expires_at > datetime.now(timezone.utc):
        invite_url = f"{settings.app_url}/invite/accept?token={inv.token}"
    return base.model_copy(update={"invite_url": invite_url})


async def _get_org_name(session: AsyncSession, org_id: uuid.UUID) -> str:
    row = await session.execute(
        text("SELECT name FROM organizations WHERE id = :id"),
        {"id": str(org_id)},
    )
    r = row.first()
    return r[0] if r else str(org_id)


@router.get("", response_model=list[InvitationResponse])
async def list_invitations(
    project_id: uuid.UUID | None = Query(default=None),
    repo: InvitationRepository = Depends(_get_repo),
    _: None = Depends(require_admin),
) -> list[InvitationResponse]:
    items = await repo.list(project_id=project_id)
    return [_to_response(i) for i in items]


@router.post("", response_model=InvitationResponse, status_code=201)
async def create_invitation(
    body: CreateInvitation,
    repo: InvitationRepository = Depends(_get_repo),
    auth: AuthContext = Depends(get_current_user),
    _: None = Depends(require_admin),
    session: AsyncSession = Depends(get_db),
) -> InvitationResponse:
    # AC3-2d(1b): invited_by canonical 정규화(레거시 휴먼 tm.id→members.id). (A) write.
    from app.services.member_resolver import canonicalize_member_id
    invited_by = (await canonicalize_member_id(body.invited_by, session)) if body.invited_by else body.invited_by
    inv = await repo.create(
        email=body.email,
        role=body.role,
        invited_by=invited_by,
        project_id=body.project_id,
    )
    await session.commit()

    # AC1: 초대 생성 시 자동 이메일 발송 (실패해도 레코드 유지)
    org_name = await _get_org_name(session, repo.org_id)
    inviter_name = auth.email or auth.claims.get("email", "")
    error = send_invite_email(
        to=inv.email,
        org_name=org_name,
        token=inv.token,
        role=inv.role,
        inviter_name=inviter_name,
    )
    sent_at = None if error else datetime.now(timezone.utc)
    await repo.update_email_result(inv.id, sent_at=sent_at, error=error)
    await session.commit()

    await session.refresh(inv)
    return _to_response(inv)


@router.delete("/{id}", response_model=InvitationResponse)
async def revoke_invitation(
    id: uuid.UUID,
    repo: InvitationRepository = Depends(_get_repo),
    _: None = Depends(require_admin),
) -> InvitationResponse:
    inv = await repo.revoke(id)
    if inv is None:
        raise HTTPException(status_code=404, detail="Invitation not found")
    return _to_response(inv)


@router.post("/{id}/resend", response_model=InvitationResponse)
async def resend_invitation(
    id: uuid.UUID,
    repo: InvitationRepository = Depends(_get_repo),
    auth: AuthContext = Depends(get_current_user),
    _: None = Depends(require_admin),
    session: AsyncSession = Depends(get_db),
) -> InvitationResponse:
    inv = await repo.resend(id)
    if inv is None:
        raise HTTPException(status_code=404, detail="Invitation not found or revoked")
    await session.commit()

    # AC3: 재발송 — 새 토큰으로 이메일 재전송
    org_name = await _get_org_name(session, repo.org_id)
    inviter_name = auth.email or auth.claims.get("email", "")
    error = send_invite_email(
        to=inv.email,
        org_name=org_name,
        token=inv.token,
        role=inv.role,
        inviter_name=inviter_name,
    )
    sent_at = None if error else datetime.now(timezone.utc)
    await repo.update_email_result(inv.id, sent_at=sent_at, error=error)
    await session.commit()

    await session.refresh(inv)
    return _to_response(inv)


@router.get("/preview", response_model=InvitationPreviewResponse)
async def preview_invitation(
    token: str = Query(...),
    session: AsyncSession = Depends(get_db),
) -> InvitationPreviewResponse:
    """인증 없이 초대 미리보기 — 가입 전 org 정보 표시용 (AC1)."""
    result = await session.execute(
        select(Invitation).where(Invitation.token == token)
    )
    inv = result.scalar_one_or_none()
    if inv is None or inv.status != "pending" or inv.expires_at < datetime.now(timezone.utc):
        raise HTTPException(status_code=400, detail="Invalid, expired, or already used token")

    row = await session.execute(
        text("SELECT name FROM organizations WHERE id = :id"),
        {"id": str(inv.org_id)},
    )
    org_row = row.first()
    org_name = org_row[0] if org_row else str(inv.org_id)

    return InvitationPreviewResponse(
        org_name=org_name,
        org_id=inv.org_id,
        email=inv.email,
        role=inv.role,
        status=inv.status,
        expires_at=inv.expires_at,
    )


@router.post("/accept", status_code=200)
async def accept_invitation(
    body: AcceptInvitation,
    session: AsyncSession = Depends(get_db),
    auth: AuthContext = Depends(get_current_user),
) -> dict:
    result = await session.execute(
        select(Invitation).where(Invitation.token == body.token)
    )
    inv = result.scalar_one_or_none()
    if inv is None or inv.status != "pending" or inv.expires_at < datetime.now(timezone.utc):
        raise HTTPException(status_code=400, detail="Invalid, expired, or already used token")

    caller_email = auth.claims.get("email", "")
    if inv.email.lower() != caller_email.lower():
        raise HTTPException(status_code=403, detail="Invitation was issued to a different email")

    inv.status = "accepted"
    inv.accepted_at = datetime.now(timezone.utc)

    user_id = uuid.UUID(auth.user_id)

    from sqlalchemy.dialects.postgresql import insert as pg_insert
    await session.execute(
        pg_insert(OrgMember)
        .values(org_id=inv.org_id, user_id=user_id, role=inv.role)
        .on_conflict_do_nothing(constraint="uq_org_members_org_user")
    )

    await session.flush()
    return {"ok": True, "org_id": str(inv.org_id), "project_id": str(inv.project_id) if inv.project_id else None}
