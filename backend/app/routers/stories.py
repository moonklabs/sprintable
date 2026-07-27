import json
import logging
import time
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
from app.models.pm import Goal, Story, StoryActivity, StoryComment
from app.models.team import TeamMember
from app.repositories.story import StoryRepository
from app.repositories.story_assignee import StoryAssigneeRepository
from app.routers.agent_gateway import wake_agent
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
from app.services.story_assignee_events import emit_story_assignee_changed
from app.services.story_status_events import emit_story_status_changed
from app.services.webhook_dispatch import fire_webhooks
from app.services.workflow_line_status import (
    LineStatusSummary,
    WorkflowLineStatusResponse,
    build_workflow_line_status,
    build_workflow_line_status_batch,
)
from app.services.workflow_violation import (
    build_violation_event,
    build_violation_flag,
    check_transition,
)

router = APIRouter(prefix="/api/v2/stories", tags=["stories", "Work"])

logger = logging.getLogger(__name__)


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
    result = await db.execute(select(Goal).where(Goal.id == epic_id).limit(1))
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
    ids: str | None = Query(default=None, description="comma-separated story ids — 배치 앵커 조회(정확한 집합, ORDER BY/limit 무관)"),
    story_number: int | None = Query(default=None, description="프로젝트 내 사람-읽는 #N(project_id와 함께 사용 — N은 project 내에서만 유일)"),
    q: str | None = Query(default=None, description="title 부분검색(ILIKE) — 기존 필터와 AND 결합"),
    limit: int = Query(default=1000, ge=1, le=2000),
    cursor: str | None = Query(default=None, description="Cursor: ISO 8601 created_at, fetch before this time"),
    response: Response = None,  # type: ignore[assignment]
    repo: StoryRepository = Depends(_get_repo),
    auth: AuthContext = Depends(get_current_user),
) -> list[StoryResponse]:
    from datetime import datetime

    if ids is not None:
        # story ca37b2b0 ②: 갤러리 등 정확한 story 집합이 필요한 소비자용 — base.list()의
        # ORDER BY 부재(별건 d8787fa6)와 무관하게 요청한 id를 전부(또는 접근권 있는 만큼) 반환.
        try:
            story_ids = [uuid.UUID(x) for x in ids.split(",") if x.strip()]
        except ValueError:
            raise HTTPException(status_code=422, detail="invalid story id in ids")
        if not story_ids:
            return []
        if len(story_ids) > 200:  # 워크플로우-라인 배치와 동형 방어(과대 IN 금지).
            raise HTTPException(status_code=422, detail="too many ids (max 200)")
        stories = await repo.list_by_ids(story_ids)
        # 인가 스코프: org 소속이어도 caller가 접근 못 하는 project의 story는 조용히 필터링
        # (타 project id가 섞여 들어와도 유출 0 — has_project_access와 동일 SSOT 배치 버전 재사용).
        from app.services.project_auth import accessible_project_ids_in_org
        accessible = await accessible_project_ids_in_org(repo.session, uuid.UUID(auth.user_id), repo.org_id)
        stories = [s for s in stories if s.project_id in accessible]
        await _attach_assignee_ids(repo.session, repo.org_id, stories)
        await _attach_has_evidence(repo.session, stories)
        return [StoryResponse.model_validate(s) for s in stories]

    # story #2188 ④-b(2026-07-25, 오르테가군 판정 — 의도된 제약, 코드 고칠 이유 없음):
    # `no_sprint=True`를 `project_id` 없이 보내면 이 분기 자체가 안 걸려 제네릭 분기(:148
    # 이하)로 떨어지고, 거기엔 sprint_id IS NULL을 적용하는 로직이 없어 no_sprint가 통째로
    # 무시된다 — 결함은 결함이나 도달 경로가 구조적으로 없다: FE `ApiStoryRepository.backlog()`
    # 는 `projectId: string`(non-optional) 타입이라 컴파일 타임에 이 조합을 못 만들고, MCP
    # `sprintable_list_backlog` 툴도 `client.require_project_id()`로 런타임 강제한다(양쪽 다
    # test_2188_no_sprint_alone_contract_pin.py로 고정). 코드를 고치면 "밟히지도 않는 자리"에
    # 검증 비용만 느는지라 주석+pinning 테스트로 계약을 선언하고 닫는다.
    if no_sprint and project_id:
        # story #2188 형제(#2489와 동형): 필터 전부 넘긴다.
        # ⚠️ cursor는 안 넘긴다 — #2190은 이 분기와 무관함이 밝혀졌다(list_backlog
        # docstring 참조: /api/stories/backlog 프록시가 status를 강제 부착해 실제로는
        # board 분기로 감).
        stories = await repo.list_backlog(
            project_id, limit=limit, epic_id=epic_id, assignee_id=assignee_id,
            status=status_filter, story_number=story_number, q=q,
        )
        await _attach_assignee_ids(repo.session, repo.org_id, stories)
        await _attach_has_evidence(repo.session, stories)
        return [StoryResponse.model_validate(s) for s in stories]

    # CB-S4: status + project_id 조합 시 board 쿼리 (order_by + cursor + done 7일 제한)
    # story #2188: sprint_id/assignee_id만 넘기고 epic_id/story_number/q는 조용히 빠뜨리던
    # 자리 — 이 분기로 빠지는 조합에서도 제네릭 블록(:148 이하)과 동일하게 전 필터를 넘긴다.
    if status_filter and project_id:
        cursor_dt = datetime.fromisoformat(cursor) if cursor else None
        stories, total = await repo.list_board(
            project_id=project_id,
            status=status_filter,
            limit=min(limit, 20) if status_filter == "done" else limit,
            cursor=cursor_dt,
            sprint_id=sprint_id,
            assignee_id=assignee_id,
            epic_id=epic_id,
            story_number=story_number,
            q_text=q,
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
    if story_number is not None:
        filters["story_number"] = story_number
    # story #2189: 이 분기도 board 분기(:131)와 동형으로 cursor를 파싱해 넘긴다 — 안 넘기면
    # FE(buildCursorPageMeta)가 계산한 nextCursor가 다음 요청에서 조용히 무시돼 같은 페이지가
    # 반복된다(sprints/standup "더 보기" 중복 누적의 원인).
    cursor_dt = datetime.fromisoformat(cursor) if cursor else None
    stories = await repo.list(limit=limit, q=q, cursor=cursor_dt, **filters)
    await _attach_assignee_ids(repo.session, repo.org_id, stories)
    await _attach_has_evidence(repo.session, stories)
    return [StoryResponse.model_validate(s) for s in stories]


async def _attach_agent_delegate_ids(session: AsyncSession, stories: list[Story]) -> None:
    """P0-03(doc trust-pipeline-be-design §5): 각 Story에 agent_delegate_ids(transient attr)를
    채운다 — assignee_ids(이미 세팅돼 있다고 가정)를 Member.type=="agent"로 필터한 파생 뷰(신규
    저장 0). N+1 회피 위해 배치. `_attach_assignee_ids` 뒤에, 또는 create_story처럼 assignee_ids를
    인라인으로 세팅한 직후 호출한다."""
    if not stories:
        return
    from app.services.member_resolver import lookup_members_by_ids

    all_ids: set[uuid.UUID] = set()
    for s in stories:
        all_ids.update(s.assignee_ids)
    resolved = await lookup_members_by_ids(all_ids, session)
    for s in stories:
        s.agent_delegate_ids = [
            mid for mid in s.assignee_ids if resolved.get(mid) and resolved[mid].type == "agent"
        ]


async def _attach_assignee_ids(
    session: AsyncSession, org_id: uuid.UUID, stories: list[Story]
) -> None:
    """E-BOARD S5: 각 Story에 assignee_ids(transient attr)를 채워 StoryResponse.from_attributes가
    읽도록 한다. join 비어있으면 단일 assignee_id로 폴백(레거시 행 back-compat). N+1 회피 위해 배치.

    P0-03(doc trust-pipeline-be-design §5): 같은 배치에서 agent_delegate_ids도 채운다."""
    if not stories:
        return
    sa_repo = StoryAssigneeRepository(session, org_id)
    id_map = await sa_repo.map_member_ids([s.id for s in stories])
    for s in stories:
        ids = id_map.get(s.id)
        if not ids:
            ids = [s.assignee_id] if s.assignee_id else []
        s.assignee_ids = ids  # 매핑되지 않은 transient 속성 — from_attributes 전용
    await _attach_agent_delegate_ids(session, stories)


async def _attach_has_evidence(session: AsyncSession, stories: list[Story]) -> None:
    """E-VERIFY V0-S2(story 3fbd048d) + Claimed vs Verified(doc
    claimed-vs-verified-spec-handoff §3): evidence 있는 story에 has_evidence/self_reported=True
    (transient attr) — 없으면 미설정(StoryResponse 기본값 None 유지, positive 단방향·부정
    신호 0). gate_approval evidence(휴먼 책임자 gate 승인, 스푸핑 불가)가 있으면 추가로
    human_verified=True+human_verified_by(who)·human_verified_at(when) 세팅.
    _attach_assignee_ids와 동형 배치 패턴."""
    if not stories:
        return
    from app.services.evidence_service import batch_has_evidence, batch_human_verified

    story_ids = [s.id for s in stories]
    ids_with_evidence = await batch_has_evidence(session, story_ids, "story")
    verified_map = await batch_human_verified(session, story_ids, "story")
    for s in stories:
        if s.id in ids_with_evidence:
            s.has_evidence = True
            s.self_reported = True
        verified = verified_map.get(s.id)
        if verified is not None:
            s.human_verified = True
            s.human_verified_by = verified.created_by
            s.human_verified_at = verified.created_at


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


_STORY_LINK_TABLES = {"epic_id": "goals", "sprint_id": "sprints", "meeting_id": "meetings"}


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


async def _assert_human_owner(
    session: AsyncSession, org_id: uuid.UUID, member_id: uuid.UUID | None,
) -> None:
    """P0-03(doc trust-pipeline-be-design §5) write-time 강제: human_owner_member_id로 지정된
    member가 human이 아니면(에이전트·미해소) 400. resolve_member_identity 재사용(evidence_service의
    gate_approval choke-point와 동일 SOUL-LOCK 규율 — body-claimed 신뢰 대신 서버 해소값만 신뢰)."""
    if member_id is None:
        return
    from app.services.member_resolver import resolve_member_identity

    resolved = await resolve_member_identity(member_id, org_id, session)
    if resolved is None or resolved.type != "human":
        raise HTTPException(
            status_code=400,
            detail="human_owner_member_id는 human member만 지정할 수 있습니다.",
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
    await _assert_human_owner(session, org_id, body.human_owner_member_id)
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
        # story #2055 AC1: 이미지 첨부 픽셀 크기를 서버가 측정해 채운다 — client 제공 width/height는
        # asset_id와 동일하게 위조 가능하므로 신뢰하지 않고 항상 서버 측정값으로 덮어쓴다(server
        # authority). best-effort(측정 실패해도 저장 자체는 막지 않는다).
        from app.services.image_dimensions import measure_image_dimensions
        for a in body.attachments:
            a.width, a.height = await measure_image_dimensions(a.content_type, a.url) or (None, None)
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
        human_owner_member_id=body.human_owner_member_id,
        declared_scope_paths=body.declared_scope_paths,
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
    # P0-03(doc trust-pipeline-be-design §5): agent_delegate_ids(transient) — update_story는
    # _attach_assignee_ids 경유로 이미 채워지나, create_story는 인라인 경로라 별도 호출 필요.
    await _attach_agent_delegate_ids(session, [story])
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

    # story #2055 AC1: 바이트가 이미 메모리에 있으므로 재다운로드 없이 직접 측정.
    from app.services.image_dimensions import measure_image_dimensions_from_bytes
    dims = measure_image_dimensions_from_bytes(body.content_type, data)
    width, height = dims if dims is not None else (None, None)

    return StoryAttachment(
        url=object_path, name=body.name, content_type=body.content_type, size=len(data),
        width=width, height=height,
    )


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
    background_tasks: BackgroundTasks,
    db: AsyncSession = Depends(get_db),
    repo: StoryRepository = Depends(_get_repo),
    auth: AuthContext = Depends(get_current_user),
) -> list[StoryResponse]:
    # #2176 AC1: 요청 수신 시각 — emit_story_status_changed에 그대로 넘겨 "요청 수신→emit 착수"
    # 구간을 잰다(칸반 드래그/컬럼메뉴가 이 라우트를 타므로 미르코 실측 4,754ms의 서버측 성분을
    # 여기서 갈라낸다). 순수 time.time() 캡처라 무부하.
    _request_received_at = time.time()
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
    # story #2172 AC1: assignee_id도 status와 동형으로 전이 前 old값 포착(setattr 前). None은
    # "미배정→배정"의 유효한 old값이라 .get() 대신 멤버십(`in`)으로 "실제 변경 있었음"을 판정한다
    # (status_by_id는 status가 None일 수 없어 .get()만으로 충분했던 것과 다른 지점).
    old_assignee_by_id: dict[uuid.UUID, uuid.UUID | None] = {}
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
        if "assignee_id" in update_data and update_data["assignee_id"] != story.assignee_id:
            old_assignee_by_id[story.id] = story.assignee_id
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

    # workflow_violation 발화(commit 後). story #2132(2026-07-23): publish_event() 호출 제거 —
    # FE 소비처 0(설계 doc §1) + 그 죽은 org-level fanout(`_subscribers`) 자체가 삭제됨.
    # webhook(fire_webhooks, 아래)은 별개 채널이라 무관·그대로 유지.
    for _ev, _notify in violation_dispatch:
        try:
            await fire_webhooks(
                db, repo.org_id, "workflow_violation", _ev, recipient_member_ids=_notify,
            )
        except Exception:  # noqa: BLE001
            pass

    # #2131 근본수정: bulk가 status를 실제로 바꾸면서도 emit_story_status_changed()를 아예
    # 호출하지 않아 SSE 프레임이 서버에서 출발조차 안 했다(칸반 드래그·컬럼메뉴 둘 다 이 라우트라
    # 남의 화면에 영원히 안 보이던 근본). PATCH /{id}/status(:1272)와 **같은 공유 helper**를
    # 그대로 재사용 — 발행 지점을 갈라놓지 않는다(AC3, #2122/#2132와 동일 성질: 두 경로가
    # 갈라지면 다음 결함이 또 한쪽에서만 재발). old_status_by_id는 위에서 이미 "실제로 바뀐
    # item만" 채워둔 것을 그대로 재사용(중복 판정 없음).
    actor_name = actor_role = actor_type = None
    if old_status_by_id or old_assignee_by_id:
        actor_name, actor_role, actor_type = await _resolve_actor_info(db, actor_id)

    if old_status_by_id:
        for s in updated:
            old = old_status_by_id.get(s.id)
            if old is None:
                continue
            try:
                await emit_story_status_changed(
                    db, repo.org_id, s, old,
                    actor_id=actor_id, actor_name=actor_name, actor_role=actor_role, actor_type=actor_type,
                    request_received_at=_request_received_at,
                )
            except Exception:  # noqa: BLE001 — 한 item의 emit 실패가 나머지 item을 막지 않음.
                # 오르테가군 PR 리뷰(2026-07-24): warning은 찾을 때 안 보이는 자리 — 오늘
                # #2128/#2160/#2161 전부 "조용한 실패"였다. 나가야 할 실시간 프레임이 안 나간
                # 것 자체가 이 스토리가 고치는 병이라 ERROR로 올린다.
                #
                # story #2173: 이 try/except는 emit_story_status_changed 자체의 신뢰성을 못
                # 믿어서가 아니다(그쪽은 이미 완전 내부 격리 — update_story_status의 단건
                # 콜사이트 주석 참조) — **다건성**(이 item이 실패해도 for 루프의 나머지 item은
                # 계속 처리돼야 함) 때문. 단건 경로엔 "나머지 item"이 없어 이 이유가 적용 안 된다.
                logger.error(
                    "bulk status_changed emit 실패(story=%s)", s.id, exc_info=True,
                )

    # story #2172 AC1: assignee_id도 status와 동형 — bulk가 assignee_id를 실제로 바꾸면서도
    # 이 helper를 호출하지 않아 PATCH /{id}는 story.assignee_changed를 내는데 /bulk은 안 내는
    # 계약 불일치가 있었다(현재 FE 라이브 콜러 0 — kanban-board.tsx는 assignee_id를 bulk로 안
    # 보낸다. "지금 아무도 안 밟지만 계약은 깨져 있는" 자리를 여기서 닫는다). old_assignee_by_id는
    # 멤버십으로 "실제 변경"만 담아뒀으므로 그대로 재사용(중복 판정 없음, status와 동형).
    if old_assignee_by_id:
        for s in updated:
            if s.id not in old_assignee_by_id:
                continue
            old = old_assignee_by_id[s.id]
            try:
                await emit_story_assignee_changed(
                    db, repo.org_id, s, old,
                    background_tasks=background_tasks,
                    actor_id=actor_id, actor_name=actor_name, actor_role=actor_role, actor_type=actor_type,
                )
            except Exception:  # noqa: BLE001 — 한 item의 emit 실패가 나머지 item을 막지 않음.
                logger.error(
                    "bulk assignee_changed emit 실패(story=%s)", s.id, exc_info=True,
                )
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
    if body.human_owner_member_id is not None:
        await _assert_human_owner(db, repo.org_id, body.human_owner_member_id)

    data = body.model_dump(exclude_unset=True)
    # S7: client 제공 asset_id strip(서버 권위·drift 방지·까심)·아래 sync url_map 으로만 역기입.
    if data.get("attachments"):
        data["attachments"] = [{**a, "asset_id": None} for a in data["attachments"]]
        # story #2055 AC1: width/height도 asset_id와 동일하게 server authority — client 값
        # 무시하고 서버가 다시 측정(best-effort).
        from app.services.image_dimensions import measure_image_dimensions
        for a in data["attachments"]:
            a["width"], a["height"] = await measure_image_dimensions(a["content_type"], a["url"]) or (None, None)
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
    old_position: int | None = None
    story_before = None
    # story #2172 AC2: position 변경도 old-value 대조가 필요해 assignee_id와 같은 사전조회를 공유.
    if "assignee_id" in data or "position" in data:
        story_before = await repo.get(id)
        if story_before:
            old_assignee_id = story_before.assignee_id
            old_position = story_before.position
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
        # story #2172 근본수정(AC1): 이 side-effects를 PATCH /bulk과 공유하는 단일 helper로
        # 추출 — 두 라우트가 발행 지점을 갈라 갖던 #2131류 결함 재발을 막는다.
        await emit_story_assignee_changed(
            db, repo.org_id, story, old_assignee_id,
            background_tasks=background_tasks,
            actor_id=actor_id, actor_name=actor_name, actor_role=actor_role, actor_type=actor_type,
        )

    # story #2172 AC2 판정(오르테가군 지시 — "재정렬 전용 이벤트가 필요한지, 기존 것으로
    # 되는지 판단하고 근거 남길 것"): 신규 전용 event_type(`story.position_changed`)을 쓰되,
    # 발행 메커니즘 자체는 assignee_changed와 동일한 기존 패턴(project_accessible_member_ids
    # + _push_to_agent 개별 push, Event row 미생성)을 그대로 재사용한다. `story.status_changed`나
    # `story.assignee_changed`를 재사용하지 않은 이유: FE 컨슈머가 event_type으로 분기하는데
    # (kanban-board.tsx의 `payload.status`/`assignee_id` 필드 체크), 의미가 다른 필드 변경을
    # 기존 타입에 얹으면 다음에 그 타입 소비처가 무관 필드를 오인 처리할 여지가 생긴다(오늘
    # 세운 "동작은 한 곳에서만 선언" 원칙과 동형 — event_type과 payload 의미의 1:1을 지킨다).
    # webhook/notification/StoryActivity를 안 붙인 이유: assignee_changed helper(story_assignee_events.py)
    # 주석과 동일 논리 — position 값 자체는 story.position이 SSOT라 재조회로 복원되는 순수
    # 상태축 신호일 뿐, "누가 언제 재배치했는지" 감사가 필요해지면(현재 AC엔 없음) StoryActivity를
    # 추가해야 한다는 것이 이 판정이 무너지는 조건이다. FE 리스너는 story #2172 시점엔 아직
    # 없다(kanban-board.tsx가 position PATCH 응답만 낙관적 반영·SSE 구독 X) — 이 이벤트는
    # 계약(서버가 실제로 emit함)을 갖추는 것이 목적이고 FE 소비는 별도 스코프.
    if "position" in data and old_position != story.position:
        try:
            from app.routers.events import _push_to_agent
            from app.services.project_auth import project_accessible_member_ids

            _pos_member_ids = await project_accessible_member_ids(db, repo.org_id, story.project_id)
            _pos_payload = {
                "event_type": "story.position_changed",
                "story_id": str(id),
                "story_title": story.title,
                "position": story.position,
                "old_position": old_position,
                "status": story.status,
                "project_id": str(story.project_id),
                "org_id": str(repo.org_id),
                "actor_id": str(actor_id) if actor_id else None,
                "timestamp": datetime.now(timezone.utc).isoformat(),
            }
            for member_id in _pos_member_ids:
                _push_to_agent(str(member_id), dict(_pos_payload))
        except Exception:
            logger.warning(
                "position_changed SSE 포워딩 실패(story=%s project=%s)",
                story.id, story.project_id, exc_info=True,
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
    # #2176 AC1: 요청 수신 시각(다른 어떤 DB/인가 작업보다도 먼저) — emit_story_status_changed에
    # 그대로 넘겨 "요청 수신→emit 착수" 구간을 잰다. 순수 time.time() 캡처라 무부하.
    _request_received_at = time.time()
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
            # 박멸. story #2132(2026-07-23): publish_event() 호출 제거 — FE 소비처 0(설계 doc §1) +
            # 그 죽은 org-level fanout(`_subscribers`) 자체가 삭제됨.
            _violation_notify_ids = {
                m for m in (actor_id, story.assignee_id) if m is not None
            }
            try:
                await fire_webhooks(
                    db, org_id, "workflow_violation", _v_event,
                    recipient_member_ids=_violation_notify_ids,
                )
            except Exception:
                pass
        # 41a6e294: status_changed side-effects(events→L1·webhook·L2·notif·activity)는 공유 helper로
        # 발화 — gate-driven done(gate_service)과 동일 경로(parity·드리프트 0).
        #
        # story #2173(2026-07-24, 오르테가군 판정 — «결함인지 아닌지 가르기») 판정: 여기 try/except가
        # 없는 것과 아래 bulk_update_stories의 item별 try/except는 **우연히 갈린 게 아니라 이제는
        # 근거가 붙은 의도적 차이**다 — emit_story_status_changed() 자체가 이미 모든 side-effect를
        # 개별 try/except로 감싸 내부적으로 완전 격리돼 있어(SSE·webhook·L2·notification·
        # StoryActivity·trust_pipeline 전부, tests/test_emit_story_status_changed_isolation.py로
        # 고정) 이 콜사이트에서 밖으로 던질 경로가 구조적으로 없다(라이브 로그 근거도 0건).
        # bulk의 try/except는 emit 자체의 신뢰성 문제가 아니라 **다건성**(한 item의 실패가 나머지
        # item을 막으면 안 됨) 때문 — 단건은 애초에 "나머지 item"이 없어 그 이유가 적용 안 된다.
        # 무너지는 조건: emit_story_status_changed에 나중에 개별 try/except 없는 새 side-effect가
        # 추가되면 이 판정이 깨진다 — 그 경우 추가하는 사람이 여기도 다시 감쌀지 판단해야 한다.
        await emit_story_status_changed(
            db, org_id, story, old_status,
            actor_id=actor_id, actor_name=actor_name, actor_role=actor_role, actor_type=actor_type,
            request_received_at=_request_received_at,
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

@router.get("/{id}/comments")
async def list_comments(
    id: uuid.UUID,
    limit: int = Query(default=20, le=100),
    cursor: str | None = Query(default=None),
    db: AsyncSession = Depends(get_db),
    repo: StoryRepository = Depends(_get_repo),
    auth: AuthContext = Depends(get_current_user),
) -> dict:
    """story #2230: cursor 파라미터가 시그니처에만 있고 쿼리에 안 물려 있었다(선언-미사용
    죽은 파라미터) — FE(story-detail-panel.tsx)는 이미 이 파라미터로 「더보기」를 완결해
    두고 기다리고 있었다. #2231 정본 규약 A(limit+1 오버페치 + has_more/next_cursor body
    meta, 참조 구현: conversations.py::list_messages)로 실제 동작하게 한다.
    """
    # SEC(story #2206, 까심 인가 전수 스윕 A급): 쿼리 술어가 StoryComment.story_id == id 뿐이라
    # org_id 조건 자체가 없었다(project-only 누락이 아니라 org 조건 부재 — 같은 파일 다른
    # 엔드포인트들의 project-only 누락 갭과 다른 형태). 어느 org 멤버든 story UUID만 알면 다른
    # org 의 댓글을 읽을 수 있었다. GET /{id}(524) 의 형제 가드(_assert_story_project_access)
    # 를 그대로 재사용 — 새 규칙 발명 0.
    story = await repo.get(id)
    if story is None:
        raise HTTPException(status_code=404, detail="Story not found")
    await _assert_story_project_access(repo.session, auth, repo.org_id, story.project_id)
    q = select(StoryComment).where(StoryComment.story_id == id)
    if cursor:
        try:
            cursor_dt = datetime.fromisoformat(cursor)
        except ValueError:
            raise HTTPException(status_code=400, detail="Invalid cursor format")
        q = q.where(StoryComment.created_at < cursor_dt)
    q = q.order_by(StoryComment.created_at.desc()).limit(limit + 1)
    result = await db.execute(q)
    rows = list(result.scalars())
    has_more = len(rows) > limit
    page = rows[:limit]
    next_cursor = page[-1].created_at.isoformat() if has_more and page else None
    return {
        "data": [CommentResponse.model_validate(r) for r in page],
        "meta": {"has_more": has_more, "next_cursor": next_cursor},
    }


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
            # C0-S2: 에이전트가 payload만 보고 답글 달 수 있는 최소 반응 맥락(webhook generic payload).
            context={
                "story_id": str(story.id),
                "comment_id": str(comment.id),
                "content": content,
                "author_member_id": str(created_by),
            },
        )

    return CommentResponse.model_validate(comment)


# ─── Activities ───────────────────────────────────────────────────────────────

@router.get("/{id}/activities", response_model=list[ActivityResponse])
async def list_activities(
    id: uuid.UUID,
    limit: int = Query(default=20, le=100),
    db: AsyncSession = Depends(get_db),
    repo: StoryRepository = Depends(_get_repo),
    auth: AuthContext = Depends(get_current_user),
) -> list[ActivityResponse]:
    # SEC(story #2206) — list_comments(1339)와 동형 갭·동형 처방. 자세한 사유는 그쪽 주석 참조.
    story = await repo.get(id)
    if story is None:
        raise HTTPException(status_code=404, detail="Story not found")
    await _assert_story_project_access(repo.session, auth, repo.org_id, story.project_id)
    q = select(StoryActivity).where(
        StoryActivity.story_id == id,
    ).order_by(StoryActivity.created_at.desc()).limit(limit)
    result = await db.execute(q)
    return [ActivityResponse.model_validate(r) for r in result.scalars()]
