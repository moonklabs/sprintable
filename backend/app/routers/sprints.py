import uuid
from datetime import date as date_type

from fastapi import APIRouter, BackgroundTasks, Depends, HTTPException, Query
from pydantic import BaseModel
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.dependencies.auth import AuthContext, get_current_user, get_verified_org_id
from app.dependencies.database import get_db
from app.models.pm import Story
from app.models.team import TeamMember
from app.repositories.sprint import SprintRepository
from app.schemas.sprint import KickoffBody, SprintCreate, SprintResponse, SprintUpdate, compute_sprint_duration
from app.services.notification_dispatch import dispatch_notification

router = APIRouter(prefix="/api/v2/sprints", tags=["sprints"])


def _get_repo(
    session: AsyncSession = Depends(get_db),
    org_id: uuid.UUID = Depends(get_verified_org_id),
) -> SprintRepository:
    return SprintRepository(session, org_id)


@router.get("", response_model=list[SprintResponse])
async def list_sprints(
    project_id: uuid.UUID | None = Query(default=None),
    status_filter: str | None = Query(default=None, alias="status"),
    repo: SprintRepository = Depends(_get_repo),
) -> list[SprintResponse]:
    filters: dict = {}
    if project_id:
        filters["project_id"] = project_id
    if status_filter:
        filters["status"] = status_filter
    sprints = await repo.list(**filters)
    return [SprintResponse.model_validate(s) for s in sprints]


@router.post("", response_model=SprintResponse, status_code=201)
async def create_sprint(
    body: SprintCreate,
    background_tasks: BackgroundTasks,
    session: AsyncSession = Depends(get_db),
    auth: AuthContext = Depends(get_current_user),
    org_id: uuid.UUID = Depends(get_verified_org_id),
) -> SprintResponse:
    repo = SprintRepository(session, org_id)
    # 8a2bbda2: 날짜에서 duration 산출 저장(dates 단일진실·신규 정합). 날짜 없으면 model default(14).
    _dur = compute_sprint_duration(body.start_date, body.end_date)
    sprint = await repo.create(
        project_id=body.project_id,
        title=body.title,
        start_date=body.start_date,
        end_date=body.end_date,
        team_size=body.team_size,
        goal=body.goal,
        capacity=body.capacity,
        success_hypothesis=body.success_hypothesis,
        metric_definition=body.metric_definition,
        measure_after=body.measure_after,
        **({"duration": _dur} if _dur is not None else {}),
    )
    # 활동로그: sprint 생성 이벤트 기록 (생성류 미기록 갭 — 피드 정상화)
    from app.services.activity_log import record_created_activity
    await record_created_activity(
        background_tasks, auth=auth, org_id=org_id, db=session,
        entity_type="sprint", entity_id=sprint.id, project_id=sprint.project_id,
        title=sprint.title,
    )
    return SprintResponse.model_validate(sprint)


@router.get("/{id}", response_model=SprintResponse)
async def get_sprint(
    id: uuid.UUID,
    repo: SprintRepository = Depends(_get_repo),
) -> SprintResponse:
    sprint = await repo.get(id)
    if sprint is None:
        raise HTTPException(status_code=404, detail="Sprint not found")
    return SprintResponse.model_validate(sprint)


@router.patch("/{id}", response_model=SprintResponse)
async def update_sprint(
    id: uuid.UUID,
    body: SprintUpdate,
    repo: SprintRepository = Depends(_get_repo),
    session: AsyncSession = Depends(get_db),
    org_id: uuid.UUID = Depends(get_verified_org_id),
    auth: AuthContext = Depends(get_current_user),
) -> SprintResponse:
    data = body.model_dump(exclude_unset=True)
    # ⭐E-DG S26: status 변경은 transition_sprint 단일경로(FSM/overlay/human-gate) 경유 — PATCH 옆문
    # 봉인(S25 epic PATCH-bypass 교훈). 나머지 필드만 repo.update.
    _status_change = data.pop("status", None)
    if _status_change is not None:
        from app.services.sprint import SprintTransitionError, transition_sprint
        from app.services.member_resolver import resolve_member
        current = await repo.get(id)
        if current is not None and _status_change != current.status:
            caller = await resolve_member(auth, org_id, session)
            try:
                await transition_sprint(session, org_id, caller, id, _status_change)
            except SprintTransitionError as exc:
                # 까심 codex QA(2026-07-03, #1867): a353e88d 게이트가 구조화 code로
                # raise하는데 이 경로가 400+string으로만 매핑해 FE graceful-404 계약
                # (§5 handoff)이 깨졌다. 신규 code만 422+구조화 detail로 노출 — 기존
                # 코드(INVALID_STATUS 등)는 status/shape 그대로(회귀 0, PO 결).
                if exc.code == "HYPOTHESIS_REQUIRED_FOR_ACTIVATION":
                    raise HTTPException(
                        status_code=422, detail={"code": exc.code, "message": exc.message}
                    ) from exc
                raise HTTPException(status_code=400, detail=exc.message) from exc
            except ValueError as exc:
                raise HTTPException(status_code=400, detail=str(exc)) from exc
    # 8a2bbda2: 날짜가 갱신되면 duration 을 (병합된) 날짜에서 재산출 저장(dates 단일진실).
    if "start_date" in data or "end_date" in data:
        existing = await repo.get(id)
        if existing is not None:
            eff_start = data.get("start_date", existing.start_date)
            eff_end = data.get("end_date", existing.end_date)
            _dur = compute_sprint_duration(eff_start, eff_end)
            if _dur is not None:
                data["duration"] = _dur
    # status 만 전송돼 data 가 비면(transition_sprint 가 이미 적용) re-fetch 반환(빈 update 회피).
    sprint = await repo.update(id, **data) if data else await repo.get(id)
    if sprint is None:
        raise HTTPException(status_code=404, detail="Sprint not found")
    return SprintResponse.model_validate(sprint)


@router.delete("/{id}", status_code=200)
async def delete_sprint(
    id: uuid.UUID,
    repo: SprintRepository = Depends(_get_repo),
    session: AsyncSession = Depends(get_db),
    org_id: uuid.UUID = Depends(get_verified_org_id),
) -> dict:
    from app.repositories.dependency import DependencyRepository
    from app.repositories.label import ItemLabelRepository
    ok = await repo.delete(id)
    if not ok:
        raise HTTPException(status_code=404, detail="Sprint not found")
    await DependencyRepository(session, org_id).delete_by_item(id, "sprint")
    await ItemLabelRepository(session, org_id).delete_by_item(id, "sprint")
    return {"ok": True}


@router.post("/{id}/activate", response_model=SprintResponse)
async def activate_sprint(
    id: uuid.UUID,
    session: AsyncSession = Depends(get_db),
    org_id: uuid.UUID = Depends(get_verified_org_id),
    auth: AuthContext = Depends(get_current_user),
) -> SprintResponse:
    # E-DG S26: transition_sprint 단일경로 경유(line overlay 커버·옆문 봉인). repo.activate(1-active
    # 제약) 로직은 transition_sprint 가 위임 보존. default-off 면 즉시 활성(거동 동일).
    from app.services.sprint import SprintTransitionError, transition_sprint
    from app.services.member_resolver import resolve_member
    caller = await resolve_member(auth, org_id, session)
    try:
        sprint = await transition_sprint(session, org_id, caller, id, "active")
        await session.commit()
    except SprintTransitionError as exc:
        # 까심 codex QA(2026-07-03, #1867): 위 update_sprint와 동일 갭 — 신규 code만
        # 422+구조화 detail(FE §5 graceful 계약), 기존 코드는 backward-compat 유지.
        if exc.code == "HYPOTHESIS_REQUIRED_FOR_ACTIVATION":
            raise HTTPException(
                status_code=422, detail={"code": exc.code, "message": exc.message}
            ) from exc
        raise HTTPException(status_code=400, detail=exc.message) from exc
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    return SprintResponse.model_validate(sprint)


@router.post("/{id}/close", response_model=SprintResponse)
async def close_sprint(
    id: uuid.UUID,
    db: AsyncSession = Depends(get_db),
    org_id: uuid.UUID = Depends(get_verified_org_id),
    auth: AuthContext = Depends(get_current_user),
) -> SprintResponse:
    # E-DG S26: transition_sprint 단일경로 경유(line overlay 커버·옆문 봉인). repo.close(velocity·
    # active|review 수용) 로직 위임 보존. default-off/advisory 면 즉시 마감(거동 동일).
    from app.services.sprint import SprintTransitionError, transition_sprint
    from app.services.member_resolver import resolve_member
    caller = await resolve_member(auth, org_id, db)
    try:
        sprint = await transition_sprint(db, org_id, caller, id, "closed")
    except (SprintTransitionError, ValueError) as exc:
        raise HTTPException(status_code=400, detail=getattr(exc, "message", str(exc))) from exc
    # E-EVENTBUS P3 S9: sprint_closed → 프로젝트 전체 active 멤버에게 알림. ⚠️실제 마감(status==closed)일
    # 때만(미래 enforcing gate-pending 시 status 유지 → 오알림 방지).
    if sprint.project_id and sprint.status == "closed":
        members_result = await db.execute(
            select(TeamMember.id).where(
                TeamMember.project_id == sprint.project_id,
                TeamMember.is_active.is_(True),
                TeamMember.type == "human",
            )
        )
        member_ids = [row[0] for row in members_result.all()]
        if member_ids:
            await dispatch_notification(
                db,
                org_id=org_id,
                event_type="sprint_closed",
                target_member_ids=member_ids,
                title=f"스프린트 종료: {sprint.title}",
                body=None,
                reference_type="sprint",
                reference_id=sprint.id,
            )
    return SprintResponse.model_validate(sprint)


@router.post("/{id}/kickoff")
async def kickoff_sprint(
    id: uuid.UUID,
    body: KickoffBody = KickoffBody(),
    repo: SprintRepository = Depends(_get_repo),
) -> dict:
    sprint = await repo.get(id)
    if sprint is None:
        raise HTTPException(status_code=404, detail="Sprint not found")
    # Notification dispatch is Phase D — return stub for Phase B
    return {"notified": 0, "sprint_id": str(id), "message": body.message}


@router.get("/{id}/summary")
async def sprint_summary(
    id: uuid.UUID,
    db: AsyncSession = Depends(get_db),
    repo: SprintRepository = Depends(_get_repo),
) -> dict:
    """GET /api/v2/sprints/{id}/summary — 스프린트 스토리 상태별 집계 (AC3 S-STANDUP-FIX)."""
    sprint = await repo.get(id)
    if sprint is None:
        raise HTTPException(status_code=404, detail="Sprint not found")

    stories_result = await db.execute(
        select(Story.status, Story.story_points).where(Story.sprint_id == id)
    )
    stories = stories_result.all()

    status_counts: dict[str, int] = {}
    status_points: dict[str, int] = {}
    for s in stories:
        status_counts[s.status] = status_counts.get(s.status, 0) + 1
        status_points[s.status] = status_points.get(s.status, 0) + (s.story_points or 0)

    total_stories = len(stories)
    total_points = sum(s.story_points or 0 for s in stories)
    done_points = status_points.get("done", 0)
    completion_pct = round((done_points / total_points) * 100) if total_points > 0 else 0

    return {
        "sprint_id": str(id),
        "total_stories": total_stories,
        "total_points": total_points,
        "done_points": done_points,
        "completion_pct": completion_pct,
        # 실제 DB에 존재하는 상태값 기준 동적 생성 — 하드코딩 시 enum 불일치 위험 방지
        "by_status": {
            status: {"count": count, "points": status_points.get(status, 0)}
            for status, count in status_counts.items()
        },
    }


@router.get("/{id}/checkin")
async def checkin_sprint(
    id: uuid.UUID,
    date: str = Query(..., description="YYYY-MM-DD"),
    db: AsyncSession = Depends(get_db),
    repo: SprintRepository = Depends(_get_repo),
) -> dict:
    sprint = await repo.get(id)
    if sprint is None:
        raise HTTPException(status_code=404, detail="Sprint not found")

    try:
        checkin_date = date_type.fromisoformat(date)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail="Invalid date format, expected YYYY-MM-DD") from exc

    stories_result = await db.execute(
        select(Story.status, Story.story_points).where(Story.sprint_id == id)
    )
    stories = stories_result.all()

    # AC3-3(T3, #1167 회귀 방지): standup 미제출자를 canonical members.id로 집계 — team_members vs raw
    # author_id 직접 비교는 canonical 저장분을 못 보고 레거시 휴먼을 "제출했는데 missing"으로 오판한다.
    # repository.get_missing(effective 휴먼 access ∪ alias 정규화)와 동일 SSOT. 이름은 members(canonical).
    from app.models.member import Member
    from app.repositories.standup import StandupEntryRepository

    missing_ids = await StandupEntryRepository(db, repo.org_id).get_missing(
        sprint.project_id, checkin_date
    )
    name_map: dict[uuid.UUID, str] = {}
    if missing_ids:
        name_rows = await db.execute(
            select(Member.id, Member.name).where(Member.id.in_(missing_ids))
        )
        name_map = {mid: nm for mid, nm in name_rows.all()}

    total_stories = len(stories)
    total_points = sum(s.story_points or 0 for s in stories)
    done_points = sum(s.story_points or 0 for s in stories if s.status == "done")
    completion_pct = round((done_points / total_points) * 100) if total_points > 0 else 0
    missing_standups = [
        {"id": str(mid), "name": name_map.get(mid, str(mid))}
        for mid in missing_ids
    ]

    return {
        "total_stories": total_stories,
        "total_points": total_points,
        "done_points": done_points,
        "completion_pct": completion_pct,
        "missing_standups": missing_standups,
    }


class SprintTransitionRequest(BaseModel):
    status: str


@router.post("/{id}/transition", response_model=SprintResponse)
async def transition_sprint_endpoint(
    id: uuid.UUID,
    body: SprintTransitionRequest,
    session: AsyncSession = Depends(get_db),
    org_id: uuid.UUID = Depends(get_verified_org_id),
    auth: AuthContext = Depends(get_current_user),
) -> SprintResponse:
    """E-DG S26: sprint status 전이 캐노니컬 경로(activate/close 외 review/archived 포함). FSM/overlay/
    human-gate(enforcing) 단일 SSOT. caller 인증 컨텍스트 도출(RC① 패턴)."""
    from app.services.sprint import SprintTransitionError, transition_sprint
    from app.services.member_resolver import resolve_member
    caller = await resolve_member(auth, org_id, session)
    try:
        sprint = await transition_sprint(session, org_id, caller, id, body.status)
        await session.commit()
        return SprintResponse.model_validate(sprint)
    except SprintTransitionError as e:
        _codes = {"SPRINT_NOT_FOUND": 404, "HUMAN_CONFIRM_REQUIRED": 403,
                  "INVALID_STATUS": 422, "INVALID_SPRINT_TRANSITION": 422,
                  # a353e88d — precondition-validation(형제 코드와 동급), PO 결 422.
                  "HYPOTHESIS_REQUIRED_FOR_ACTIVATION": 422}
        raise HTTPException(status_code=_codes.get(e.code, 400), detail={"code": e.code, "message": e.message})
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
