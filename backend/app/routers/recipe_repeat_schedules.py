"""story c7abdf42(2026-09-02, PO 확定) — 반복 스케줄(recipe_repeat_schedules) 프로젝트 설정
화면용 API. #3337(서버 스케줄러·tick)이 코어를 놓았으나 사람이 보고/재개하고/즉시 한 회차를
돌릴 자리가 없었다.

GET   /api/v2/projects/{project_id}/repeat-schedules             — 목록.
POST  /api/v2/projects/{project_id}/repeat-schedules/{id}/run-now — 즉시 한 회차(스케줄러
       tick과 동일 코드 경로 — recipe_repeat_scheduler.py::_run_one_schedule_cycle 재사용,
       새 로직 발명 0).
PATCH /api/v2/projects/{project_id}/repeat-schedules/{id}/resume  — paused→active(failure_count
       0·pause_reason 클리어).
PATCH /api/v2/projects/{project_id}/repeat-schedules/{id}/pause   — active→paused(수동 중지).

권한(PO 확定③, 이번 라운드) — read/write 전부 **project owner 또는 org owner/admin만**
(gate_config.py 쓰기 축과 동형, member read는 이번 스코프 밖 — 별도 접근 결정)."""
from __future__ import annotations

import uuid
from datetime import datetime

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
from sqlalchemy import select, text
from sqlalchemy.ext.asyncio import AsyncSession

from app.dependencies.auth import AuthContext, get_current_user
from app.dependencies.database import get_db
from app.models.recipe_repeat_schedule import RecipeRepeatSchedule
from app.services.project_auth import get_project_role, is_org_owner_or_admin

router = APIRouter(prefix="/api/v2/projects", tags=["recipe-repeat-schedules"])


class RepeatScheduleResponse(BaseModel):
    id: uuid.UUID
    project_id: uuid.UUID
    definition_key: str
    definition_title: str | None = None
    repeat: str
    next_run_at: datetime
    last_run_at: datetime | None
    last_story_reference_token: str | None = None
    status: str
    pause_reason: str | None = None
    consecutive_failure_count: int


async def _project_org_id(session: AsyncSession, project_id: uuid.UUID) -> uuid.UUID:
    """gate_config.py::_project_org_id와 동형(새 판별 로직 발명 0)."""
    row = (await session.execute(
        text("SELECT org_id FROM projects WHERE id = :pid AND deleted_at IS NULL"),
        {"pid": str(project_id)},
    )).first()
    if row is None:
        raise HTTPException(status_code=404, detail="Project not found")
    return row[0]


async def _definition_title(session: AsyncSession, *, org_id: uuid.UUID, key: str) -> str | None:
    from app.models.event_definition import EventDefinition
    from sqlalchemy import or_

    row = (await session.execute(
        select(EventDefinition.name).where(
            EventDefinition.key == key,
            or_(EventDefinition.org_id == org_id, EventDefinition.org_id.is_(None)),
        ).order_by(EventDefinition.org_id.is_(None)).limit(1)
    )).scalar_one_or_none()
    return row


async def _last_story_reference_token(session: AsyncSession, schedule: RecipeRepeatSchedule) -> str | None:
    if schedule.work_item_type != "story" or schedule.last_story_id is None:
        return None
    from app.models.pm import Story
    from app.services.reference_token import build_reference_token

    title = (await session.execute(
        select(Story.title).where(Story.id == schedule.last_story_id, Story.org_id == schedule.org_id)
    )).scalar_one_or_none()
    if title is None:
        return None
    return build_reference_token("story", schedule.last_story_id, title)


async def _to_response(session: AsyncSession, schedule: RecipeRepeatSchedule) -> RepeatScheduleResponse:
    return RepeatScheduleResponse(
        id=schedule.id, project_id=schedule.project_id, definition_key=schedule.definition_key,
        definition_title=await _definition_title(session, org_id=schedule.org_id, key=schedule.definition_key),
        repeat=schedule.repeat, next_run_at=schedule.next_run_at, last_run_at=schedule.last_run_at,
        last_story_reference_token=await _last_story_reference_token(session, schedule),
        status=schedule.status, pause_reason=schedule.pause_reason,
        consecutive_failure_count=schedule.consecutive_failure_count,
    )


async def _get_schedule_or_404(session: AsyncSession, *, project_id: uuid.UUID, schedule_id: uuid.UUID) -> RecipeRepeatSchedule:
    row = (await session.execute(
        select(RecipeRepeatSchedule).where(
            RecipeRepeatSchedule.id == schedule_id, RecipeRepeatSchedule.project_id == project_id,
        )
    )).scalar_one_or_none()
    if row is None:
        raise HTTPException(status_code=404, detail="repeat schedule not found")
    return row


@router.get("/{project_id}/repeat-schedules", response_model=list[RepeatScheduleResponse])
async def list_repeat_schedules(
    project_id: uuid.UUID,
    auth: AuthContext = Depends(get_current_user),
    session: AsyncSession = Depends(get_db),
) -> list[RepeatScheduleResponse]:
    org_id = await _project_org_id(session, project_id)
    actor = uuid.UUID(auth.user_id)
    if not (
        (await get_project_role(session, actor, project_id)) == "owner"
        or await is_org_owner_or_admin(session, actor, org_id)
    ):
        raise HTTPException(status_code=403, detail="project owner or org owner/admin required")

    rows = (await session.execute(
        select(RecipeRepeatSchedule)
        .where(RecipeRepeatSchedule.project_id == project_id)
        .order_by(RecipeRepeatSchedule.next_run_at.asc())
    )).scalars().all()
    return [await _to_response(session, row) for row in rows]


@router.post("/{project_id}/repeat-schedules/{schedule_id}/run-now", response_model=RepeatScheduleResponse)
async def run_repeat_schedule_now(
    project_id: uuid.UUID,
    schedule_id: uuid.UUID,
    auth: AuthContext = Depends(get_current_user),
    session: AsyncSession = Depends(get_db),
) -> RepeatScheduleResponse:
    """스케줄러 tick(recipe_repeat_scheduler.py::_run_one_schedule_cycle)과 완전히 같은
    코드 경로 — 새 회차 발행 로직 발명 0. 동시 cron tick과의 경합은 FOR UPDATE NOWAIT로
    막는다(배치 tick의 SKIP LOCKED와 달리, 단건 수동 트리거는 "건너뛰기"가 아니라 "지금은
    처리 중이니 잠시 후 다시" 신호가 맞다 — 조용히 아무 일도 안 하는 SKIP LOCKED는 사람이
    누른 버튼에 어울리지 않는다)."""
    from sqlalchemy.exc import OperationalError

    from app.services.recipe_repeat_scheduler import _run_one_schedule_cycle

    org_id = await _project_org_id(session, project_id)
    actor = uuid.UUID(auth.user_id)
    if not (
        (await get_project_role(session, actor, project_id)) == "owner"
        or await is_org_owner_or_admin(session, actor, org_id)
    ):
        raise HTTPException(status_code=403, detail="project owner or org owner/admin required")

    try:
        schedule = (await session.execute(
            select(RecipeRepeatSchedule).where(
                RecipeRepeatSchedule.id == schedule_id, RecipeRepeatSchedule.project_id == project_id,
            ).with_for_update(nowait=True)
        )).scalar_one_or_none()
    except OperationalError as exc:
        await session.rollback()
        raise HTTPException(status_code=409, detail="이 스케줄은 지금 다른 회차가 처리 중입니다 — 잠시 후 다시 시도하세요.") from exc
    if schedule is None:
        raise HTTPException(status_code=404, detail="repeat schedule not found")

    await _run_one_schedule_cycle(session, schedule)
    # story c7abdf42 자체 발견 — _run_one_schedule_cycle 내부의 last_story_id/next_run_at
    # 갱신(maybe_upsert_repeat_schedule)은 pg_insert(...).on_conflict_do_update(...) 원시
    # SQL이라 ORM identity map을 안 거친다. expire_on_commit=False(get_db 기본) 세션에서는
    # 이 `schedule` 파이썬 객체가 커밋 후에도 옛 컬럼값을 그대로 들고 있다(test_3337 원 테스트도
    # 이 이유로 매 tick 뒤 s.refresh(schedule)을 명시적으로 부른다, 동일 패턴) — refresh 없이
    # 응답을 그대로 만들면 방금 발행한 새 회차가 반영 안 된 stale 응답이 나간다.
    await session.refresh(schedule)
    return await _to_response(session, schedule)


@router.patch("/{project_id}/repeat-schedules/{schedule_id}/resume", response_model=RepeatScheduleResponse)
async def resume_repeat_schedule(
    project_id: uuid.UUID,
    schedule_id: uuid.UUID,
    auth: AuthContext = Depends(get_current_user),
    session: AsyncSession = Depends(get_db),
) -> RepeatScheduleResponse:
    """paused→active. consecutive_failure_count 0으로 리셋(재개는 새출발 — 예전 실패
    카운트를 들고 가면 재개 즉시 1~2회만 더 실패해도 다시 3회 문턱에 걸린다)·pause_reason
    클리어(더 이상 paused가 아니므로 "왜 멈췄나"는 무의미)."""
    org_id = await _project_org_id(session, project_id)
    actor = uuid.UUID(auth.user_id)
    if not (
        (await get_project_role(session, actor, project_id)) == "owner"
        or await is_org_owner_or_admin(session, actor, org_id)
    ):
        raise HTTPException(status_code=403, detail="project owner or org owner/admin required")

    schedule = await _get_schedule_or_404(session, project_id=project_id, schedule_id=schedule_id)
    schedule.status = "active"
    schedule.consecutive_failure_count = 0
    schedule.pause_reason = None
    # 재개 시점부터 다시 카운트되도록 next_run_at을 지금으로 당기지 않는다(원래 스케줄
    # 그대로 유지 — 재개 자체가 "지금 한 회차"를 뜻하지 않는다, 그건 run-now의 몫).
    await session.commit()
    return await _to_response(session, schedule)


@router.patch("/{project_id}/repeat-schedules/{schedule_id}/pause", response_model=RepeatScheduleResponse)
async def pause_repeat_schedule(
    project_id: uuid.UUID,
    schedule_id: uuid.UUID,
    auth: AuthContext = Depends(get_current_user),
    session: AsyncSession = Depends(get_db),
) -> RepeatScheduleResponse:
    """active→paused(사람이 직접 중지 — 정지 조건 3종과 구별되는 4번째 사유)."""
    org_id = await _project_org_id(session, project_id)
    actor = uuid.UUID(auth.user_id)
    if not (
        (await get_project_role(session, actor, project_id)) == "owner"
        or await is_org_owner_or_admin(session, actor, org_id)
    ):
        raise HTTPException(status_code=403, detail="project owner or org owner/admin required")

    schedule = await _get_schedule_or_404(session, project_id=project_id, schedule_id=schedule_id)
    schedule.status = "paused"
    schedule.pause_reason = "수동으로 중지되었습니다"
    await session.commit()
    return await _to_response(session, schedule)
