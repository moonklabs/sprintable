import uuid

from fastapi import APIRouter, Depends, HTTPException, Query
from sqlalchemy.ext.asyncio import AsyncSession

from app.dependencies.auth import get_verified_org_id
from app.dependencies.database import get_db
from app.repositories.reward import RewardRepository
from app.schemas.reward import BalanceResponse, GrantReward, LeaderboardEntry, RewardLedgerResponse

router = APIRouter(prefix="/api/v2/rewards", tags=["rewards"])


def _get_repo(
    session: AsyncSession = Depends(get_db),
    org_id: uuid.UUID = Depends(get_verified_org_id),
) -> RewardRepository:
    return RewardRepository(session, org_id)


@router.get("", response_model=list[RewardLedgerResponse])
async def list_rewards(
    project_id: uuid.UUID = Query(...),
    member_id: uuid.UUID | None = Query(default=None),
    repo: RewardRepository = Depends(_get_repo),
) -> list[RewardLedgerResponse]:
    items = await repo.list(project_id=project_id, member_id=member_id)
    return [RewardLedgerResponse.model_validate(i) for i in items]


@router.get("/balance", response_model=BalanceResponse)
async def get_balance(
    project_id: uuid.UUID = Query(...),
    member_id: uuid.UUID = Query(...),
    repo: RewardRepository = Depends(_get_repo),
) -> BalanceResponse:
    balance = await repo.get_balance(project_id=project_id, member_id=member_id)
    return BalanceResponse(project_id=project_id, member_id=member_id, balance=balance)


@router.post("", response_model=RewardLedgerResponse, status_code=201)
async def grant_reward(
    body: GrantReward,
    repo: RewardRepository = Depends(_get_repo),
) -> RewardLedgerResponse:
    entry = await repo.grant(
        project_id=body.project_id,
        member_id=body.member_id,
        amount=body.amount,
        reason=body.reason,
        granted_by=body.granted_by,
        reference_type=body.reference_type,
        reference_id=body.reference_id,
    )
    if entry is None:
        raise HTTPException(status_code=404, detail="Member not found in project")
    return RewardLedgerResponse.model_validate(entry)


@router.get("/leaderboard", response_model=list[LeaderboardEntry])
async def get_leaderboard(
    project_id: uuid.UUID = Query(...),
    period: str = Query(default="all"),
    limit: int = Query(default=50, ge=1, le=100),
    cursor: str | None = Query(default=None),
    repo: RewardRepository = Depends(_get_repo),
) -> list[LeaderboardEntry]:
    if period not in ("daily", "weekly", "monthly", "all"):
        raise HTTPException(status_code=400, detail="period must be one of: daily, weekly, monthly, all")
    items = await repo.leaderboard(project_id=project_id, period=period, limit=limit, cursor=cursor)
    return [LeaderboardEntry.model_validate(i) for i in items]
