import uuid
from datetime import datetime
from typing import Literal

from fastapi import APIRouter, Depends, HTTPException, Query
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.datetime_query import aware_datetime_query
from app.dependencies.auth import AuthContext, get_current_user, get_verified_org_id
from app.dependencies.database import get_db
from app.schemas.activity_stream import ActivityStreamItem, ActivityStreamResponse
from app.services.activity_stream import query_activity_stream
from app.services.project_auth import has_project_access

router = APIRouter(prefix="/api/v2/activity-stream", tags=["activity-stream", "Trust"])

# story #4294 — 기간 파라미터는 오프셋 필수(`app/core/datetime_query.py`) · 기본값 호출을 모듈 상수로(ruff B008).
_SINCE_QUERY = Depends(aware_datetime_query("since", description="occurred_at >= since"))
_UNTIL_QUERY = Depends(aware_datetime_query("until", description="occurred_at <= until"))


@router.get("", response_model=ActivityStreamResponse)
async def get_activity_stream(
    project_id: uuid.UUID | None = Query(default=None),
    actor_id: uuid.UUID | None = Query(default=None),
    verb: str | None = Query(default=None),
    object_type: str | None = Query(default=None),
    object_id: uuid.UUID | None = Query(default=None),
    # story #4294 — 오프셋 없는 일시는 422(`app/core/datetime_query.py`).
    since: datetime | None = _SINCE_QUERY,
    until: datetime | None = _UNTIL_QUERY,
    after_seq: int | None = Query(default=None, description="activity_seq > after_seq (cursor · order=asc)"),
    before_seq: int | None = Query(default=None, description="activity_seq < before_seq (cursor · order=desc)"),
    order: Literal["asc", "desc"] = Query(default="asc", description="asc (default, oldest first) | desc (newest first)"),
    limit: int = Query(default=50, ge=1, le=200),
    db: AsyncSession = Depends(get_db),
    org_id: uuid.UUID = Depends(get_verified_org_id),
    auth: AuthContext = Depends(get_current_user),
) -> ActivityStreamResponse:
    """GET /api/v2/activity-stream — 에이전트 team-context 읽기.

    org-scope 강제(AC①). activity_seq cursor 페이지네이션(AC③) — 기본 ASC · after_seq(무변 · 공개 계약),
    order=desc면 최신부터 · before_seq(story #4297 · 사람이 보는 활동 로그). 커서는 방향마다 하나만 받는다
    (거꾸로 된 짝은 422 — 조용히 무시하면 호출자가 페이지를 건너뛰었다고 모른다). 응답은 canonical
    활동(source/recipient/payload·AC④)만 — delivery-only status/read는 미포함(AC⑤).
    """
    # ratchet round7(잔여 HIGH) — activity_logs와 동형: project_id 필터(지정 시)에
    # caller 접근권 검증이 없어 same-org cross-project 활동 스트림이 노출됐다.
    # actor_id/object_id 등은 project로 직접 환원되는 FK가 아니라(result-level 노출 축은
    # 별도 스토리 d3e5ca89) 이 라운드 스코프 밖.
    if project_id is not None:
        if not await has_project_access(db, uuid.UUID(auth.user_id), project_id, org_id):
            raise HTTPException(status_code=404, detail="Project not found")

    if order == "asc" and before_seq is not None:
        raise HTTPException(status_code=422, detail="before_seq requires order=desc")
    if order == "desc" and after_seq is not None:
        raise HTTPException(status_code=422, detail="after_seq requires order=asc (the default)")

    # story #4350 — project 필터 없으면 caller가 접근 가능한 프로젝트의 활동만(SEC-S8 선생님 확정: org 전체 노출 = 갭).
    project_ids = None
    if project_id is None:
        from app.services.project_auth import accessible_project_ids_in_org
        project_ids = await accessible_project_ids_in_org(db, uuid.UUID(auth.user_id), org_id)
    rows, next_cursor = await query_activity_stream(
        db,
        org_id,
        project_id=project_id,
        project_ids=project_ids,
        actor_id=actor_id,
        verb=verb,
        object_type=object_type,
        object_id=object_id,
        since=since,
        until=until,
        after_seq=after_seq,
        before_seq=before_seq,
        order=order,
        limit=limit,
    )
    return ActivityStreamResponse(
        items=[ActivityStreamItem.model_validate(row) for row in rows],
        next_after_seq=next_cursor if order == "asc" else None,
        next_before_seq=next_cursor if order == "desc" else None,
    )
