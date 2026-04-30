import uuid
from datetime import datetime, timedelta, timezone

from fastapi import APIRouter, Depends, Header, HTTPException, status
from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncSession

from app.dependencies.auth import AuthContext, get_current_user
from app.dependencies.database import get_db
from app.schemas.subscription import AccountDeleteResponse

router = APIRouter(prefix="/api/v2/account", tags=["account"])


def _get_org_id(
    auth: AuthContext = Depends(get_current_user),
    x_org_id: str | None = Header(default=None, alias="X-Org-Id"),
) -> uuid.UUID:
    org_id_str = auth.claims.get("app_metadata", {}).get("org_id") or x_org_id
    if not org_id_str:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="org_id required")
    return uuid.UUID(str(org_id_str))


@router.post("/delete", response_model=AccountDeleteResponse)
async def delete_account(
    user_id: uuid.UUID | None = None,
    org_id: uuid.UUID = Depends(_get_org_id),
    session: AsyncSession = Depends(get_db),
    auth: AuthContext = Depends(get_current_user),
) -> AccountDeleteResponse:
    now = datetime.now(timezone.utc).isoformat()
    uid = user_id or auth.user_id

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

    return AccountDeleteResponse(ok=True, grace_period_days=30)
