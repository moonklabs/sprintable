import uuid
from datetime import datetime

from fastapi import APIRouter, Depends, Query
from sqlalchemy.ext.asyncio import AsyncSession

from app.dependencies.auth import get_verified_org_id
from app.dependencies.database import get_db
from app.schemas.activity_stream import ActivityStreamItem, ActivityStreamResponse
from app.services.activity_stream import query_activity_stream

router = APIRouter(prefix="/api/v2/activity-stream", tags=["activity-stream"])


@router.get("", response_model=ActivityStreamResponse)
async def get_activity_stream(
    project_id: uuid.UUID | None = Query(default=None),
    actor_id: uuid.UUID | None = Query(default=None),
    verb: str | None = Query(default=None),
    object_type: str | None = Query(default=None),
    object_id: uuid.UUID | None = Query(default=None),
    since: datetime | None = Query(default=None, description="occurred_at >= since"),
    until: datetime | None = Query(default=None, description="occurred_at <= until"),
    after_seq: int | None = Query(default=None, description="activity_seq > after_seq (cursor)"),
    limit: int = Query(default=50, ge=1, le=200),
    db: AsyncSession = Depends(get_db),
    org_id: uuid.UUID = Depends(get_verified_org_id),
) -> ActivityStreamResponse:
    """GET /api/v2/activity-stream — 에이전트 team-context 읽기.

    org-scope 강제(AC①). activity_seq ASC cursor 페이지네이션(AC③). 응답은 canonical
    활동(source/recipient/payload·AC④)만 — delivery-only status/read는 미포함(AC⑤).
    """
    rows, next_after_seq = await query_activity_stream(
        db,
        org_id,
        project_id=project_id,
        actor_id=actor_id,
        verb=verb,
        object_type=object_type,
        object_id=object_id,
        since=since,
        until=until,
        after_seq=after_seq,
        limit=limit,
    )
    return ActivityStreamResponse(
        items=[ActivityStreamItem.model_validate(row) for row in rows],
        next_after_seq=next_after_seq,
    )
