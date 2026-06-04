import uuid
from datetime import datetime, timedelta, timezone

from fastapi import APIRouter, Depends
from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncSession

from app.dependencies.auth import AuthContext, get_current_user, get_verified_org_id
from app.dependencies.database import get_db
from app.schemas.subscription import AccountDeleteResponse

router = APIRouter(prefix="/api/v2/account", tags=["account"])


@router.post("/delete", response_model=AccountDeleteResponse)
async def delete_account(
    org_id: uuid.UUID = Depends(get_verified_org_id),
    session: AsyncSession = Depends(get_db),
    auth: AuthContext = Depends(get_current_user),
) -> AccountDeleteResponse:
    now = datetime.now(timezone.utc).isoformat()
    uid = auth.user_id

    await session.execute(
        text("UPDATE org_members SET deleted_at = :now WHERE user_id = :uid::uuid"),
        {"now": now, "uid": str(uid)},
    )
    await session.execute(
        text(
            "UPDATE team_members SET deleted_at = :now, is_active = false, updated_at = :now"
            " WHERE user_id = :uid::uuid"
        ),
        {"now": now, "uid": str(uid)},
    )
    # AC3-4 2-1 dual-write: 뷰가 is_active/deleted_at을 members서 읽으므로 동시 반영(cutover 전 동기).
    await session.execute(
        text(
            "UPDATE members SET deleted_at = :now, is_active = false, updated_at = :now"
            " WHERE user_id = :uid::uuid"
        ),
        {"now": now, "uid": str(uid)},
    )

    return AccountDeleteResponse(ok=True, grace_period_days=30)
