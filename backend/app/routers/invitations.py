import uuid

from fastapi import APIRouter, Depends, Header, HTTPException, Query, status
from sqlalchemy.ext.asyncio import AsyncSession

from app.dependencies.auth import AuthContext, get_current_user
from app.dependencies.database import get_db
from app.repositories.invitation import InvitationRepository
from app.schemas.invitation import AcceptInvitation, CreateInvitation, InvitationResponse

router = APIRouter(prefix="/api/v2/invitations", tags=["invitations"])


def _get_repo(
    session: AsyncSession = Depends(get_db),
    auth: AuthContext = Depends(get_current_user),
    x_org_id: str | None = Header(default=None, alias="X-Org-Id"),
) -> InvitationRepository:
    org_id_str = auth.claims.get("app_metadata", {}).get("org_id") or x_org_id
    if not org_id_str:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="org_id required")
    return InvitationRepository(session, uuid.UUID(str(org_id_str)))


@router.get("", response_model=list[InvitationResponse])
async def list_invitations(
    project_id: uuid.UUID | None = Query(default=None),
    repo: InvitationRepository = Depends(_get_repo),
) -> list[InvitationResponse]:
    items = await repo.list(project_id=project_id)
    return [InvitationResponse.model_validate(i) for i in items]


@router.post("", response_model=InvitationResponse, status_code=201)
async def create_invitation(
    body: CreateInvitation,
    repo: InvitationRepository = Depends(_get_repo),
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
) -> InvitationResponse:
    inv = await repo.revoke(id)
    if inv is None:
        raise HTTPException(status_code=404, detail="Invitation not found")
    return InvitationResponse.model_validate(inv)


@router.post("/{id}/resend", response_model=InvitationResponse)
async def resend_invitation(
    id: uuid.UUID,
    repo: InvitationRepository = Depends(_get_repo),
) -> InvitationResponse:
    inv = await repo.resend(id)
    if inv is None:
        raise HTTPException(status_code=404, detail="Invitation not found or revoked")
    return InvitationResponse.model_validate(inv)


@router.post("/accept", status_code=200)
async def accept_invitation(
    body: AcceptInvitation,
    repo: InvitationRepository = Depends(_get_repo),
) -> dict:
    inv = await repo.accept(body.token)
    if inv is None:
        raise HTTPException(status_code=400, detail="Invalid, expired, or already used token")
    # Phase D: org_member + team_member 생성은 Supabase RPC(accept_invitation) 위임
    return {"ok": True, "org_id": str(inv.org_id), "project_id": str(inv.project_id) if inv.project_id else None}
