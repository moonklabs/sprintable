"""story #3497(Phase2·마케팅운영, 페드루 決定 2026-09-05) — 인사이트 스냅샷 조회 API.
publishing_metrics.py와 동형 권한 축(GET은 org 멤버 누구나 — 휴먼·에이전트 모두, write
없음·이 값은 워커 tick의 파생물일 뿐 별도로 편집할 상태가 없다). publication_id 하나로
site_post·channel_publication 어느 쪽이든 조회한다(publication_kind는 결과 행 자신이
싣고 있다 — 호출자가 미리 구분해서 넘길 필요 없음)."""
from __future__ import annotations

import uuid
from datetime import datetime

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
from sqlalchemy.ext.asyncio import AsyncSession

from app.dependencies.auth import get_current_user
from app.dependencies.auth import get_verified_org_id
from app.dependencies.database import get_db
from app.services.insight_snapshots import list_insight_snapshots_for_publication

router = APIRouter(prefix="/api/v2/organizations", tags=["insight-snapshots"])


class InsightSnapshotView(BaseModel):
    id: uuid.UUID
    channel: str
    due_at: datetime
    captured_at: datetime | None
    status: str
    normalized: dict[str, int | None] | None
    source: str | None
    error_code: str | None


@router.get(
    "/{org_id}/publications/{publication_id}/insights", response_model=list[InsightSnapshotView],
)
async def list_publication_insights_endpoint(
    org_id: uuid.UUID,
    publication_id: uuid.UUID,
    db: AsyncSession = Depends(get_db),
    verified_org_id: uuid.UUID = Depends(get_verified_org_id),
    _auth=Depends(get_current_user),
) -> list[InsightSnapshotView]:
    """AC6 — 스냅샷 목록(raw_payload 제외 — 원본은 디버그 전용, 이 조회 축에 실을
    필요가 없다). 존재하지 않는 publication_id는 빈 목록으로 응답한다(그 자체가
    "이 발행엔 아직 스냅샷이 없다"는 정직한 사실 — 404로 지어내지 않는다, org
    경계는 org_id mismatch일 때만 403)."""
    if org_id != verified_org_id:
        raise HTTPException(status_code=403, detail="org_id mismatch")

    rows = await list_insight_snapshots_for_publication(db, org_id=org_id, publication_id=publication_id)
    return [
        InsightSnapshotView(
            id=r.id, channel=r.channel, due_at=r.due_at, captured_at=r.captured_at,
            status=r.status, normalized=r.normalized, source=r.source, error_code=r.error_code,
        )
        for r in rows
    ]
