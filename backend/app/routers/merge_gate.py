"""H1-S9: merge verdict gate 관측 지표 엔드포인트.

GET /api/v2/merge-gate/metrics — gate/verdict/story on-the-fly 집계(읽기전용). 접는조건·rollout
대시보드용. project/window filter·null(데이터 없음)/0(실제 0) 구분.
"""
from __future__ import annotations

import uuid
from datetime import datetime

from fastapi import APIRouter, Depends, Query
from pydantic import BaseModel

from app.dependencies.auth import AuthContext, get_current_user, get_verified_org_id
from app.dependencies.database import get_db
from app.services.merge_gate_metrics import compute_merge_gate_metrics
from sqlalchemy.ext.asyncio import AsyncSession

router = APIRouter(prefix="/api/v2/merge-gate", tags=["merge-gate"])


class MergeGateMetricsResponse(BaseModel):
    merge_gate_coverage: float | None = None
    verdict_coverage: float | None = None
    trustworthy_merge_throughput: int = 0
    human_review_minutes: float | None = None
    rubber_stamp_rate: float | None = None
    post_merge_regret_rate: float | None = None
    project_id: str | None = None
    window: dict


@router.get("/metrics", response_model=MergeGateMetricsResponse)
async def get_merge_gate_metrics(
    project_id: uuid.UUID | None = Query(default=None),
    start: datetime | None = Query(default=None, description="window 시작(이상)"),
    end: datetime | None = Query(default=None, description="window 끝(이하)"),
    session: AsyncSession = Depends(get_db),
    org_id: uuid.UUID = Depends(get_verified_org_id),
    _auth: AuthContext = Depends(get_current_user),
) -> MergeGateMetricsResponse:
    """merge verdict gate 6지표 on-the-fly 집계. denom 0이면 ratio=null, 데이터 있고 0이면 0."""
    data = await compute_merge_gate_metrics(
        session, org_id, project_id=project_id, start=start, end=end
    )
    return MergeGateMetricsResponse(**data)
