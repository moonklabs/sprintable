import uuid

from fastapi import APIRouter, Depends, Query
from sqlalchemy.ext.asyncio import AsyncSession

from app.dependencies.auth import get_current_user, get_verified_org_id
from app.dependencies.database import get_db
from app.services.trust_score import DEFAULT_WINDOW_DAYS, compute_member_trust_scores

router = APIRouter(prefix="/api/v2/trust-scores", tags=["trust-scores"])


@router.get("")
async def get_trust_scores(
    member_id: uuid.UUID = Query(...),
    role: str | None = Query(default=None),
    window_days: int = Query(default=DEFAULT_WINDOW_DAYS, ge=1, le=365),
    session: AsyncSession = Depends(get_db),
    org_id: uuid.UUID = Depends(get_verified_org_id),
    _auth=Depends(get_current_user),
) -> dict:
    return await compute_member_trust_scores(
        session=session,
        org_id=org_id,
        member_id=member_id,
        role_key=role,
        window_days=window_days,
    )
