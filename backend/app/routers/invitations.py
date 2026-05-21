import uuid
from datetime import datetime, timezone

from fastapi import APIRouter, Depends, HTTPException, Query
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.dependencies.auth import AuthContext, get_current_user, get_verified_org_id, require_admin
from app.dependencies.database import get_db
from app.models.invitation import Invitation
from app.models.project import OrgMember
from app.models.team import TeamMember
from app.repositories.invitation import InvitationRepository
from app.schemas.invitation import AcceptInvitation, CreateInvitation, InvitationResponse

router = APIRouter(prefix="/api/v2/invitations", tags=["invitations"])


def _get_repo(
    session: AsyncSession = Depends(get_db),
    org_id: uuid.UUID = Depends(get_verified_org_id),
) -> InvitationRepository:
    return InvitationRepository(session, org_id)


@router.get("", response_model=list[InvitationResponse])
async def list_invitations(
    project_id: uuid.UUID | None = Query(default=None),
    repo: InvitationRepository = Depends(_get_repo),
    _: None = Depends(require_admin),
) -> list[InvitationResponse]:
    items = await repo.list(project_id=project_id)
    return [InvitationResponse.model_validate(i) for i in items]


@router.post("", response_model=InvitationResponse, status_code=201)
async def create_invitation(
    body: CreateInvitation,
    repo: InvitationRepository = Depends(_get_repo),
    _: None = Depends(require_admin),
) -> InvitationResponse:
    inv = await repo.create(
        email=body.email,
        role=body.role,
        invited_by=body.invited_by,
        project_id=body.project_id,
    )
    return InvitationResponse.model_validate(inv)


@router.delete("/{id}", response_model=InvitationResponse)
async def revoke_invitation(
    id: uuid.UUID,
    repo: InvitationRepository = Depends(_get_repo),
    _: None = Depends(require_admin),
) -> InvitationResponse:
    inv = await repo.revoke(id)
    if inv is None:
        raise HTTPException(status_code=404, detail="Invitation not found")
    return InvitationResponse.model_validate(inv)


@router.post("/{id}/resend", response_model=InvitationResponse)
async def resend_invitation(
    id: uuid.UUID,
    repo: InvitationRepository = Depends(_get_repo),
    _: None = Depends(require_admin),
) -> InvitationResponse:
    inv = await repo.resend(id)
    if inv is None:
        raise HTTPException(status_code=404, detail="Invitation not found or revoked")
    return InvitationResponse.model_validate(inv)


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

    # human team_member 생성 제거 — org_members 기반 opt-out 모델로 이전 (E-ENTITY-CLEANUP S5).
    # project_id가 있더라도 org_member로 이미 프로젝트 접근 허용됨.

    await session.flush()
    return {"ok": True, "org_id": str(inv.org_id), "project_id": str(inv.project_id) if inv.project_id else None}
