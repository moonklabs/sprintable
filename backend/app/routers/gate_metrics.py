"""E-HITL-GATING S-GATE-5: HITL 게이트 dogfood 측정 readout 엔드포인트. 정책 §5.

GET /api/v2/gate/metrics — agent_hitl_requests(gate_approval) on-the-fly 집계(읽기전용). dogfood
가치 숫자(게이트가 나쁜 통과 막았나·rubber-stamp인가). project/window filter·null(데이터없음)/0(실제0).
⚠️ coverage·auto-pass 카운트는 auto/block 미persist라 DB 불가(소스 한계·audit 테이블 후속).
"""
from __future__ import annotations

import uuid
from datetime import datetime

from fastapi import APIRouter, Depends, Query
from pydantic import BaseModel
from sqlalchemy.ext.asyncio import AsyncSession

from app.dependencies.auth import AuthContext, get_current_user, get_verified_org_id
from app.dependencies.database import get_db
from app.services.gate_metrics import compute_hitl_gate_metrics

router = APIRouter(prefix="/api/v2/gate", tags=["hitl-gate-metrics"])


class HitlGateMetricsResponse(BaseModel):
    ask_total: int = 0
    pending: int = 0
    approved: int = 0
    rejected: int = 0
    prevented_bad_pass: int = 0  # = rejected(사람 심사가 막은 나쁜 통과)
    ask_resolution_minutes: float | None = None
    rubber_stamp_rate: float | None = None
    self_approval_caught: int = 0
    coverage: float | None = None  # v1 항상 null — auto/block 미persist(소스 한계)
    project_id: str | None = None
    window: dict


@router.get("/metrics", response_model=HitlGateMetricsResponse)
async def get_hitl_gate_metrics(
    project_id: uuid.UUID | None = Query(default=None),
    start: datetime | None = Query(default=None, description="window 시작(이상)"),
    end: datetime | None = Query(default=None, description="window 끝(이하)"),
    session: AsyncSession = Depends(get_db),
    org_id: uuid.UUID = Depends(get_verified_org_id),
    _auth: AuthContext = Depends(get_current_user),
) -> HitlGateMetricsResponse:
    """HITL 게이트 측정 지표 on-the-fly 집계(ask 경로). denom 0이면 ratio=null, 데이터 있고 0이면 0."""
    m = await compute_hitl_gate_metrics(
        session, org_id=org_id, project_id=project_id, start=start, end=end
    )
    return HitlGateMetricsResponse(
        ask_total=m.ask_total,
        pending=m.pending,
        approved=m.approved,
        rejected=m.rejected,
        prevented_bad_pass=m.prevented_bad_pass,
        ask_resolution_minutes=m.ask_resolution_minutes,
        rubber_stamp_rate=m.rubber_stamp_rate,
        self_approval_caught=m.self_approval_caught,
        coverage=m.coverage,
        project_id=str(project_id) if project_id else None,
        window={
            "start": start.isoformat() if start else None,
            "end": end.isoformat() if end else None,
        },
    )
