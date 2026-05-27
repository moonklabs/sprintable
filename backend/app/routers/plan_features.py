from typing import Optional

from fastapi import APIRouter, Depends, Query
from sqlalchemy.ext.asyncio import AsyncSession

from app.dependencies.database import get_db
from app.dependencies.rate_limit import rate_limit
from app.repositories.plan_feature import PlanFeatureRepository
from app.schemas.plan_feature import PlanFeatureResponse

router = APIRouter(prefix="/api/v2", tags=["plan-features"])


def _get_repo(session: AsyncSession = Depends(get_db)) -> PlanFeatureRepository:
    return PlanFeatureRepository(session)


@router.get("/plan-features", response_model=list[PlanFeatureResponse], dependencies=[Depends(rate_limit)])
async def list_plan_features(
    tier: Optional[str] = Query(None, description="Filter by tier: free, team, pro"),
    repo: PlanFeatureRepository = Depends(_get_repo),
) -> list[PlanFeatureResponse]:
    if tier:
        features = await repo.list_by_tier(tier)
    else:
        features = await repo.list_all()
    return [PlanFeatureResponse.model_validate(f) for f in features]
