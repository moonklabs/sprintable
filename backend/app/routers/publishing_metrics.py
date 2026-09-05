"""story #3475(Phase1·마케팅운영, 페드루 PO 確定 2026-09-05) — 발행 계측 API. GET은
org 멤버(휴먼·에이전트 모두) — content_rules.py GET과 동일 권한 축(회차마다 사람이
손으로 세던 값을 이제 아무 멤버나 조회할 수 있어야 한다). write 없음 — 이 지표는
실 데이터에서 파생될 뿐 별도로 편집할 상태가 없다."""
from __future__ import annotations

import uuid
from datetime import datetime

from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import BaseModel
from sqlalchemy.ext.asyncio import AsyncSession

from app.dependencies.auth import get_current_user, get_verified_org_id
from app.dependencies.database import get_db
from app.services.publishing_metrics import compute_publishing_metrics

router = APIRouter(prefix="/api/v2/organizations", tags=["publishing-metrics"])


class PublishingMetricsResponse(BaseModel):
    window: str
    on_time_rate: float | None
    on_time_numer: int
    on_time_denom: int
    duplicate_publications: int
    unapproved_adapter_calls: int
    recovery_seconds_p50: float | None
    recovery_seconds_p95: float | None
    connections_expired: int
    connections_expiring_7d: int
    computed_at: datetime


@router.get("/{org_id}/publishing-metrics", response_model=PublishingMetricsResponse)
async def get_publishing_metrics_endpoint(
    org_id: uuid.UUID,
    window: str = Query(default="7d"),
    db: AsyncSession = Depends(get_db),
    verified_org_id: uuid.UUID = Depends(get_verified_org_id),
    _auth=Depends(get_current_user),
) -> PublishingMetricsResponse:
    if org_id != verified_org_id:
        raise HTTPException(status_code=403, detail="org_id mismatch")
    if window not in ("7d", "30d"):
        raise HTTPException(
            status_code=422,
            detail={"code": "PUBLISHING_METRICS_INVALID_WINDOW", "message": "window must be 7d or 30d"},
        )

    metrics = await compute_publishing_metrics(db, org_id=org_id, window=window)
    return PublishingMetricsResponse(
        window=metrics.window,
        on_time_rate=metrics.on_time_rate,
        on_time_numer=metrics.on_time_numer,
        on_time_denom=metrics.on_time_denom,
        duplicate_publications=metrics.duplicate_publications,
        unapproved_adapter_calls=metrics.unapproved_adapter_calls,
        recovery_seconds_p50=metrics.recovery_seconds_p50,
        recovery_seconds_p95=metrics.recovery_seconds_p95,
        connections_expired=metrics.connections_expired,
        connections_expiring_7d=metrics.connections_expiring_7d,
        computed_at=metrics.computed_at,
    )
