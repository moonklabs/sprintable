import uuid

from fastapi import APIRouter, Depends, HTTPException, Query
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.dependencies.auth import AuthContext, enforce_body_context, get_current_user, get_verified_org_id
from app.dependencies.database import get_db
from app.models.pm import Story, Task
from app.repositories.task import TaskRepository
from app.schemas.task import TaskCreate, TaskResponse, TaskUpdate
from app.services.evidence_service import batch_has_evidence
from app.services.notification_dispatch import dispatch_notification

router = APIRouter(prefix="/api/v2/tasks", tags=["tasks"])


def _get_repo(
    session: AsyncSession = Depends(get_db),
    org_id: uuid.UUID = Depends(get_verified_org_id),
) -> TaskRepository:
    return TaskRepository(session, org_id)


async def _attach_has_evidence(session: AsyncSession, tasks: list[Task]) -> None:
    """E-VERIFY V0-S2(story 3fbd048d) — stories.py `_attach_has_evidence`와 동형(배치 조회)."""
    if not tasks:
        return
    ids_with_evidence = await batch_has_evidence(session, [t.id for t in tasks], "task")
    for t in tasks:
        if t.id in ids_with_evidence:
            t.has_evidence = True


async def _assert_task_project_access(
    session: AsyncSession, auth: AuthContext, org_id: uuid.UUID, story_id: uuid.UUID
) -> None:
    """E-SECURITY SEC-S8(story 83ea3d6a) G: Task는 project_id가 없어 story_id→project_id로
    해소(org-scope만 있고 project 접근권 미검증이던 갭 — 같은 org 다른 project 멤버가 개별
    task id만 알면 조회/수정 가능했다). upload_story_attachment와 동형으로 has_project_access
    재사용(휴먼 team_member·에이전트 project_access grant 양쪽 처리)."""
    from app.services.project_auth import has_project_access

    project_id = (
        await session.execute(select(Story.project_id).where(Story.id == story_id))
    ).scalar_one_or_none()
    if project_id is None or not await has_project_access(session, uuid.UUID(auth.user_id), project_id, org_id):
        raise HTTPException(status_code=403, detail="No access to this project")


@router.get("", response_model=list[TaskResponse])
async def list_tasks(
    story_id: uuid.UUID | None = Query(default=None),
    assignee_id: uuid.UUID | None = Query(default=None),
    status_filter: str | None = Query(default=None, alias="status"),
    repo: TaskRepository = Depends(_get_repo),
) -> list[TaskResponse]:
    filters: dict = {}
    if story_id:
        filters["story_id"] = story_id
    if assignee_id:
        filters["assignee_id"] = assignee_id
    if status_filter:
        filters["status"] = status_filter
    tasks = await repo.list(**filters)
    await _attach_has_evidence(repo.session, tasks)
    return [TaskResponse.model_validate(t) for t in tasks]


@router.post("", response_model=TaskResponse, status_code=201)
async def create_task(
    body: TaskCreate,
    session: AsyncSession = Depends(get_db),
    auth: AuthContext = Depends(get_current_user),
    org_id: uuid.UUID = Depends(get_verified_org_id),
) -> TaskResponse:
    await enforce_body_context(
        auth_org_id=org_id,
        body_org_id=body.org_id,
        auth_project_id=auth.claims.get("app_metadata", {}).get("project_id"),
        db=session,
        user_id=uuid.UUID(auth.user_id),
    )
    # E-SECURITY SEC-S8(story 83ea3d6a) S: create_task는 GET/PATCH/DELETE와 달리
    # `_assert_task_project_access`를 호출하지 않아 org-scope만(enforce_body_context는
    # body_project_id 미전달이라 project 검증 스킵) — 같은 org 다른 project 멤버가 임의
    # story_id로 task를 생성할 수 있었다(create 경로만 남은 갭). GET/PATCH/DELETE 동형 재사용.
    await _assert_task_project_access(session, auth, org_id, body.story_id)
    repo = TaskRepository(session, org_id)
    task = await repo.create(
        story_id=body.story_id,
        title=body.title,
        assignee_id=body.assignee_id,
        status=body.status,
        story_points=body.story_points,
    )
    return TaskResponse.model_validate(task)


@router.get("/{id}", response_model=TaskResponse)
async def get_task(
    id: uuid.UUID,
    repo: TaskRepository = Depends(_get_repo),
    auth: AuthContext = Depends(get_current_user),
    org_id: uuid.UUID = Depends(get_verified_org_id),
) -> TaskResponse:
    task = await repo.get(id)
    if task is None:
        raise HTTPException(status_code=404, detail="Task not found")
    await _assert_task_project_access(repo.session, auth, org_id, task.story_id)
    await _attach_has_evidence(repo.session, [task])
    return TaskResponse.model_validate(task)


@router.patch("/{id}", response_model=TaskResponse)
async def update_task(
    id: uuid.UUID,
    body: TaskUpdate,
    repo: TaskRepository = Depends(_get_repo),
    db: AsyncSession = Depends(get_db),
    auth: AuthContext = Depends(get_current_user),
    org_id: uuid.UUID = Depends(get_verified_org_id),
) -> TaskResponse:
    task_before = await repo.get(id)
    if task_before is None:
        raise HTTPException(status_code=404, detail="Task not found")
    await _assert_task_project_access(db, auth, org_id, task_before.story_id)
    old_status = task_before.status if task_before else None
    data = body.model_dump(exclude_unset=True)
    task = await repo.update(id, **data)
    if task is None:
        raise HTTPException(status_code=404, detail="Task not found")
    # E-EVENTBUS P3 S9: task_completed → story assignee에게 알림
    if old_status != "done" and task.status == "done" and task.story_id:
        story_result = await db.execute(
            select(Story.assignee_id, Story.title, Story.org_id, Story.project_id).where(Story.id == task.story_id)
        )
        story_row = story_result.one_or_none()
        if story_row and story_row.assignee_id:
            await dispatch_notification(
                db,
                org_id=repo.org_id,
                event_type="task_completed",
                target_member_ids=[story_row.assignee_id],
                title=f"태스크 완료: {task.title}",
                body=f"스토리: {story_row.title}" if story_row.title else None,
                reference_type="task",
                reference_id=task.id,
                # S2: 멀티프로젝트 에이전트 assignee를 스토리 프로젝트로 정확 라우팅
                source_project_id=story_row.project_id,
            )
    await _attach_has_evidence(db, [task])
    return TaskResponse.model_validate(task)


@router.delete("/{id}", status_code=200)
async def delete_task(
    id: uuid.UUID,
    repo: TaskRepository = Depends(_get_repo),
    session: AsyncSession = Depends(get_db),
    org_id: uuid.UUID = Depends(get_verified_org_id),
    auth: AuthContext = Depends(get_current_user),
) -> dict:
    """E-SECURITY SEC-S1(story 70c9e92c) 확장: 까심 적대적 QA 발견 갭 봉쇄 — delete_story와
    동형으로 휴먼 전용화 + 삭제 감사(hard-delete의 에이전트 우회 벡터 차단)."""
    from app.models.deletion_audit import DeletionAuditLog
    from app.services.member_resolver import resolve_member

    resolved = await resolve_member(auth, org_id, session)
    if resolved.type != "human":
        raise HTTPException(status_code=403, detail="Task 삭제는 휴먼 멤버만 가능합니다 (에이전트 API키 차단)")
    task = await repo.get(id)
    if task is None:
        raise HTTPException(status_code=404, detail="Task not found")
    await _assert_task_project_access(session, auth, org_id, task.story_id)
    session.add(DeletionAuditLog(
        id=uuid.uuid4(), org_id=org_id, actor_id=resolved.id,
        entity_type="task", entity_id=id, entity_title=task.title,
    ))
    ok = await repo.delete(id)
    if not ok:
        raise HTTPException(status_code=404, detail="Task not found")
    return {"ok": True}
