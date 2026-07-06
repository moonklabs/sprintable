import uuid

from fastapi import APIRouter, Depends, HTTPException, Query
from sqlalchemy.ext.asyncio import AsyncSession

from app.dependencies.auth import AuthContext, get_current_user, get_verified_org_id
from app.dependencies.database import get_db
from app.dependencies.ownership import _is_org_admin
from app.services.member_resolver import is_caller_member
from app.services.trust_score import DEFAULT_WINDOW_DAYS, compute_member_trust_scores

router = APIRouter(prefix="/api/v2/trust-scores", tags=["trust-scores"])


async def _assert_self_or_org_admin(
    member_id: uuid.UUID, auth: AuthContext, session: AsyncSession, org_id: uuid.UUID,
) -> None:
    if await is_caller_member(member_id, auth, session, org_id):
        return
    if await _is_org_admin(session, org_id, uuid.UUID(auth.user_id)):
        return
    raise HTTPException(status_code=403, detail="Not authorized for this member")


@router.get("")
async def get_trust_scores(
    member_id: uuid.UUID = Query(...),
    role: str | None = Query(default=None),
    window_days: int = Query(default=DEFAULT_WINDOW_DAYS, ge=1, le=365),
    session: AsyncSession = Depends(get_db),
    org_id: uuid.UUID = Depends(get_verified_org_id),
    auth: AuthContext = Depends(get_current_user),
) -> dict:
    # S20 전수스캔 findings #11: member_id에 caller-ownership 확인이 전혀 없어 임의 org member가
    # 다른 member의 신뢰점수(성과 유사 민감정보)를 열람할 수 있었다 — rewards.get_balance와 동형.
    await _assert_self_or_org_admin(member_id, auth, session, org_id)
    return await compute_member_trust_scores(
        session=session,
        org_id=org_id,
        member_id=member_id,
        role_key=role,
        window_days=window_days,
    )
