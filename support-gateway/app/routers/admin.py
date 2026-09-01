"""story #3264(지원v1·6방어·계측) AC3/AC4 — 어드민 계측 조회. 고객 위임 토큰 축과 완전히
분리된 인증(app/token_verify.py::require_admin) — org 스코프 개념이 없는 내부 운영
엔드포인트다. 고객 대화 원문(SupportMessage.content)은 절대 반환하지 않는다(집계 숫자만
— org 격리 원칙이 "고객 데이터"에 적용되는 것이지, 우리 자신의 운영 지표 열람에는 안
적용된다는 점을 명확히 한다)."""
from __future__ import annotations

import uuid
from datetime import datetime, timedelta, timezone

from fastapi import APIRouter, Depends, Query
from sqlalchemy.ext.asyncio import AsyncSession

from app.config import settings
from app.db import get_db
from app.metrics import compute_resolution_metrics
from app.schemas import AdminMetricsResponse
from app.token_verify import require_admin

router = APIRouter(prefix="/api/v1/admin", tags=["admin"], dependencies=[Depends(require_admin)])


@router.get("/metrics", response_model=AdminMetricsResponse)
async def get_metrics(
    db: AsyncSession = Depends(get_db),
    org_id: uuid.UUID | None = Query(default=None),
    since_days: int = Query(default=7, ge=1, le=90),
) -> AdminMetricsResponse:
    since = datetime.now(timezone.utc) - timedelta(days=since_days)
    metrics = await compute_resolution_metrics(db, since=since, org_id=org_id)
    return AdminMetricsResponse(
        window_since=since,
        org_id=org_id,
        total_turns=metrics.total_turns,
        escalated_turns=metrics.escalated_turns,
        resolved_turns=metrics.resolved_turns,
        resolution_rate=metrics.resolution_rate,
        escalation_rate=metrics.escalation_rate,
        cost_cap_org_daily_usd=settings.cost_cap_org_daily_usd,
        cost_cap_org_session_usd=settings.cost_cap_org_session_usd,
    )
