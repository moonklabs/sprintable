"""E-HITL-GATING S-GATE-5: HITL 게이트 dogfood 측정 readout 엔드포인트. 정책 §5.

GET /api/v2/gate/metrics — agent_hitl_requests(gate_approval) on-the-fly 집계(읽기전용). dogfood
가치 숫자(게이트가 나쁜 통과 막았나·rubber-stamp인가). project/window filter·null(데이터없음)/0(실제0).
⚠️ coverage·auto-pass 카운트는 auto/block 미persist라 DB 불가(소스 한계·audit 테이블 후속).
"""
from __future__ import annotations

import uuid
from datetime import datetime

from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import BaseModel
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.datetime_query import aware_datetime_query
from app.dependencies.auth import AuthContext, get_current_user, get_verified_org_id
from app.dependencies.database import get_db
from app.services.gate_metrics import compute_hitl_gate_metrics
from app.services.project_auth import is_org_owner_or_admin

router = APIRouter(prefix="/api/v2/gate", tags=["hitl-gate-metrics", "Trust"])

# story #4294 — 기간 파라미터는 오프셋 필수(`app/core/datetime_query.py`) · 기본값 호출을 모듈 상수로(ruff B008).
_START_QUERY = Depends(aware_datetime_query("start", description="Window start (inclusive)"))
_END_QUERY = Depends(aware_datetime_query("end", description="Window end (inclusive)"))


class HitlGateMetricsResponse(BaseModel):
    ask_total: int = 0
    pending: int = 0
    approved: int = 0
    rejected: int = 0
    prevented_bad_pass: int = 0  # = rejected(사람 심사가 막은 나쁜 통과)
    ask_resolution_minutes: float | None = None
    rubber_stamp_rate: float | None = None
    self_approval_caught: int = 0
    coverage: float | None = None  # true ratio(enforced/전체)는 stories 분모 필요 — §3 deferred
    # S-GATE-5.1: hitl_gate_audit 기반(auto/block 포함 전 outcome)
    enforced_total: int = 0
    outcomes: dict | None = None
    auto_rate: float | None = None
    project_id: str | None = None
    window: dict


@router.get("/metrics", response_model=HitlGateMetricsResponse)
async def get_hitl_gate_metrics(
    project_id: uuid.UUID | None = Query(default=None),
    # story #4294 — 오프셋 없는 일시는 422(`app/core/datetime_query.py`).
    start: datetime | None = _START_QUERY,
    end: datetime | None = _END_QUERY,
    session: AsyncSession = Depends(get_db),
    org_id: uuid.UUID = Depends(get_verified_org_id),
    auth: AuthContext = Depends(get_current_user),
) -> HitlGateMetricsResponse:
    """HITL 게이트 측정 지표 on-the-fly 집계(ask 경로). denom 0이면 ratio=null, 데이터 있고 0이면 0.

    QA HIGH①: 메트릭은 **거버넌스 데이터**(self-approval·rubber-stamp 적발 등)라 **org owner/admin only**.
    config 레벨 GET(멤버 read)과 달리 집계 오버사이트는 관리자 스코프.
    """
    if not await is_org_owner_or_admin(session, uuid.UUID(auth.user_id), org_id):
        raise HTTPException(status_code=403, detail="org owner/admin required for gate metrics")
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
        enforced_total=m.enforced_total,
        outcomes=m.outcomes,
        auto_rate=m.auto_rate,
        project_id=str(project_id) if project_id else None,
        window={
            "start": start.isoformat() if start else None,
            "end": end.isoformat() if end else None,
        },
    )
