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
from app.services.merge_verdict_gate import (
    AUTO_MERGE,
    evaluate_merge_gate,
    merge_gate_active,
    merge_gate_advisory,
)
from app.services.verdict_capture import resolve_implementation_participation
from app.services.notification_dispatch import dispatch_notification
from app.services.story_status_events import emit_story_status_changed
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
    """assignee 설정 시 implementation(default) 역할 participation 자동 upsert (멱등).

    3414b6d7: 로직은 공유 helper로 추출 — claim 경로(team_members)와 동일 attribution 진입점.
    """
    from app.services.participation_helpers import ensure_implementation_participation

    await ensure_implementation_participation(session, org_id, story_id, assignee_id)


async def _preflight_merge_gate(
    db: AsyncSession, org_id: uuid.UUID, story, new_status: str | None
) -> None:
    """H1-S5 + fc06fa8d(④): board PATCH로 →done 전이 시 merge verdict gate preflight.

    게이트 active(`merge_gate_active`·flag+allowlist)이고 **impl participation(=실작업) 보유**
    스토리의 →done 전이일 때 동작 — auto_merge가 아니면 409로 차단(status 유지).

    fc06fa8d: in-review→done뿐 아니라 **출발 status 무관 모든 →done**을 게이트(rfd/in-progress→done
    우회 박멸·라이브 coverage 0.0 실측). 단 participation 없는 trivial todo→done은 skip(마찰 0).
    게이트 목적(머지=코드작업 검증)과 정렬. 플래그 off면 즉시 반환(기존 PATCH 무변경). board PATCH엔
    PR/CI 컨텍스트 없으므로(ci_result=None) 증거 없는 done은 보류된다.
    """
    if new_status != "done" or story is None or getattr(story, "status", None) == "done":
        return
    if not merge_gate_active(org_id):
        return
    # ④: impl participation(실작업) 보유 스토리만 게이트. 없으면 trivial → skip(마찰 0).
    participation = await resolve_implementation_participation(db, org_id, story.id)
    if participation is None:
        return
    decision = await evaluate_merge_gate(
        db, org_id, story.id, pr_number=0, repo="", ci_result=None, pr_result=None
    )
    if decision.decision != AUTO_MERGE:
        await db.commit()  # gate audit 보존(get_db는 예외 시 rollback).
        # advisory(B): eval/gate row/metrics는 이미 기록됨 — 차단만 면제하고 done 통과(관측만).
        if merge_gate_advisory():
            return
        raise HTTPException(
            status_code=409,
            detail={
                "code": "MERGE_GATE_PENDING",
                "message": f"done 전이는 merge 게이트 통과 필요: {decision.reason}",
                "decision": decision.decision,
                "gate_id": str(decision.gate_id) if decision.gate_id else None,
                "requires_human": True,
            },
        )


@router.post("", response_model=StoryResponse, status_code=201)
async def create_story(
    body: StoryCreate,
    background_tasks: BackgroundTasks,
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
    # 활동로그: story 생성 이벤트 기록 (생성류 미기록 갭 — 피드 정상화)
    from app.services.activity_log import record_created_activity
    await record_created_activity(
        background_tasks, auth=auth, org_id=org_id, db=session,
        entity_type="story", entity_id=story.id, project_id=story.project_id,
        title=story.title,
    )
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
    # P0/MissingGreenlet: setattr 후 server-onupdate `updated_at` 등은 flush 시 expire 되어,
    # model_validate(sync)가 lazy-reload 를 async greenlet 밖에서 시도 → MissingGreenlet 500.
    # 단건 repo.update(flush+refresh) 패턴과 일치시켜 expired 컬럼을 async 컨텍스트서 선-reload.
    await db.flush()
    for s in updated:
        await db.refresh(s)
    # refresh 後 transient assignee_ids 세팅(refresh 는 매핑 컬럼만 reload·transient 보존).
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
    story_before = None
    if "assignee_id" in data:
        story_before = await repo.get(id)
        if story_before:
            old_assignee_id = story_before.assignee_id
    # H1-S5: PATCH /{id} 로 status=done 전이 시도도 board 경로와 동일하게 preflight 게이트(AC②).
    if data.get("status") == "done":
        gate_story = story_before or await repo.get(id)
        await _preflight_merge_gate(db, repo.org_id, gate_story, "done")
        # S-GATE-2: config 게이트 집행(done) — flag-off면 no-op(무회귀). block→409·ask→HitlRequest park.
        if gate_story is not None:
            from app.services.gate_enforce import enforce_gate
            # HIGH②: actor_type 은 인증 컨텍스트에서 신뢰 도출 — API 키(app_metadata.api_key_id)=agent,
            # 아니면 human(JWT). 보안 결정 신호라 fragile DB resolve-then-swallow(None→human) 지양.
            _g_actor_type = (
                "agent" if auth.claims.get("app_metadata", {}).get("api_key_id") else "human"
            )
            _g_actor_id: uuid.UUID | None = None
            try:  # actor_id 는 HitlRequest 귀속용(비보안)·best-effort.
                _g_actor_id = await _resolve_team_member_id(auth, repo.org_id, db)
            except Exception:
                pass
            await enforce_gate(
                db, org_id=repo.org_id, project_id=getattr(gate_story, "project_id", None),
                work_type="done", actor_type=_g_actor_type, actor_id=_g_actor_id,
                work_item_id=gate_story.id, work_item_title=getattr(gate_story, "title", None),
            )
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
                # L1 BE-3: story assignment → activity_events 1행(best-effort·commit 前·순서 불변).
                from app.services.activity_stream import extract_activities_best_effort
                await extract_activities_best_effort(db, [sa_event.id])
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

    # E-DG S5(P0-2): enforcing 라인의 merge-gate step이 이 전이를 거버닝하면, 아래 라인 엔진이
    # evaluate_merge_gate를 단일 평가한다 → 여기 _preflight_merge_gate/enforce_gate(done)는 skip해
    # 이중 evaluate/이중 pending gate를 방지(AC⑦). 비-enforcing/비활성/예외는 False=현행 게이트 유지.
    _line_owns_done_gate = False
    if story_before is not None:
        try:
            from app.services.workflow_line_engine import line_merge_gate_active
            _line_owns_done_gate = await line_merge_gate_active(
                db, org_id=repo.org_id, project_id=getattr(story_before, "project_id", None),
                entity_type="story", from_status=old_status, to_status=body.status,
            )
        except Exception:  # noqa: BLE001 — 불명 시 현행 게이트 유지(skip 안 함).
            _line_owns_done_gate = False

    if not _line_owns_done_gate:
        # H1-S5: in-review→done 직접 PATCH는 merge verdict gate preflight(플래그 active 시·AC②).
        # transition rule(check_transition)과 직교 — 전이 유효성 통과 후 증거 게이트를 얹는다(AC④).
        await _preflight_merge_gate(db, repo.org_id, story_before, body.status)
        # S-GATE-2: config 게이트 집행(done) — flag-off면 no-op(무회귀). block→409·ask→HitlRequest park.
        if body.status == "done" and story_before is not None:
            from app.services.gate_enforce import enforce_gate
            # HIGH②: actor_type 은 인증 컨텍스트에서 신뢰 도출(API 키=agent / JWT=human)·None→human 묵시 금지.
            _g_actor_type = (
                "agent" if auth.claims.get("app_metadata", {}).get("api_key_id") else "human"
            )
            _g_actor_id: uuid.UUID | None = None
            try:  # actor_id 는 HitlRequest 귀속용(비보안)·best-effort.
                _g_actor_id = await _resolve_team_member_id(auth, repo.org_id, db)
            except Exception:
                pass
            await enforce_gate(
                db, org_id=repo.org_id, project_id=getattr(story_before, "project_id", None),
                work_type="done", actor_type=_g_actor_type, actor_id=_g_actor_id,
                work_item_id=story_before.id, work_item_title=getattr(story_before, "title", None),
            )

    # E-DG S3: 워크플로우 라인 엔진(P0-1 fail-open). check_transition 후 / set_status 전. 활성 라인이
    # 없으면 plain(현 default-off=무영향). 엔진은 내부에서 모든 예외를 삼키지만, 호출부도 방어적으로
    # 한 번 더 감싼다(belt-and-suspenders — 엔진에 버그가 있어도 board 전이를 절대 막지 않음).
    if story_before is not None:
        from app.services.workflow_line_engine import evaluate_line_for_transition

        # S4: actor 전파 — 라우터가 actor_id/type 을 안 넘기면 resolver 가 항상 no_member→cold_start 로
        # 고정돼 실 actor trust 가 snapshot 에 안 담긴다(SME 적출). 인증 컨텍스트에서 신뢰 도출.
        _line_actor_type = (
            "agent" if auth.claims.get("app_metadata", {}).get("api_key_id") else "human"
        )
        _line_actor_id: uuid.UUID | None = None
        try:
            _line_actor_id = await _resolve_team_member_id(auth, repo.org_id, db)
        except Exception:  # noqa: BLE001 — actor 해소 실패도 전이 비차단(엔진은 None→cold_start 처리).
            _line_actor_id = None

        _line_decision = None
        try:
            _line_decision = await evaluate_line_for_transition(
                db, org_id=repo.org_id, project_id=getattr(story_before, "project_id", None),
                entity_type="story", entity_id=story_before.id,
                from_status=old_status, to_status=body.status,
                actor_id=_line_actor_id, actor_type=_line_actor_type,
            )
        except Exception:  # noqa: BLE001 — ⭐P0-1 절대보장: 엔진 실패가 전이를 freeze하지 않음.
            _line_decision = None
        # blocked_by_policy/gate_pending = 정상 차단 decision(예외 아님). engine_failed/advisory/plain은 진행.
        if _line_decision is not None and not _line_decision.proceeds:
            raise HTTPException(
                status_code=_line_decision.http_status or 409,
                detail=_line_decision.blocking_reason or "워크플로우 라인 정책으로 상태 전이가 차단되었습니다.",
            )

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
        # 41a6e294: status_changed side-effects(events→L1·webhook·L2·notif·activity)는 공유 helper로
        # 발화 — gate-driven done(gate_service)과 동일 경로(parity·드리프트 0).
        await emit_story_status_changed(
            db, org_id, story, old_status,
            actor_id=actor_id, actor_name=actor_name, actor_role=actor_role, actor_type=actor_type,
        )

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
