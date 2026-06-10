import uuid
from datetime import datetime, timezone

from fastapi import APIRouter, BackgroundTasks, Body, Depends, HTTPException, Query, Response
from pydantic import BaseModel
from sqlalchemy import or_, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.dependencies.auth import AuthContext, enforce_body_context, get_current_user, get_project_scoped_org_id, get_verified_org_id
from app.dependencies.database import get_db
from app.models.event import Event
from app.models.pm import Epic, Story, StoryActivity, StoryComment
from app.models.team import TeamMember
from app.repositories.story import StoryRepository
from app.repositories.story_assignee import StoryAssigneeRepository
from app.routers.agent_gateway import wake_agent
from app.routers.events import publish_event
from app.services.event_seq import assign_recipient_seq
from app.schemas.story import StoryCreate, StoryResponse, StoryStatusUpdate, StoryUpdate
from app.services.member_resolver import canonicalize_member_id
from app.services.notification_dispatch import dispatch_notification
from app.services.webhook_dispatch import fire_webhooks
from app.services.workflow_pipeline import process_event
from app.services.rule_evaluator import EventContext
from app.services.workflow_violation import build_violation_event, check_transition

router = APIRouter(prefix="/api/v2/stories", tags=["stories"])


async def _resolve_actor_info(
    db: AsyncSession, actor_id: uuid.UUID | None
) -> tuple[str | None, str | None, str | None]:
    """Returns (name, role, member_type) for a TeamMember ID."""
    if not actor_id:
        return None, None, None
    result = await db.execute(select(TeamMember).where(TeamMember.id == actor_id).limit(1))
    member = result.scalar_one_or_none()
    return (
        member.name if member else None,
        member.role if member else None,
        member.type if member else None,
    )


async def _resolve_epic_title(db: AsyncSession, epic_id: uuid.UUID | None) -> str | None:
    if not epic_id:
        return None
    result = await db.execute(select(Epic).where(Epic.id == epic_id).limit(1))
    epic = result.scalar_one_or_none()
    return epic.title if epic else None


def _get_repo(
    session: AsyncSession = Depends(get_db),
    org_id: uuid.UUID = Depends(get_project_scoped_org_id),
) -> StoryRepository:
    return StoryRepository(session, org_id)


@router.get("", response_model=list[StoryResponse])
async def list_stories(
    project_id: uuid.UUID | None = Query(default=None),
    epic_id: uuid.UUID | None = Query(default=None),
    sprint_id: uuid.UUID | None = Query(default=None),
    assignee_id: uuid.UUID | None = Query(default=None),
    status_filter: str | None = Query(default=None, alias="status"),
    no_sprint: bool = Query(default=False, description="sprint 미배정 스토리만 반환"),
    limit: int = Query(default=1000, ge=1, le=2000),
    cursor: str | None = Query(default=None, description="Cursor: ISO 8601 created_at, fetch before this time"),
    response: Response = None,  # type: ignore[assignment]
    repo: StoryRepository = Depends(_get_repo),
) -> list[StoryResponse]:
    from datetime import datetime

    if no_sprint and project_id:
        stories = await repo.list_backlog(project_id, limit=limit)
        await _attach_assignee_ids(repo.session, repo.org_id, stories)
        return [StoryResponse.model_validate(s) for s in stories]

    # CB-S4: status + project_id 조합 시 board 쿼리 (order_by + cursor + done 7일 제한)
    if status_filter and project_id:
        cursor_dt = datetime.fromisoformat(cursor) if cursor else None
        stories, total = await repo.list_board(
            project_id=project_id,
            status=status_filter,
            limit=min(limit, 20) if status_filter == "done" else limit,
            cursor=cursor_dt,
            sprint_id=sprint_id,
            assignee_id=assignee_id,
        )
        if response is not None:
            response.headers["X-Total-Count"] = str(total)
            if stories:
                response.headers["X-Next-Cursor"] = stories[-1].created_at.isoformat()
        await _attach_assignee_ids(repo.session, repo.org_id, stories)
        return [StoryResponse.model_validate(s) for s in stories]

    filters: dict = {}
    if project_id:
        filters["project_id"] = project_id
    if epic_id:
        filters["epic_id"] = epic_id
    if sprint_id:
        filters["sprint_id"] = sprint_id
    if assignee_id:
        filters["assignee_id"] = assignee_id
    if status_filter:
        filters["status"] = status_filter
    stories = await repo.list(limit=limit, **filters)
    await _attach_assignee_ids(repo.session, repo.org_id, stories)
    return [StoryResponse.model_validate(s) for s in stories]


async def _attach_assignee_ids(
    session: AsyncSession, org_id: uuid.UUID, stories: list[Story]
) -> None:
    """E-BOARD S5: 각 Story에 assignee_ids(transient attr)를 채워 StoryResponse.from_attributes가
    읽도록 한다. join 비어있으면 단일 assignee_id로 폴백(레거시 행 back-compat). N+1 회피 위해 배치."""
    if not stories:
        return
    sa_repo = StoryAssigneeRepository(session, org_id)
    id_map = await sa_repo.map_member_ids([s.id for s in stories])
    for s in stories:
        ids = id_map.get(s.id)
        if not ids:
            ids = [s.assignee_id] if s.assignee_id else []
        s.assignee_ids = ids  # 매핑되지 않은 transient 속성 — from_attributes 전용


async def _upsert_assignee_participation(
    session: AsyncSession, org_id: uuid.UUID, story_id: uuid.UUID, assignee_id: uuid.UUID
) -> None:
    """assignee 설정 시 implementation(default) 역할 participation 자동 upsert (멱등)."""
    from app.repositories.participation import ParticipationRepository, ParticipationRoleRepository
    role_repo = ParticipationRoleRepository(session, org_id)
    default_role = await role_repo.get_default()
    if default_role is None:
        return
    p_repo = ParticipationRepository(session, org_id)
    if not await p_repo.exists(story_id, assignee_id, default_role.id):
        await p_repo.create(story_id=story_id, member_id=assignee_id, role_id=default_role.id)


@router.post("", response_model=StoryResponse, status_code=201)
async def create_story(
    body: StoryCreate,
    session: AsyncSession = Depends(get_db),
    auth: AuthContext = Depends(get_current_user),
    org_id: uuid.UUID = Depends(get_verified_org_id),
) -> StoryResponse:
    await enforce_body_context(
        auth_org_id=org_id,
        body_org_id=body.org_id,
        body_project_id=body.project_id,
        auth_project_id=auth.claims.get("app_metadata", {}).get("project_id"),
        db=session,
        user_id=uuid.UUID(auth.user_id),
    )
    repo = StoryRepository(session, org_id)
    # E-BOARD S5: assignee_ids 제공 시 단일 assignee_id(주담당)는 첫 요소로 동기화(미지정 시).
    effective_ids = (
        body.assignee_ids if body.assignee_ids is not None
        else ([body.assignee_id] if body.assignee_id else [])
    )
    primary_assignee = (
        body.assignee_id if body.assignee_id is not None
        else (effective_ids[0] if effective_ids else None)
    )
    story = await repo.create(
        project_id=body.project_id,
        title=body.title,
        epic_id=body.epic_id,
        sprint_id=body.sprint_id,
        assignee_id=primary_assignee,
        meeting_id=body.meeting_id,
        status=body.status,
        priority=body.priority,
        story_points=body.story_points,
        description=body.description,
        acceptance_criteria=body.acceptance_criteria,
        position=body.position,
        success_hypothesis=body.success_hypothesis,
        metric_definition=body.metric_definition,
        measure_after=body.measure_after,
        # E-FILE S4: 보드 스토리 첨부 (FE-proxy URL+메타) 저장
        attachments=[a.model_dump() for a in body.attachments],
    )
    # E-BOARD S5: 복수 assignee join 기록 (단일 assignee_id와 공존)
    saved_ids = await StoryAssigneeRepository(session, org_id).set_for_story(story.id, effective_ids)
    # E-CAGE-REFEREE: assignee 설정 시 implementation 역할 participation 자동 생성
    if primary_assignee:
        await _upsert_assignee_participation(session, org_id, story.id, primary_assignee)
    story.assignee_ids = saved_ids or ([story.assignee_id] if story.assignee_id else [])
    return StoryResponse.model_validate(story)


@router.get("/{id}", response_model=StoryResponse)
async def get_story(
    id: uuid.UUID,
    repo: StoryRepository = Depends(_get_repo),
) -> StoryResponse:
    story = await repo.get(id)
    if story is None:
        raise HTTPException(status_code=404, detail="Story not found")
    await _attach_assignee_ids(repo.session, repo.org_id, [story])
    return StoryResponse.model_validate(story)


class BulkUpdateItem(BaseModel):
    id: uuid.UUID
    status: str | None = None
    sprint_id: uuid.UUID | None = None
    assignee_id: uuid.UUID | None = None
    priority: str | None = None
    position: int | None = None


class BulkUpdateRequest(BaseModel):
    # FE(kanban-board.tsx)는 `{ items: [...] }` 래퍼로 전송한다. BE 도 동일 계약을 수용해야
    # "Input should be a valid list" 422 안 난다(맨 배열 아님). /bulk 유일 소비자=FE dnd.
    items: list[BulkUpdateItem]


# ⚠️ /bulk 은 /{id} 보다 **먼저** 선언해야 한다(FastAPI 라우트 매칭=선언 순서·specific-before-
# parameterized). 아니면 PATCH /api/v2/stories/bulk 가 /{id} 에 매칭돼 id="bulk" UUID 파싱
# 422 → /bulk 핸들러 영영 shadow(dnd 보드 상태저장이 처음부터 깨져있던 근본). 선생님 dnd 실테스트 적출.
@router.patch("/bulk", response_model=list[StoryResponse])
async def bulk_update_stories(
    payload: BulkUpdateRequest,
    db: AsyncSession = Depends(get_db),
    repo: StoryRepository = Depends(_get_repo),
) -> list[StoryResponse]:
    updated: list[Story] = []
    for item in payload.items:
        q = await db.execute(select(Story).where(Story.id == item.id))
        story = q.scalar_one_or_none()
        if not story:
            continue
        update_data = item.model_dump(exclude={"id"}, exclude_none=True)
        for k, v in update_data.items():
            setattr(story, k, v)
        # E-BOARD S5: 단일 assignee_id 변경 시 join 미러(단일↔복수 공존 정합)
        if "assignee_id" in update_data:
            single = [story.assignee_id] if story.assignee_id else []
            await StoryAssigneeRepository(db, repo.org_id).set_for_story(story.id, single)
        updated.append(story)
    await _attach_assignee_ids(db, repo.org_id, updated)
    results = [StoryResponse.model_validate(s) for s in updated]
    await db.commit()
    return results


@router.patch("/{id}", response_model=StoryResponse)
async def update_story(
    id: uuid.UUID,
    body: StoryUpdate,
    background_tasks: BackgroundTasks,
    repo: StoryRepository = Depends(_get_repo),
    db: AsyncSession = Depends(get_db),
    auth: AuthContext = Depends(get_current_user),
) -> StoryResponse:
    data = body.model_dump(exclude_unset=True)
    # E-BOARD S5: assignee_ids는 stories 컬럼이 아니므로 repo.update 전에 분리.
    assignee_ids_in = data.pop("assignee_ids", None)
    # assignee_ids만 제공되면 단일 assignee_id(주담당)를 첫 요소로 동기화 → 기존 event/notify 로직 재사용.
    if assignee_ids_in is not None and "assignee_id" not in data:
        data["assignee_id"] = assignee_ids_in[0] if assignee_ids_in else None
    old_assignee_id: uuid.UUID | None = None
    if "assignee_id" in data:
        story_before = await repo.get(id)
        if story_before:
            old_assignee_id = story_before.assignee_id
    story = await repo.update(id, **data)
    if story is None:
        raise HTTPException(status_code=404, detail="Story not found")

    # E-BOARD S5: 복수 assignee join 동기화 (단일 assignee_id와 정합 유지)
    if assignee_ids_in is not None:
        await StoryAssigneeRepository(db, repo.org_id).set_for_story(story.id, assignee_ids_in)
    elif "assignee_id" in data:
        # 구 단일 클라이언트 경로 → join을 단일값으로 미러(공존 정합)
        single = [story.assignee_id] if story.assignee_id else []
        await StoryAssigneeRepository(db, repo.org_id).set_for_story(story.id, single)

    # E-CAGE-REFEREE: assignee 변경(신규 세팅) 시 implementation 역할 participation 자동 upsert
    if "assignee_id" in data and story.assignee_id:
        await _upsert_assignee_participation(db, repo.org_id, story.id, story.assignee_id)

    # 변경사항 먼저 commit — side effects 에러가 rollback시키지 않도록
    await db.commit()

    # S-C2: 모든 스토리 업데이트에서 actor resolve — assignee 변경 여부와 무관하게 공통 적용
    actor_id: uuid.UUID | None = None
    actor_name: str | None = None
    actor_role: str | None = None
    actor_type: str | None = None
    try:
        actor_id = await _resolve_team_member_id(auth, repo.org_id, db)
        actor_name, actor_role, actor_type = await _resolve_actor_info(db, actor_id)
    except Exception:
        pass

    if "assignee_id" in data and old_assignee_id != story.assignee_id:
        org_id = repo.org_id
        epic_title: str | None = None
        try:
            epic_title = await _resolve_epic_title(db, story.epic_id)
        except Exception:
            pass
        event_data = {
            "story_id": str(id),
            "story_title": story.title,
            "story_priority": story.priority,
            "epic_id": str(story.epic_id) if story.epic_id else None,
            "epic_title": epic_title,
            "assignee_id": str(story.assignee_id) if story.assignee_id else None,
            "old_assignee_id": str(old_assignee_id) if old_assignee_id else None,
            "project_id": str(story.project_id),
            "org_id": str(org_id),
            "actor_id": str(actor_id) if actor_id else None,
            "actor_name": actor_name,
            "actor_role": actor_role,
            "source_agent_id": str(actor_id) if (actor_id and actor_type == "agent") else None,
            "assignees": [str(story.assignee_id)] if story.assignee_id else [],
            "timestamp": datetime.now(timezone.utc).isoformat(),
        }
        publish_event(str(org_id), "story.assignee_changed", event_data)
        try:
            await fire_webhooks(db, org_id, "story.assignee_changed", event_data)
        except Exception:
            pass
        try:
            await process_event(db, org_id, story.project_id, EventContext(
                event_type="story.assignee_changed",
                trigger_type_slug="assignee_changed",
                actor_id=str(actor_id) if actor_id else None,
                metadata=event_data,
            ))
        except Exception:
            pass
        # E-EVENTBUS P3 S9 / E-EVENT-INJECT S3: story_assigned 알림 + agent assignment-wake
        if story.assignee_id and story.assignee_id != old_assignee_id:
            # assignee 멤버 타입 resolve (agent vs human)
            assignee_type = (await db.execute(
                select(TeamMember.type).where(TeamMember.id == story.assignee_id).limit(1)
            )).scalar_one_or_none()

            if assignee_type == "agent":
                # E-EVENT-INJECT S3: agent에 배정만 해도 work-turn 시작.
                # dispatch.py 미러 — content 실린 story_assigned Event + seq + commit BEFORE wake.
                # (기존 dispatch_notification은 content 없는 dispatched라 connector가 드롭 → 깨우지 못함)
                _detail = (story.description or "").strip()
                _content = f"[story] {story.title}" + (f" — {_detail[:200]}" if _detail else "")
                sa_event = Event(
                    project_id=story.project_id,
                    org_id=org_id,
                    event_type="story_assigned",  # EventType enum 미존재 → literal (connector allow-list 포함)
                    source_entity_type="story",
                    source_entity_id=story.id,
                    sender_id=actor_id,
                    recipient_id=story.assignee_id,
                    recipient_type="agent",
                    payload={
                        "story_id": str(story.id),
                        "story_title": story.title,
                        "content": _content,
                        "event_type": "story_assigned",
                    },
                    status="pending",
                )
                db.add(sa_event)
                await db.flush()
                await assign_recipient_seq(db, sa_event)  # per-recipient dense seq
                await db.commit()  # commit BEFORE wake — seq 확정, 이중전달 방지
                if sa_event.recipient_seq is not None:
                    wake_agent(str(story.assignee_id), sa_event.recipient_seq)
                # 1f01c1ad: wake_agent(SSE)는 CC 세션 미도달 → member webhook(CC 릴레이)으로도 주입.
                # dispatch.py 동형 — INJECTABLE 이벤트의 단일 CC 주입 경로(member webhook)로 일관 전달.
                from app.services.conversation_webhook import deliver_injected_event_webhook
                background_tasks.add_task(
                    deliver_injected_event_webhook,
                    org_id=org_id,
                    recipient_id=story.assignee_id,
                    content=_content,
                    event_type="story_assigned",
                    source_entity_type="story",
                    source_entity_id=story.id,
                )
            else:
                # human: 기존 dispatch_notification 유지 (변경 0)
                await dispatch_notification(
                    db,
                    org_id=org_id,
                    event_type="story_assigned",
                    target_member_ids=[story.assignee_id],
                    title=f"스토리 담당자로 지정됨: {story.title}",
                    body=None,
                    reference_type="story",
                    reference_id=story.id,
                )
        if actor_id:
            try:
                db.add(StoryActivity(
                    story_id=id,
                    org_id=org_id,
                    project_id=story.project_id,
                    activity_type="assignee_changed",
                    old_value=str(old_assignee_id) if old_assignee_id else None,
                    new_value=str(story.assignee_id) if story.assignee_id else None,
                    created_by=(await canonicalize_member_id(actor_id, db)),  # AC3-2d(1b) canonical
                ))
                await db.flush()
            except Exception:
                pass

    # S-C2: story_updated — actor가 agent인 경우 기록 (AC2, AC6)
    if actor_id:
        from app.services.activity_log import record_activity_bg
        background_tasks.add_task(
            record_activity_bg,
            org_id=repo.org_id,
            action="story_updated",
            actor_id=actor_id,
            project_id=story.project_id,
            entity_type="story",
            entity_id=id,
            context={"fields": list(data.keys()), "story_title": story.title},
        )

    await _attach_assignee_ids(db, repo.org_id, [story])
    return StoryResponse.model_validate(story)


@router.delete("/{id}", status_code=200)
async def delete_story(
    id: uuid.UUID,
    repo: StoryRepository = Depends(_get_repo),
    session: AsyncSession = Depends(get_db),
    org_id: uuid.UUID = Depends(get_verified_org_id),
) -> dict:
    from app.repositories.dependency import DependencyRepository
    from app.repositories.label import ItemLabelRepository
    from app.repositories.participation import ParticipationRepository
    ok = await repo.delete(id)
    if not ok:
        raise HTTPException(status_code=404, detail="Story not found")
    await DependencyRepository(session, org_id).delete_by_item(id, "story")
    await ItemLabelRepository(session, org_id).delete_by_item(id, "story")
    await ParticipationRepository(session, org_id).delete_by_story(id)
    await StoryAssigneeRepository(session, org_id).delete_by_story(id)
    return {"ok": True}


@router.patch("/{id}/status", response_model=StoryResponse)
async def update_story_status(
    id: uuid.UUID,
    body: StoryStatusUpdate,
    background_tasks: BackgroundTasks,
    repo: StoryRepository = Depends(_get_repo),
    db: AsyncSession = Depends(get_db),
    auth: AuthContext = Depends(get_current_user),
) -> StoryResponse:
    story_before = await repo.get(id)
    old_status = story_before.status if story_before else None

    # AC1/AC5/AC7: violation 체크 — block 모드면 전이 거부
    from app.models.project import Project as ProjectModel
    _proj_result = await db.execute(
        select(ProjectModel).where(ProjectModel.id == story_before.project_id)
    ) if story_before else None
    _proj = _proj_result.scalar_one_or_none() if _proj_result else None
    _violation_level = getattr(_proj, "violation_level", "warn") if _proj else "warn"

    _violation = check_transition(old_status, body.status, _violation_level)
    if _violation.violated and _violation_level == "block":
        raise HTTPException(status_code=400, detail=_violation.reason or "워크플로우 위반으로 상태 전이가 거부되었습니다.")

    try:
        # AC2: violation_level 전달 → warn 모드이면 set_status hard block 우회
        story = await repo.set_status(id, body.status, violation_level=_violation_level)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc

    # status 변경을 side effects 실행 전에 먼저 commit — process_event/webhook
    # 내부 DB 에러가 트랜잭션을 aborted 상태로 만들어 status 변경까지 rollback하는 버그 방지
    await db.commit()

    # S-C2: 모든 스토리 업데이트에서 actor resolve — status 변경 여부와 무관하게 공통 적용
    actor_id: uuid.UUID | None = None
    actor_name: str | None = None
    actor_role: str | None = None
    actor_type: str | None = None
    try:
        actor_id = await _resolve_team_member_id(auth, repo.org_id, db)
        actor_name, actor_role, actor_type = await _resolve_actor_info(db, actor_id)
    except Exception:
        pass

    if old_status != story.status:
        org_id = repo.org_id
        # AC2/3/4/6: warn 모드 위반 — 전이는 정상 진행, 이벤트+웹훅만 발행
        if _violation.violated and _violation_level == "warn":
            _v_event = build_violation_event(
                story_id=str(id),
                story_title=story.title,
                project_id=str(story.project_id),
                org_id=str(org_id),
                old_status=old_status,
                new_status=story.status,
                reason=_violation.reason or "워크플로우 위반 감지",
                severity="warn",
            )
            try:
                publish_event(str(org_id), "workflow_violation", _v_event)
            except Exception:
                pass
            try:
                await fire_webhooks(db, org_id, "workflow_violation", _v_event)
            except Exception:
                pass
        epic_title: str | None = None
        try:
            epic_title = await _resolve_epic_title(db, story.epic_id)
        except Exception:
            pass
        event_data = {
            "story_id": str(id),
            "story_title": story.title,
            "story_priority": story.priority,
            "epic_id": str(story.epic_id) if story.epic_id else None,
            "epic_title": epic_title,
            "status": story.status,
            "new_status": story.status,
            "old_status": old_status,
            "project_id": str(story.project_id),
            "org_id": str(org_id),
            "actor_id": str(actor_id) if actor_id else None,
            "actor_name": actor_name,
            "actor_role": actor_role,
            "source_agent_id": str(actor_id) if (actor_id and actor_type == "agent") else None,
            "assignees": [str(story.assignee_id)] if story.assignee_id else [],
            "timestamp": datetime.now(timezone.utc).isoformat(),
        }
        publish_event(str(org_id), "story.status_changed", event_data)
        try:
            await fire_webhooks(db, org_id, "story.status_changed", event_data)
        except Exception:
            pass
        try:
            await process_event(db, org_id, story.project_id, EventContext(
                event_type="story.status_changed",
                trigger_type_slug="status_changed",
                actor_id=str(actor_id) if actor_id else None,
                metadata=event_data,
            ))
        except Exception:
            pass
        # E-EVENTBUS P3 S9: story_status_changed → assignee + actor에게 알림
        notify_ids: set[uuid.UUID] = set()
        if story.assignee_id:
            notify_ids.add(story.assignee_id)
        if actor_id and actor_id != story.assignee_id:
            notify_ids.add(actor_id)
        if notify_ids:
            await dispatch_notification(
                db,
                org_id=org_id,
                event_type="story_status_changed",
                target_member_ids=list(notify_ids),
                title=f"스토리 상태 변경: {story.title} → {story.status}",
                body=None,
                reference_type="story",
                reference_id=story.id,
            )
        if actor_id:
            try:
                db.add(StoryActivity(
                    story_id=id,
                    org_id=org_id,
                    project_id=story.project_id,
                    activity_type="status_changed",
                    old_value=old_status,
                    new_value=story.status,
                    created_by=(await canonicalize_member_id(actor_id, db)),  # AC3-2d(1b) canonical
                ))
                await db.flush()
            except Exception:
                pass

    # S-C2: story_updated — actor가 agent인 경우 기록 (AC2, AC6)
    if actor_id:
        from app.services.activity_log import record_activity_bg
        background_tasks.add_task(
            record_activity_bg,
            org_id=repo.org_id,
            action="story_updated",
            actor_id=actor_id,
            project_id=story.project_id,
            entity_type="story",
            entity_id=id,
            context={"old_status": old_status, "new_status": story.status, "story_title": story.title},
        )

    await _attach_assignee_ids(db, repo.org_id, [story])
    return StoryResponse.model_validate(story)


# ─── Schemas ──────────────────────────────────────────────────────────────────

class CommentResponse(BaseModel):
    id: uuid.UUID
    story_id: uuid.UUID
    org_id: uuid.UUID
    project_id: uuid.UUID
    content: str
    created_by: uuid.UUID
    created_at: datetime

    model_config = {"from_attributes": True}


class ActivityResponse(BaseModel):
    id: uuid.UUID
    story_id: uuid.UUID
    org_id: uuid.UUID
    project_id: uuid.UUID
    activity_type: str
    old_value: str | None = None
    new_value: str | None = None
    created_by: uuid.UUID
    created_at: datetime

    model_config = {"from_attributes": True}


# ─── Comments ─────────────────────────────────────────────────────────────────

@router.get("/{id}/comments", response_model=list[CommentResponse])
async def list_comments(
    id: uuid.UUID,
    limit: int = Query(default=20, le=100),
    cursor: str | None = Query(default=None),
    db: AsyncSession = Depends(get_db),
    _repo: StoryRepository = Depends(_get_repo),
) -> list[CommentResponse]:
    q = select(StoryComment).where(
        StoryComment.story_id == id,
    ).order_by(StoryComment.created_at.desc()).limit(limit)
    result = await db.execute(q)
    return [CommentResponse.model_validate(r) for r in result.scalars()]


async def _resolve_team_member_id(auth: AuthContext, org_id: uuid.UUID, db: AsyncSession) -> uuid.UUID:
    user_id = uuid.UUID(str(auth.user_id))
    result = await db.execute(
        select(TeamMember)
        .where(
            or_(TeamMember.user_id == user_id, TeamMember.id == user_id),
            TeamMember.org_id == org_id,
            TeamMember.is_active.is_(True),
        )
        .limit(1)
    )
    member = result.scalar_one_or_none()
    if member:
        return member.id
    # 0d68ad20: grant-only/admin 휴먼(team_member 행 없음)도 org 멤버면 403 금지 — SSOT canonical
    # member id(org_member.id)로 폴백(conversations/notification_preferences와 동일 패턴). 비-멤버는
    # resolve_member가 400.
    from app.services.member_resolver import resolve_member
    return (await resolve_member(auth, org_id, db)).id


@router.post("/{id}/comments", response_model=CommentResponse, status_code=201)
async def add_comment(
    id: uuid.UUID,
    content: str = Body(..., embed=True),
    db: AsyncSession = Depends(get_db),
    repo: StoryRepository = Depends(_get_repo),
    auth: AuthContext = Depends(get_current_user),
) -> CommentResponse:
    story = await repo.get(id)
    if not story:
        raise HTTPException(status_code=404, detail="Story not found")
    created_by = await _resolve_team_member_id(auth, repo.org_id, db)
    created_by = await canonicalize_member_id(created_by, db)  # AC3-2d(1b): canonical 정규화
    comment = StoryComment(
        story_id=id,
        org_id=repo.org_id,
        project_id=story.project_id,
        content=content,
        created_by=created_by,
    )
    db.add(comment)
    await db.commit()
    await db.refresh(comment)
    return CommentResponse.model_validate(comment)


# ─── Activities ───────────────────────────────────────────────────────────────

@router.get("/{id}/activities", response_model=list[ActivityResponse])
async def list_activities(
    id: uuid.UUID,
    limit: int = Query(default=20, le=100),
    db: AsyncSession = Depends(get_db),
    _repo: StoryRepository = Depends(_get_repo),
) -> list[ActivityResponse]:
    q = select(StoryActivity).where(
        StoryActivity.story_id == id,
    ).order_by(StoryActivity.created_at.desc()).limit(limit)
    result = await db.execute(q)
    return [ActivityResponse.model_validate(r) for r in result.scalars()]
