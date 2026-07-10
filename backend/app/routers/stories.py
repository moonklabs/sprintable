import uuid
from datetime import datetime, timezone

from fastapi import APIRouter, BackgroundTasks, Body, Depends, HTTPException, Query, Response
from pydantic import BaseModel, field_validator
from sqlalchemy import or_, select, text
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.config import settings
from app.dependencies.auth import AuthContext, enforce_body_context, get_current_user, get_project_scoped_org_id, get_verified_org_id
from app.dependencies.database import get_db
from app.models.deletion_audit import DeletionAuditLog
from app.models.event import Event
from app.models.pm import Epic, Story, StoryActivity, StoryComment
from app.models.team import TeamMember
from app.repositories.story import StoryRepository
from app.repositories.story_assignee import StoryAssigneeRepository
from app.routers.agent_gateway import wake_agent
from app.routers.events import publish_event
from app.services.event_seq import assign_recipient_seq
from app.services import mcp_attachment_upload
from app.services.asset_registry import DEFAULT_CONTAINER, sync_attachment_assets
from app.schemas.story import StoryAttachment, StoryCreate, StoryResponse, StoryStatusUpdate, StoryUpdate
from app.services.member_resolver import canonicalize_member_id, filter_org_member_ids, resolve_member
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
from app.services.workflow_line_status import (
    LineStatusSummary,
    WorkflowLineStatusResponse,
    build_workflow_line_status,
    build_workflow_line_status_batch,
)
from app.services.workflow_pipeline import process_event
from app.services.rule_evaluator import EventContext
from app.services.workflow_violation import (
    build_violation_event,
    build_violation_flag,
    check_transition,
)

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
        await _attach_has_evidence(repo.session, stories)
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
        await _attach_has_evidence(repo.session, stories)
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
    await _attach_has_evidence(repo.session, stories)
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


async def _attach_has_evidence(session: AsyncSession, stories: list[Story]) -> None:
    """E-VERIFY V0-S2(story 3fbd048d): evidence 있는 story에 has_evidence=True(transient attr) —
    없으면 미설정(StoryResponse 기본값 None 유지, positive 단방향·부정 신호 0).
    _attach_assignee_ids와 동형 배치 패턴."""
    if not stories:
        return
    from app.services.evidence_service import batch_has_evidence

    ids_with_evidence = await batch_has_evidence(session, [s.id for s in stories], "story")
    for s in stories:
        if s.id in ids_with_evidence:
            s.has_evidence = True


async def _assert_story_project_access(
    session: AsyncSession, auth: AuthContext, org_id: uuid.UUID, project_id: uuid.UUID
) -> None:
    """E-SECURITY SEC-S8(story 83ea3d6a) G: 개별-ID story 접근(get/update/status)이 org-scope만
    있고 project 접근권 미검증이던 갭 — 같은 org 다른 project 멤버가 story id만 알면 조회/수정
    가능했다. upload_story_attachment와 동형으로 has_project_access 재사용(휴먼 team_member·
    에이전트 project_access grant 양쪽 처리). delete_story는 SEC-S3(#2014)가 별도 처리."""
    from app.services.project_auth import has_project_access

    if not await has_project_access(session, uuid.UUID(auth.user_id), project_id, org_id):
        raise HTTPException(status_code=403, detail="No access to this project")


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


def _enforce_mcp_attachment_declared_limit(attachments: list[dict]) -> None:
    """E-MCP-OPT S6: chat(S5 #2)과 동일 갭을 story 에서 처음부터 막는다 — mcp-태그 첨부(dict shape:
    url/size 키) 부분집합만 선언한도(5개/6MiB) 재검증. FE 업로드 첨부(마커 없음)는 무관."""
    mcp_origin = [a for a in attachments if mcp_attachment_upload.is_mcp_upload_object_path(a["url"], kind="story")]
    if len(mcp_origin) > mcp_attachment_upload.MCP_MAX_ATTACHMENTS or (
        sum(a["size"] for a in mcp_origin) > mcp_attachment_upload.MCP_MAX_TOTAL_ATTACHMENT_BYTES
    ):
        raise HTTPException(
            status_code=400,
            detail=(
                f"mcp attachments exceed declared limit "
                f"(max {mcp_attachment_upload.MCP_MAX_ATTACHMENTS} files / "
                f"{mcp_attachment_upload.MCP_MAX_TOTAL_ATTACHMENT_BYTES} bytes total)"
            ),
        )


_STORY_LINK_TABLES = {"epic_id": "epics", "sprint_id": "sprints", "meeting_id": "meetings"}


async def _assert_story_link_targets_in_project(
    session: AsyncSession, project_id: uuid.UUID, body: "StoryCreate | StoryUpdate",
) -> None:
    """E-SECURITY SEC-S8(story 83ea3d6a) T(까심 전수스윕, 실HTTP 확定): epic_id/sprint_id/
    meeting_id가 body.project_id 소속인지 검증 없이 그대로 repo.create에 전달됐다 — 같은 org
    다른 project의 epic/sprint/meeting에 story를 링크할 수 있었다(G/R와 동형 project-scope
    부재). enforce_body_context는 body.project_id 자체만 caller와 대조할 뿐, 그 project_id
    "안에" 링크 대상이 실제로 속하는지는 안 본다.

    E-SECURITY SEC-S8 X(까심 전수스윕): T는 create_story만 닫았고 update_story(PATCH) 경로가
    남아있었다 — 여기서 StoryUpdate도 받아 같은 검증을 update_story에도 재사용(대상 project는
    기존 story 자신의 project_id, StoryUpdate엔 project_id 필드 자체가 없어 변경 불가)."""
    for field, table in _STORY_LINK_TABLES.items():
        target_id = getattr(body, field)
        if target_id is None:
            continue
        target_project_id = (await session.execute(
            text(f"SELECT project_id FROM {table} WHERE id = :id"),  # noqa: S608 — table은 고정 allowlist(_STORY_LINK_TABLES), 요청값 아님
            {"id": target_id},
        )).scalar_one_or_none()
        if target_project_id != project_id:
            raise HTTPException(
                status_code=404, detail=f"{field.replace('_id', '').title()} not found",
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
    await _assert_story_link_targets_in_project(session, body.project_id, body)
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
    if body.attachments:
        _enforce_mcp_attachment_declared_limit([a.model_dump() for a in body.attachments])
    # S8: 서버사이드 capacity 게이트(ee seam·SaaS only·OSS no-op) — asset commit 前 per-file+총량 enforce.
    if settings.is_ee_enabled and body.attachments:
        from ee.plan_limits import check_storage_capacity  # type: ignore[import]
        await check_storage_capacity(session, org_id, [a.model_dump() for a in body.attachments])
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
        # E-FILE S4: 보드 스토리 첨부 (FE-proxy URL+메타) 저장. S7: client asset_id strip(서버 권위·drift 방지).
        attachments=[{**a.model_dump(), "asset_id": None} for a in body.attachments],
    )
    # E-STORAGE-SSOT S2: 첨부를 asset registry로 동기화(SAVE-time·같은 트랜잭션·orphan 0).
    if body.attachments:
        _cb: uuid.UUID | None = None
        try:  # created_by enrich용 업로더 member id(비보안·best-effort).
            _cb = await _resolve_team_member_id(auth, org_id, session)
        except Exception:
            _cb = None
        url_map = await sync_attachment_assets(
            session,
            org_id=org_id,
            project_id=story.project_id,
            source_type="story",
            source_id=story.id,
            attachments=[a.model_dump() for a in body.attachments],
            created_by=_cb,
        )
        if url_map:  # S7: JSONB asset_id 역기입(denorm·catch#4)
            story.attachments = [
                {**a, "asset_id": str(url_map[a["url"]])} if a.get("url") in url_map else a
                for a in (story.attachments or [])
            ]
            await session.flush()
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


# E-DG S11 FE unblock: 보드 카드 badge 용 배치 read — per-story fetch N+1 회피(gates 배치 패턴
# 미러·1 fetch+map). ⚠️ /{id} 보다 **먼저** 선언(specific-before-parameterized). active-only 요약
# (mode/status + engine_degraded/grandfathered/handoff_stuck + delivery_status)·org-scoped·N+1 0.
@router.get("/workflow-line/status", response_model=list[LineStatusSummary])
async def get_workflow_line_status_batch(
    ids: str = Query(..., description="comma-separated story ids"),
    repo: StoryRepository = Depends(_get_repo),
) -> list[LineStatusSummary]:
    try:
        story_ids = [uuid.UUID(x) for x in ids.split(",") if x.strip()]
    except ValueError:
        raise HTTPException(status_code=422, detail="invalid story id in ids")
    if not story_ids:
        return []
    if len(story_ids) > 200:  # 보드 페이지 단위 방어(과대 IN 금지)
        raise HTTPException(status_code=422, detail="too many ids (max 200)")
    return await build_workflow_line_status_batch(repo.session, repo.org_id, story_ids)


# E-DG S15(P1-6): line metric 집계(org-scoped·read-only·default-off org=no-op). ⚠️ /{id} 보다 먼저.
@router.get("/workflow-line/metrics")
async def get_workflow_line_metrics(
    window_days: int = Query(default=14, ge=1, le=90),
    repo: StoryRepository = Depends(_get_repo),
) -> dict:
    from app.services.workflow_line_metrics import compute_line_metrics
    return await compute_line_metrics(repo.session, repo.org_id, window_days=window_days)


@router.get("/{id}", response_model=StoryResponse)
async def get_story(
    id: uuid.UUID,
    repo: StoryRepository = Depends(_get_repo),
    auth: AuthContext = Depends(get_current_user),
) -> StoryResponse:
    story = await repo.get(id)
    if story is None:
        raise HTTPException(status_code=404, detail="Story not found")
    await _assert_story_project_access(repo.session, auth, repo.org_id, story.project_id)
    await _attach_assignee_ids(repo.session, repo.org_id, [story])
    await _attach_has_evidence(repo.session, [story])
    return StoryResponse.model_validate(story)


class UploadStoryAttachmentRequest(BaseModel):
    """E-MCP-OPT S6: MCP(비-브라우저)용 JSON/base64 첨부 업로드 요청(chat과 동형)."""

    content_base64: str
    name: str
    content_type: str

    @field_validator("content_base64", "name", "content_type")
    @classmethod
    def _non_empty(cls, v: str) -> str:
        v = v.strip()
        if not v:
            raise ValueError("must not be empty")
        return v

    @field_validator("content_type")
    @classmethod
    def _content_type_sane(cls, v: str) -> str:
        if len(v) > mcp_attachment_upload.MAX_ATTACHMENT_NAME_LEN or any(ord(ch) < 32 for ch in v):
            raise ValueError("invalid content_type")
        return v


@router.post(
    "/{id}/attachments", status_code=201, response_model=StoryAttachment, response_model_exclude_none=True,
)
async def upload_story_attachment(
    id: uuid.UUID,
    body: UploadStoryAttachmentRequest,
    session: AsyncSession = Depends(get_db),
    auth: AuthContext = Depends(get_current_user),
    org_id: uuid.UUID = Depends(get_verified_org_id),
) -> StoryAttachment:
    """E-MCP-OPT S6: 비-브라우저 클라이언트(MCP)용 JSON/base64 스토리 첨부 업로드(chat과 동형).

    인가 = `has_project_access`(story.project_id) — `register_doc_asset`/`enforce_body_context`(story
    create)와 동일 SSOT. object_path 는 FE 업로드 라우트(`apps/web/.../stories/[id]/attachments/
    route.ts`)와 동일 접두(org/<org>/project/<project>/story/<id>/...)+`mcp/` 마커(S5 패턴 재사용) —
    create/update_story 가 그 부분집합만 선언한도(5개/6MiB)를 재검증한다.
    """
    story = (await session.execute(
        select(Story).where(Story.id == id, Story.org_id == org_id)
    )).scalar_one_or_none()
    if story is None:
        raise HTTPException(status_code=404, detail="Story not found")

    from app.services.project_auth import has_project_access
    if not await has_project_access(session, uuid.UUID(auth.user_id), story.project_id, org_id):
        raise HTTPException(status_code=403, detail="No access to this project")

    data = mcp_attachment_upload.decode_json_attachment(body.content_base64)
    safe_name = mcp_attachment_upload.safe_attachment_filename(body.name)
    object_path = mcp_attachment_upload.build_mcp_object_path(
        org_id=org_id, project_id=story.project_id, kind="story", resource_id=id, safe_name=safe_name,
    )

    from app.services.storage import get_storage_provider
    uploaded = await get_storage_provider().put_object(
        DEFAULT_CONTAINER, object_path, data, content_type=body.content_type,
    )
    if not uploaded:
        raise HTTPException(status_code=502, detail="upload failed")

    return StoryAttachment(url=object_path, name=body.name, content_type=body.content_type, size=len(data))


# E-DG S10(P1-4 observability): workflow-line 상태 read API — "왜 막혔나·어디로 relay 됐나"를
# 채팅 없이 board/API 서 안다(FE S11 데이터 소스). 기존 story read auth(_get_repo·org-scoped)
# 재사용·없는 story 404·active 없으면 terminal 5개 history·engine_degraded/grandfathered 명시.
@router.get("/{id}/workflow-line/status", response_model=WorkflowLineStatusResponse)
async def get_workflow_line_status(
    id: uuid.UUID,
    repo: StoryRepository = Depends(_get_repo),
) -> WorkflowLineStatusResponse:
    story = await repo.get(id)  # org/project-scoped read auth(AC⑤)·scope 밖/없으면 None→404
    if story is None:
        raise HTTPException(status_code=404, detail="Story not found")
    return await build_workflow_line_status(repo.session, repo.org_id, id)


class FallbackNotifyRequest(BaseModel):
    step_run_id: uuid.UUID


# E-DG S12 Gap2: stuck handoff fallback human notification. 기존 _get_repo org-scoped auth·없는
# story 404·dispatch_notification 재사용·idempotent(run당 1회·already_notified)·status rollback 0.
@router.post("/{id}/workflow-line/fallback-notify")
async def workflow_line_fallback_notify(
    id: uuid.UUID,
    body: FallbackNotifyRequest,
    repo: StoryRepository = Depends(_get_repo),
) -> dict:
    story = await repo.get(id)
    if story is None:
        raise HTTPException(status_code=404, detail="Story not found")
    from app.services.workflow_fallback_notify import fallback_notify
    result = await fallback_notify(repo.session, repo.org_id, id, body.step_run_id)
    if result.get("status") == "not_found":
        raise HTTPException(status_code=404, detail="step_run not found for this story")
    return result


class WithdrawRequest(BaseModel):
    step_run_id: uuid.UUID
    reason: str | None = None


# E-DG S17: author/owner pending gate run 철회(withdraw). requester/owner/admin 만·idempotent·
# Gate enum 미확장(run/approval status 로만)·entity 미전이.
@router.post("/{id}/workflow-line/withdraw")
async def workflow_line_withdraw(
    id: uuid.UUID,
    body: WithdrawRequest,
    repo: StoryRepository = Depends(_get_repo),
    db: AsyncSession = Depends(get_db),
    auth: AuthContext = Depends(get_current_user),
) -> dict:
    story = await repo.get(id)
    if story is None:
        raise HTTPException(status_code=404, detail="Story not found")
    actor_id = await _resolve_team_member_id(auth, repo.org_id, db)
    from app.services.workflow_recall import withdraw_pending_run
    result = await withdraw_pending_run(repo.session, repo.org_id, id, body.step_run_id, actor_id, body.reason)
    status = result.get("status")
    if status == "not_found":
        raise HTTPException(status_code=404, detail="step_run not found for this story")
    if status == "forbidden":
        raise HTTPException(status_code=403, detail="only requester/owner/admin can withdraw")
    if status == "not_active":
        raise HTTPException(status_code=409, detail=f"run not in active pending state ({result.get('run_status')})")
    return result


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
    auth: AuthContext = Depends(get_current_user),
) -> list[StoryResponse]:
    # 정공법 A(c1cd484b): /bulk 도 /status 와 동일 — status 변경을 항상 allow 하되 비순차 전진 점프는
    # violation flag(응답)+workflow_violation 이벤트로 가시화(차단 X). dnd 양경로(드래그·메뉴) 공통 SSOT.
    # violation 웹훅 수신자 필터용 actor 1회 해소(org-wide fan-out 박멸·/status 와 동형).
    actor_id: uuid.UUID | None = None
    try:
        actor_id = await _resolve_team_member_id(auth, repo.org_id, db)
    except Exception:  # noqa: BLE001 — actor 해소 실패도 bulk 비차단.
        actor_id = None

    from app.services.project_auth import has_project_access

    updated: list[Story] = []
    old_status_by_id: dict[uuid.UUID, str] = {}
    for item in payload.items:
        # E-SECURITY SEC-S8(story 83ea3d6a) W(까심 QA, CRITICAL·실HTTP 확定): 이 raw 쿼리가
        # org_id 필터 자체가 없어(정상 repo.get()은 self._org_filter() 명시·RLS도 0002서 off)
        # 타 org의 story UUID만 알면 status/sprint_id/assignee_id/priority/position 전부
        # 변조 가능했다(cross-org IDOR). repo.org_id로 스코프.
        q = await db.execute(
            select(Story).where(Story.id == item.id, Story.org_id == repo.org_id)
        )
        story = q.scalar_one_or_none()
        if not story:
            continue
        # E-SECURITY SEC-S8(story 83ea3d6a) W2(까심 QA): org_id 필터로 cross-org는 닫혔으나
        # same-org 다른 project의 story는 여전히 변조 가능했다(project-scope 부재, G/T와 동형).
        # 개별-ID PATCH(_assert_story_project_access)와 동일 기준(has_project_access) 재사용 —
        # 미접근 item은 not-found와 동형으로 조용히 스킵(존재 비노출·나머지 정당 item은 진행).
        if not await has_project_access(db, uuid.UUID(auth.user_id), story.project_id, repo.org_id):
            continue
        update_data = item.model_dump(exclude={"id"}, exclude_none=True)
        # status 변경이면 전이 前 old_status 포착(violation 판정용·setattr 前).
        if "status" in update_data and update_data["status"] != story.status:
            old_status_by_id[story.id] = story.status
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
    await _attach_has_evidence(db, updated)

    # 응답(violation flag 포함) + violation 이벤트 페이로드를 commit 前에 빌드(commit 시 attr expire→
    # MissingGreenlet 방지·기존 results 빌드와 동일 시점). 이벤트 발화는 commit 後(/status 와 동일 순서).
    results: list[StoryResponse] = []
    violation_dispatch: list[tuple[dict, set[uuid.UUID]]] = []
    for s in updated:
        r = StoryResponse.model_validate(s)
        old = old_status_by_id.get(s.id)
        flag = build_violation_flag(old, s.status) if old is not None else None
        r.violation = flag
        results.append(r)
        if flag is not None:
            _ev = build_violation_event(
                story_id=str(s.id), story_title=s.title, project_id=str(s.project_id),
                org_id=str(repo.org_id), old_status=old, new_status=s.status,
                reason=f"'{old}' → '{s.status}' 전이: {flag['skipped']}단계 건너뜀", severity="warn",
            )
            _notify = {m for m in (actor_id, s.assignee_id) if m is not None}
            violation_dispatch.append((_ev, _notify))

    await db.commit()

    # workflow_violation 발화(commit 後·기존 이벤트 타입이라 additive·기존 컨슈머 무영향). 실패는 비차단.
    for _ev, _notify in violation_dispatch:
        try:
            publish_event(str(repo.org_id), "workflow_violation", _ev)
        except Exception:  # noqa: BLE001
            pass
        try:
            await fire_webhooks(
                db, repo.org_id, "workflow_violation", _ev, recipient_member_ids=_notify,
            )
        except Exception:  # noqa: BLE001
            pass
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
    _story_for_access = await repo.get(id)
    if _story_for_access is None:
        raise HTTPException(status_code=404, detail="Story not found")
    await _assert_story_project_access(db, auth, repo.org_id, _story_for_access.project_id)
    await _assert_story_link_targets_in_project(db, _story_for_access.project_id, body)

    data = body.model_dump(exclude_unset=True)
    # S7: client 제공 asset_id strip(서버 권위·drift 방지·까심)·아래 sync url_map 으로만 역기입.
    if data.get("attachments"):
        data["attachments"] = [{**a, "asset_id": None} for a in data["attachments"]]
        _enforce_mcp_attachment_declared_limit(data["attachments"])
        # S8: 서버사이드 capacity 게이트(ee seam·SaaS only·OSS no-op) — 첨부 교체 commit 前 enforce.
        if settings.is_ee_enabled:
            from ee.plan_limits import check_storage_capacity  # type: ignore[import]
            await check_storage_capacity(db, repo.org_id, data["attachments"])
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

    # E-STORAGE-SSOT S2: 첨부 교체(attachments 제공) 시 asset registry 재동기화(reconcile·SSOT 정확).
    if "attachments" in data:
        _cb: uuid.UUID | None = None
        try:
            _cb = await _resolve_team_member_id(auth, repo.org_id, db)
        except Exception:
            _cb = None
        url_map = await sync_attachment_assets(
            db,
            org_id=repo.org_id,
            project_id=story.project_id,
            source_type="story",
            source_id=story.id,
            attachments=data.get("attachments") or [],
            created_by=_cb,
        )
        if url_map:  # S7: JSONB asset_id 역기입(denorm·catch#4·attachments 교체 반영)
            story.attachments = [
                {**a, "asset_id": str(url_map[a["url"]])} if a.get("url") in url_map else a
                for a in (story.attachments or [])
            ]
            await db.flush()

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
        # AC1(c60dd33c 미러): assignee_changed webhook은 관련자만 — 담당자(신/구)+행위자. member-bound
        # webhook이 무관 에이전트에 fan-out되던 갭 차단. member_id=null 브로드캐스트는 보존(preserve_broadcast).
        _assignee_notify_ids = {
            m for m in (story.assignee_id, old_assignee_id, actor_id) if m is not None
        }
        # publish_event는 org-level 브라우저 UI 활동피드(_subscribers·per-agent 미전파)라 org-wide 의도 유지(AC2).
        publish_event(str(org_id), "story.assignee_changed", event_data)
        try:
            await fire_webhooks(
                db, org_id, "story.assignee_changed", event_data,
                recipient_member_ids=_assignee_notify_ids,
            )
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
    await _attach_has_evidence(db, [story])
    return StoryResponse.model_validate(story)


@router.delete("/{id}", status_code=200)
async def delete_story(
    id: uuid.UUID,
    repo: StoryRepository = Depends(_get_repo),
    session: AsyncSession = Depends(get_db),
    org_id: uuid.UUID = Depends(get_verified_org_id),
    auth: AuthContext = Depends(get_current_user),
) -> dict:
    """E-SECURITY SEC-S1(story 70c9e92c): hard-delete는 휴먼 전용 — 에이전트 API키(사람 승인
    없는 즉시 물리삭제)는 403. 삭제 전 actor/target를 감사 기록(story row 자체는 삭제되므로
    미리 캡처 — DeletionAuditLog는 story FK 없이 독립 테이블이라 삭제 후에도 생존)."""
    from app.repositories.dependency import DependencyRepository
    from app.repositories.label import ItemLabelRepository
    from app.repositories.participation import ParticipationRepository

    resolved = await resolve_member(auth, org_id, session)
    if resolved.type != "human":
        raise HTTPException(status_code=403, detail="Story 삭제는 휴먼 멤버만 가능합니다 (에이전트 API키 차단)")

    story = await repo.get(id)
    if story is None:
        raise HTTPException(status_code=404, detail="Story not found")

    # E-SECURITY SEC-S3(story 90cd7e57): DELETE가 org-only 스코핑이라 프로젝트 미멤버(같은 org의
    # 다른 프로젝트 소속)도 스토리 삭제 가능했음 — upload_story_attachment와 동일 SSOT
    # (has_project_access)로 project 인가 적용. SEC-S1의 human-gate(에이전트 차단)와는 직교 축
    # (actor 타입 vs project 소속) — human이어도 무관한 project면 여전히 403.
    from app.services.project_auth import has_project_access
    if not await has_project_access(session, uuid.UUID(auth.user_id), story.project_id, org_id):
        raise HTTPException(status_code=403, detail="No access to this project")

    session.add(DeletionAuditLog(
        id=uuid.uuid4(),
        org_id=org_id,
        actor_id=resolved.id,
        entity_type="story",
        entity_id=id,
        entity_title=story.title,
    ))

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
    if story_before is not None:
        await _assert_story_project_access(db, auth, repo.org_id, story_before.project_id)
    old_status = story_before.status if story_before else None

    # 정공법 A(c1cd484b·선생님 지시): 전이 순서 **하드블록 폐지** — 비순차 점프도 항상 allow,
    # violation 은 warn 기록(이벤트)+응답 flag 로만 가시화. projects.violation_level=="block" 잔존이
    # `/status`=block vs `/bulk`=pass SSOT 역설("정신병" 일부 경로 생존)을 만들던 걸 제거(까심 ②).
    # → 전이-순서는 항상 warn. E-DG merge-gate/워크플로우 라인 엔진(아래)은 직교라 그대로 유지.
    _violation = check_transition(old_status, body.status, "warn")

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
            # ⭐S5: raise 前 commit — engine 이 만든 H1 Gate·evidence write-back·step_run(h1_gate_id)
            # audit 를 보존한다. get_db 는 예외 시 rollback 하므로, commit 없이 raise 하면 flush 된
            # gate/step_run 이 사라진다(_preflight_merge_gate 가 raise 前 commit 하는 것과 동형·SME 적출).
            await db.commit()
            raise HTTPException(
                status_code=_line_decision.http_status or 409,
                detail=_line_decision.blocking_reason or "워크플로우 라인 정책으로 상태 전이가 차단되었습니다.",
            )

    try:
        # AC2: violation_level 전달 → warn 모드이면 set_status hard block 우회
        story = await repo.set_status(id, body.status, violation_level="warn")
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc

    # E-DG S7: agent-handoff relay — status 적용 후 같은 트랜잭션에서 dispatch(commit=False)·step_run
    # delivery 기록(원자). wake/CC delivery 는 commit(아래) 후 recipient_seq 확정 후 발화(P1-2 불변식).
    # relay 실패도 전이 비차단(fail-open).
    _relay_wake = None
    _relay_sr_id = (
        _line_decision.relay_step_run_id
        if (story_before is not None and _line_decision is not None) else None
    )
    if _relay_sr_id is not None:
        from app.services.workflow_line_resolution import relay_agent_handoff
        try:
            _relay_wake = await relay_agent_handoff(db, _relay_sr_id, sender_id=_line_actor_id)
        except Exception:  # noqa: BLE001 — relay 실패도 전이 비차단(fail-open).
            _relay_wake = None

    # status 변경을 side effects 실행 전에 먼저 commit — process_event/webhook
    # 내부 DB 에러가 트랜잭션을 aborted 상태로 만들어 status 변경까지 rollback하는 버그 방지
    await db.commit()

    # E-DG S7: relay wake — commit(recipient_seq 확정) 후 agent wake + CC delivery 발화(이중전달 방지).
    if _relay_wake is not None:
        _aw = _relay_wake.get("agent_wake")
        if _aw:
            wake_agent(_aw["recipient_id"], _aw["recipient_seq"])
        _dl = _relay_wake.get("delivery")
        if _dl:
            from app.services.conversation_webhook import deliver_injected_event_webhook
            background_tasks.add_task(
                deliver_injected_event_webhook,
                org_id=_dl["org_id"], recipient_id=_dl["recipient_id"], content=_dl["content"],
                event_type=_dl["event_type"], source_entity_type=_dl["source_entity_type"],
                source_entity_id=_dl["source_entity_id"],
            )

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
        # AC2/3/4/6: 위반 — 전이는 항상 정상 진행(하드블록 폐지), 이벤트+웹훅만 발행(가시화).
        if _violation.violated:
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
            # AC4(동일 패턴): workflow_violation webhook도 관련자(행위자+담당자)만 — 동일 org-wide fan-out
            # 박멸. publish_event(UI 활동피드)는 org-wide 유지.
            _violation_notify_ids = {
                m for m in (actor_id, story.assignee_id) if m is not None
            }
            try:
                publish_event(str(org_id), "workflow_violation", _v_event)
            except Exception:
                pass
            try:
                await fire_webhooks(
                    db, org_id, "workflow_violation", _v_event,
                    recipient_member_ids=_violation_notify_ids,
                )
            except Exception:
                pass
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
    await _attach_has_evidence(db, [story])
    resp = StoryResponse.model_validate(story)
    # 정공법 A: 비순차 점프면 응답에 violation flag(차단 없이 가시화·/bulk 와 동일 SSOT).
    resp.violation = build_violation_flag(old_status, story.status)
    return resp


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
    content: str = Body(...),
    mentioned_ids: list[uuid.UUID] = Body(default=[]),
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

    # E-CANVAS C0-S1(story cfa61434) §F4: comment.created 이벤트 전파 — 기반층 검증 케이스
    # (blueprint 제1원칙 "이벤트 없는 기능 금지"). 수신자 = story assignee(멀티) + mentioned_ids
    # (cross-org 필터, conversations.py와 동형 컨벤션 — content regex 파싱은 이 코드베이스가
    # 이미 폐기함[channel_router.py]) − 작성자 본인(자기알림 제외). dispatch_notification이
    # 휴먼(in-app+webhook)/에이전트(Event INSERT→SSE·webhook) 양쪽 다 처리하는 기존 SSOT.
    sa_repo = StoryAssigneeRepository(db, repo.org_id)
    assignee_ids = set(await sa_repo.list_member_ids(story.id))
    if not assignee_ids and story.assignee_id:
        assignee_ids = {story.assignee_id}
    valid_mentioned_ids = await filter_org_member_ids(set(mentioned_ids), repo.org_id, db)
    target_member_ids = list((assignee_ids | valid_mentioned_ids) - {created_by})
    if target_member_ids:
        await dispatch_notification(
            db,
            org_id=repo.org_id,
            event_type="comment.created",
            target_member_ids=target_member_ids,
            title=f"새 코멘트: {story.title}",
            body=content[:200],
            reference_type="story",
            reference_id=story.id,
            source_project_id=story.project_id,
        )

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
