import uuid

from fastapi import APIRouter, Depends, status
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.dependencies.auth import AuthContext, get_current_user, get_verified_org_id
from app.dependencies.database import get_db
from app.models.org_subscription import OrgSubscription
from app.schemas.subscription import SubscriptionStatusResponse

router = APIRouter(prefix="/api/v2/subscription", tags=["subscription"])


@router.get("/status", response_model=SubscriptionStatusResponse)
async def get_subscription_status(
    org_id: uuid.UUID = Depends(get_verified_org_id),
    session: AsyncSession = Depends(get_db),
    _auth: AuthContext = Depends(get_current_user),
) -> SubscriptionStatusResponse:
    result = await session.execute(
        select(OrgSubscription.status, OrgSubscription.tier, OrgSubscription.current_period_end).where(
            OrgSubscription.org_id == org_id
        )
    )
    row = result.first()
    if row is None:
        return SubscriptionStatusResponse(status="active", tier="free", grace_until=None)
    return SubscriptionStatusResponse(status=row[0], tier=row[1], grace_until=row[2])
