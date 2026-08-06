import json
import logging
import time
import uuid
from datetime import datetime, timezone

from fastapi import APIRouter, BackgroundTasks, Body, Depends, HTTPException, Query, Response
from pydantic import BaseModel, field_validator
from sqlalchemy import or_, select, text, tuple_
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.config import settings
from app.core.pagination import assemble_page, decode_cursor
from app.dependencies.auth import AuthContext, enforce_body_context, get_current_user, get_project_scoped_org_id, get_verified_org_id
from app.dependencies.database import get_db, get_read_db
from app.models.deletion_audit import DeletionAuditLog
from app.models.pm import Goal, Story, StoryActivity, StoryComment
from app.models.team import TeamMember
from app.repositories.story import StoryRepository
from app.repositories.story_assignee import StoryAssigneeRepository
from app.routers.agent_gateway import wake_agent
from app.routers.gates import GateResponse
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


# story #2451(§6 Phase3 A2): list_stories 전용 — kanban board 목록 조회는 create→self-read
# 흐름이 약하고(replica lag 실측 0.86s, PO 승인) 최대 트래픽 자리라 read replica. 다른
# 라우트가 공유하는 위 _get_repo(get_db)는 그대로 둔다(최소 diff).
def _get_repo_read(
    session: AsyncSession = Depends(get_read_db),
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
    boost_candidates_from: uuid.UUID | None = Query(
        default=None,
        description=(
            "story #2328(C-11 ㉡층) — 이 story의 의미 후보(status=estimated) 대상을 결과 "
            "맨 앞으로 재정렬(필터링 아님, q 비어도 동작). 해당 항목엔 is_reference_candidate="
            "true·matched_snippet이 실린다(유나 규격, 2026-07-29)."
        ),
    ),
    limit: int = Query(default=1000, ge=1, le=2000),
    cursor: str | None = Query(default=None, description="Cursor: ISO 8601 created_at, fetch before this time"),
    response: Response = None,  # type: ignore[assignment]
    repo: StoryRepository = Depends(_get_repo_read),
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
    # ⛔일반 함정(2026-07-29, PO 지적 — "측정 경로 ≠ 실행 경로"): `Query(default=None, ...)`
    # 기본값은 「값」이 아니라 「센티널 객체」다 — FastAPI가 실 HTTP 요청 경유에서만 그것을
    # 실제 값(여기선 None)으로 해소한다. 이 라우터 함수를 FastAPI 경유 없이 직접 호출하는
    # 테스트(이 새 파라미터를 모른 채 kwargs를 안 넘기는 기존 다수 — test_2188_*·
    # test_2189_*·test_083176e8_* 등)는 그 센티널 객체 그대로를 받는다. 센티널은 `is not
    # None` 가드를 «참»으로 통과시켜 버린다("None이 아니다"는 맞지만 "UUID다"는 아니다) —
    # DB 쿼리에 UUID 자리로 새 나가 asyncpg가 깨진다. ⛔이 코드베이스 다른 곳에 `Query(...)`/
    # `Depends(...)` 기본값을 옵셔널 파라미터로 받는 자리가 또 있으면 같은 함정이다 —
    # `is not None`이 아니라 `isinstance(..., <실제타입>)`으로 검사할 것.
    if isinstance(boost_candidates_from, uuid.UUID):
        stories = await _boost_reference_candidates(
            repo.session, repo.org_id, stories, boost_candidates_from,
        )
    return [StoryResponse.model_validate(s) for s in stories]


async def _boost_reference_candidates(
    session: AsyncSession, org_id: uuid.UUID, stories: list[Story], source_id: uuid.UUID,
) -> list[Story]:
    """story #2328(C-11 ㉡층, 유나 규격 2026-07-29) — 의존성 고르기 검색결과 중 source_id
    story의 의미 후보(status=estimated)를 맨 앞으로 재정렬한다. ⛔거르지 않는다(유나 규격
    ③) — 전달받은 stories를 그대로 재정렬만 한다. 후보인 항목엔 transient attr(agent_
    delegate_ids 패턴 동형)로 is_reference_candidate=True·matched_snippet을 세팅해
    "왜 여기 있는지"를 응답에 싣는다(유나 규격 ①② — 뱃지가 아니라 이유, 지어내지 않는다)."""
    from app.models.reference_semantic_candidate import ReferenceSemanticCandidate

    result = await session.execute(
        select(ReferenceSemanticCandidate.target_id, ReferenceSemanticCandidate.snippet).where(
            ReferenceSemanticCandidate.org_id == org_id,
            ReferenceSemanticCandidate.source_type == "story",
            ReferenceSemanticCandidate.source_id == source_id,
            ReferenceSemanticCandidate.target_type == "story",
            ReferenceSemanticCandidate.status == "estimated",
        )
    )
    snippet_by_target: dict[uuid.UUID, str] = {row.target_id: row.snippet for row in result.all()}
    if not snippet_by_target:
        return stories
    for story in stories:
        if story.id in snippet_by_target:
            story.is_reference_candidate = True
            story.matched_snippet = snippet_by_target[story.id]
    # stable sort — 후보가 앞으로, 각 그룹 내 원래 상대순서는 그대로 유지(유나 규격 ③).
    return sorted(stories, key=lambda s: 0 if s.id in snippet_by_target else 1)


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
    에이전트 project_access grant 양쪽 처리). delete_story는 SEC-S3(#2014)가 별도 처리.

    ⛔story #2322(2026-07-29, PO 판정): 무권한을 403이 아닌 404로 낸다 — 존재 비노출 규율을
    이 파일 전체에서 통일한다(participation.py의 동명 헬퍼·gates.py get_gate_endpoint가 이미
    이 규율이었다 — 「같은 엔티티가 경로마다 다른 답」을 내던 것이 진짜 결함이었다). 조직
    경계(다른 org)는 이 함수 호출 前에 이미 404로 막혀 있다(repo.get()의 org 필터) — 이 함수가
    새로 여는 것은 「조직 안·프로젝트 밖」 하나뿐이고, 그 답도 이제 404다."""
    from app.services.project_auth import has_project_access

    if not await has_project_access(session, uuid.UUID(auth.user_id), project_id, org_id):
        raise HTTPException(status_code=404, detail="Story not found")


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

# ⛔story #2346 AC3(2026-07-30, story 하나만 먼저 — docs.py/agent_runs.py는 미착수, 아래
# _STORY_UPDATED_ACTIVITY_TODO 참조): 「긴 텍스트 필드」의 정의를 한 자리 상수로 — 필드명을
# 흩어 놓지 않는다. 나중에 필드가 늘면 여기만 고친다.
_LENGTH_TRACKED_FIELDS = ("description", "acceptance_criteria")
# ⛔story #2346 AC7(2026-07-30, PO 판정 — 사람 세기에서 기계 게이트로 격상): 같은 날 실제로
# 난 3건의 급감 사고가 전부 -80%대였다(3619→437·4052→경고문구·2121→진행현황뿐) — 그보다
# 훨씬 낮은 50%를 임계로 잡아도 셋 다 막혔을 것이다. `allow_shrink=true`로 명시 승인 가능.
_SHRINK_BLOCK_THRESHOLD = 0.5
# ⛔story #2346 AC7 정정(2026-07-30, PO 지적 — 「원본 길이」 floor는 구멍을 남긴다): 200자
# 본문이 통째로 지워지는 것("읽지 않고 쓰는" 것 자체가 문제지 길이가 아니다)은 원본-길이
# floor로는 안 막혔다. 「원본 길이」 대신 「손실 절대량」으로 자를 바꾼다 — floor가 필요
# 없어진다: entity 토큰(~48자→14자, -70%지만 -34자)은 절대량이 작아 안 막히고, 200자→10자
# (-95%·-190자)는 막힌다 — 특수 분기 없이 자연히 갈린다.
_SHRINK_BLOCK_MIN_LOST_CHARS = 100


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


async def _reconcile_story_references_and_candidates(
    db: AsyncSession,
    *,
    org_id: uuid.UUID,
    story: Story,
    check_description: bool,
    check_acceptance_criteria: bool,
    mention_actor_id: uuid.UUID | None,
) -> None:
    """story #2301/#2328 공용 코어 — description·acceptance_criteria의 `#`엔티티 토큰을
    entity_references(#2259)로 걷고 reference_semantic_candidates(#2328)를 얹는다.

    ⛔파울로 판정(2026-07-30, dev 전수스윕 0/420 사고 원인): 이 로직이 원래 update_story()
    에만 있었다 — create_story()는 한 번도 부르지 않았다. "새 참조만(소급 안 함)"이라는
    #2328 판정이 "저장 시점마다"를 의도했는데, 실제로는 "«수정» 시점마다"로만 구현된 것
    (create가 빠짐 — 사람은 스토리를 만들 때 본문을 다 쓰고 만들므로 "새 것"의 대부분이
    이 갭에 빠졌다). create_story·update_story 둘 다 **이 함수 하나**를 호출한다 — 로직을
    두 벌 만들지 않는다(파울로 명시 지시)."""
    from app.services.mention_parser import (
        extract_chat_entity_mentions,
        reconcile_entity_references,
        resolve_bare_number_story_refs,
    )
    from app.services.reference_semantic_candidates import generate_and_store_candidates

    _ref_stored = 0
    _ref_dropped: list[dict[str, str]] = []
    if check_description:
        _desc_text = story.description or ""
        _desc_pairs = extract_chat_entity_mentions(_desc_text)
        _desc_bare_refs = await resolve_bare_number_story_refs(
            db, org_id=org_id, project_id=story.project_id, content=_desc_text,
        )
        _desc_result = await reconcile_entity_references(
            db, org_id=org_id, source_type="story", source_field="description",
            source_id=story.id,
            extracted_refs=[(t, i, "mention") for t, i in _desc_pairs] + _desc_bare_refs,
            created_by=mention_actor_id,
        )
        _ref_stored += _desc_result.stored
        _ref_dropped.extend(_desc_result.dropped)
        await generate_and_store_candidates(
            db, org_id=org_id, project_id=story.project_id, source_type="story",
            source_field="description", source_id=story.id, content=_desc_text,
        )
    if check_acceptance_criteria:
        _ac_text = story.acceptance_criteria or ""
        _ac_pairs = extract_chat_entity_mentions(_ac_text)
        _ac_bare_refs = await resolve_bare_number_story_refs(
            db, org_id=org_id, project_id=story.project_id, content=_ac_text,
        )
        _ac_result = await reconcile_entity_references(
            db, org_id=org_id, source_type="story", source_field="acceptance_criteria",
            source_id=story.id,
            extracted_refs=[(t, i, "mention") for t, i in _ac_pairs] + _ac_bare_refs,
            created_by=mention_actor_id,
        )
        _ref_stored += _ac_result.stored
        _ref_dropped.extend(_ac_result.dropped)
        await generate_and_store_candidates(
            db, org_id=org_id, project_id=story.project_id, source_type="story",
            source_field="acceptance_criteria", source_id=story.id, content=_ac_text,
        )
    # 채팅(conversations.py)과 동일 게이트: 정상 경로(둘 다 0)에선 필드 자체를 안 싣는다.
    if _ref_stored or _ref_dropped:
        story.references = {"stored": _ref_stored, "dropped": _ref_dropped}


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
    # story #2267(C-9): 출처(「무엇에서 만들었나」) — 컨테이너(epic/sprint/meeting_id)와
    # 다른 축. 둘 다 제공됐을 때만(하나만 있으면 무시 — 부분입력은 의미가 없다) entity_
    # references에 relation='created_from' 한 줄을 심는다. source_field='self' — 텍스트
    # 필드에서 파싱된 게 아니라(그런 "필드"가 없다) 엔티티 전체가 원인이라는 sentinel
    # (source_field 기존 관례 "body"와 같은 원칙, 값만 다름 — app/models/reference.py 참조).
    # ⛔소급 없음(이 호출 자체가 신규 생성 시점에만 있다 — 옛 스토리는 그대로 「아직 모름」).
    #
    # ⭐story #2222(AC5, 2026-07-31 오르테가 확認 — 「지금도 도는 결함」): 예전엔 이 블록의
    # 실패(예: registry 밖 origin_type)가 get_db의 단일 커밋/전체롤백 불변식을 그대로 타서
    # **story 생성 전체를 실패시켰다**(부분성공 회피가 목적이었으나, 「낳음」 자동부착은
    # story #2222부터 best-effort 부가기능이라 이 실패모드가 AC5와 정반대가 됐다 — caller가
    # 0개라 지금까지 안 터졌을 뿐 이미 있던 결함). SAVEPOINT(begin_nested)로 격리해 이
    # 블록만 롤백하고 story 생성은 그대로 진행한다(feedback_savepoint_failopen_session_
    # poison 패턴 재사용 — 실패가 바깥 세션을 poison하지 않도록 격리).
    if body.origin_type is not None and body.origin_id is not None:
        from app.services.reference_core import insert_reference

        try:
            async with session.begin_nested():
                await insert_reference(
                    session,
                    org_id=org_id,
                    source_type=body.origin_type,
                    source_field="self",
                    source_id=body.origin_id,
                    target_type="story",
                    target_id=story.id,
                    form="mention",
                    created_by=await _resolve_team_member_id(auth, org_id, session),
                    relation="created_from",
                )
        except Exception:
            # AC5: 자동부착 실패가 story 생성을 막지 않는다 — 조용히 삼키지 않고 로그로 남긴다.
            logger.warning(
                "story #2222: created_from 자동부착 실패(story_id=%s origin_type=%s origin_id=%s) "
                "— story 생성은 그대로 진행",
                story.id, body.origin_type, body.origin_id, exc_info=True,
            )
    elif body.origin_type is None and body.origin_id is None:
        # ⚠️story #2222 AC3 — 「부모 없음」을 명시로 구분해 기록하는 것의 **약한 형태**다(오르테가
        # 확認, 2026-07-31): entity_references는 행이 없으면 없는 것으로 두는 기존 철학을
        # 그대로 따르므로(새 마킹 컬럼/행을 만들지 않는다), 이 로그만으로는 「진짜 최상위 생성」과
        # 「에이전트가 알면서 origin을 안 채운 누락」이 데이터상 구분되지 않는다 — 나중에 셀 수
        # 있게 로그로 남기는 것으로 **AC3을 갈음**할 뿐, 강한 형태(둘을 데이터로 구분)는 다음 판.
        logger.info(
            "story #2222: origin_type/origin_id 미지정(story_id=%s) — 최상위 생성으로 간주 "
            "(AC3 약한 형태: 로그로만 구분, 강한 구분은 후속)",
            story.id,
        )
    # ⛔파울로 판정(2026-07-30, dev 전수스윕 0/420 사고): entity_references(#2259/#2301)·
    # reference_semantic_candidates(#2328) reconcile이 update_story()에만 있고 이 함수
    # (POST 생성)에는 «한 번도» 없었다 — 사람은 스토리를 «본문을 다 쓰고» 만드는 것이
    # 보통이라, 이 갭이 "새 것"의 대부분을 빠뜨렸다(#2330이 그 실물 증거 — 아래 참조).
    # update_story와 같은 트랜잭션 원자성(같은 세션, commit 전 — 실패 시 story 생성
    # 전체가 롤백)으로 붙인다.
    _mention_actor_id: uuid.UUID | None = None
    try:
        _mention_actor_id = await _resolve_team_member_id(auth, org_id, session)
    except Exception:
        _mention_actor_id = None
    await _reconcile_story_references_and_candidates(
        session, org_id=org_id, story=story,
        check_description=True, check_acceptance_criteria=True,
        mention_actor_id=_mention_actor_id,
    )
    return StoryResponse.model_validate(story)


# E-DG S11 FE unblock: 보드 카드 badge 용 배치 read — per-story fetch N+1 회피(gates 배치 패턴
# 미러·1 fetch+map). ⚠️ /{id} 보다 **먼저** 선언(specific-before-parameterized). active-only 요약
# (mode/status + engine_degraded/grandfathered/handoff_stuck + delivery_status)·org-scoped·N+1 0.
@router.get("/workflow-line/status", response_model=list[LineStatusSummary])
async def get_workflow_line_status_batch(
    ids: str = Query(..., description="comma-separated story ids"),
    repo: StoryRepository = Depends(_get_repo),
    auth: AuthContext = Depends(get_current_user),
) -> list[LineStatusSummary]:
    try:
        story_ids = [uuid.UUID(x) for x in ids.split(",") if x.strip()]
    except ValueError:
        raise HTTPException(status_code=422, detail="invalid story id in ids")
    if not story_ids:
        return []
    if len(story_ids) > 200:  # 보드 페이지 단위 방어(과대 IN 금지)
        raise HTTPException(status_code=422, detail="too many ids (max 200)")
    # story #2245(형제 비대칭 — 배치판): 단건(get_workflow_line_status)과 같은 구멍이 여기 있었다
    # (org-scope만, 항목별 project 접근권 검사 0) — 200개까지 한 번에 새는 자리라 단건보다 값이 큼.
    # ⛔has_project_access를 id마다 부르지 않는다(쿼리 200회) — 접근 가능한 project 집합을
    # 한 번에 구해(accessible_project_ids_in_org) 조회 前에 story_ids를 거른다(+1~2 쿼리로 끝남).
    project_by_id = dict((await repo.session.execute(
        select(Story.id, Story.project_id).where(
            Story.org_id == repo.org_id, Story.id.in_(story_ids),
        )
    )).all())
    from app.services.project_auth import accessible_project_ids_in_org
    accessible = set(
        await accessible_project_ids_in_org(repo.session, uuid.UUID(auth.user_id), repo.org_id)
    )
    # ⛔접근권 없는 id는 조용히 빼고 나머지만 준다(부분 성공) — 몇 개가 빠졌는지도 알리지 않는다.
    # "빠졌다"는 말 자체가 그 id의 존재를 누설한다 — 없는 id와 못 보는 id를 구분하지 않는다
    # (404/403을 안 가르는 것과 같은 이유).
    filtered_ids = [sid for sid in story_ids if project_by_id.get(sid) in accessible]
    return await build_workflow_line_status_batch(repo.session, repo.org_id, filtered_ids)


# E-DG S15(P1-6): line metric 집계(org-scoped·read-only·default-off org=no-op). ⚠️ /{id} 보다 먼저.
# story #2245 경계 기록(스냅샷·판정 아님, 2026-07-28) — 개별 story 식별·내용 없이 org 전체
# COUNT/SUM뿐이라 이번 병(항목별 project 접근권 누락)의 대상이 아니라고 보고 이 스토리 스코프
# 밖에 남긴다. ⛔완전히 무해하다는 뜻은 아니다 — 집계는 "내가 못 보는 프로젝트의 일이 몇
# 건인가"를 알려 준다. 개별 식별은 불가하고 org 내부라 지금은 열어 두지만, project 격리를
# 엄히 요구하는 고객이 생기면 다음에 손댈 자리가 여기다.
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


# ─── Backlinks (story #2266·C-8·E-CONNECT — target_type 일반화의 첫 사용처) ─────
# `app.services.backlinks.list_entity_backlinks`는 SOURCE 접근만 스스로 판정하고 TARGET 접근은
# 호출부 책임(§8① 동일 계약, docs.py의 get_doc_backlinks와 동형). 이 라우트가 그 TARGET
# 게이트다 — get_story와 동일한 `_assert_story_project_access` 재사용(AC2: 같은 PR에 게이트,
# AC7: 새 인증 미발명).
@router.get("/{id}/backlinks")
async def get_story_backlinks(
    id: uuid.UUID,
    limit: int = Query(default=30, ge=1, le=200),
    before: str | None = Query(default=None),
    repo: StoryRepository = Depends(_get_repo),
    auth: AuthContext = Depends(get_current_user),
) -> dict:
    """GET /api/v2/stories/{id}/backlinks — 이 story를 가리키는 chat_message/doc 목록(#2266,
    C-8 "역방향"). docs.py의 get_doc_backlinks와 동일 convention(cursor pagination, 응답
    shape) — 실제 쿼리는 `list_entity_backlinks`가 target_type만 다르게 받아 처리하는 **같은
    코드**다(중복 구현 아님). 존재하지 않는 story는 404, 있지만 project 접근 없으면 403
    (`_assert_story_project_access` — get_story와 동일 계약, existence oracle 없음)."""
    story = await repo.get(id)
    if story is None:
        raise HTTPException(status_code=404, detail="Story not found")
    await _assert_story_project_access(repo.session, auth, repo.org_id, story.project_id)

    from app.services.backlinks import list_entity_backlinks
    return await list_entity_backlinks(
        repo.session, org_id=repo.org_id, target_type="story", target_id=id,
        auth=auth, limit=limit, cursor=before,
    )


# ─── 의미 후보(story #2328·C-11 ㉡층·E-CONNECT — 3단계 승격의 ②③) ─────
@router.get("/{id}/reference-candidates")
async def get_story_reference_candidates(
    id: uuid.UUID,
    repo: StoryRepository = Depends(_get_repo),
    auth: AuthContext = Depends(get_current_user),
) -> list[dict]:
    """GET /api/v2/stories/{id}/reference-candidates — 이 story의 본문/AC에서 관찰된 맨 번호
    참조 위에 얹힌 「의미 후보」 목록(AC5: 별도 정리 화면이 아니라 story 상세 화면이 이 자리에서
    직접 부른다). get_story_backlinks와 동일 접근 게이트(`_assert_story_project_access`)."""
    story = await repo.get(id)
    if story is None:
        raise HTTPException(status_code=404, detail="Story not found")
    await _assert_story_project_access(repo.session, auth, repo.org_id, story.project_id)

    from app.services.reference_semantic_candidates import list_candidates_for_source

    candidates = await list_candidates_for_source(
        repo.session, org_id=repo.org_id, source_type="story", source_id=id,
    )
    return [
        {
            "id": str(c.id),
            "source_field": c.source_field,
            "target_type": c.target_type,
            "target_id": str(c.target_id),
            "relation_kind": c.relation_kind,
            "matched_keyword": c.matched_keyword,
            "snippet": c.snippet,
            "status": c.status,
            "declared_by": str(c.declared_by) if c.declared_by else None,
            "declared_at": c.declared_at.isoformat() if c.declared_at else None,
            "created_at": c.created_at.isoformat(),
        }
        for c in candidates
    ]


class DeclareNewReferenceRequest(BaseModel):
    target_id: uuid.UUID
    relation_kind: str | None = None


@router.post("/{id}/reference-candidates", status_code=201)
async def declare_new_story_reference_candidate(
    id: uuid.UUID,
    body: DeclareNewReferenceRequest,
    response: Response,
    repo: StoryRepository = Depends(_get_repo),
    auth: AuthContext = Depends(get_current_user),
) -> dict:
    """POST /api/v2/stories/{id}/reference-candidates — story #2355: 사람이 «후보가 아예
    없던» 이 story(source) ↔ target_id(story) 연결을 처음 만든다. 기존 declare/relation-kind/
    reject 셋 다 기존 candidate_id가 있어야만 쓰는 것과 달리, 이 엔드포인트는 그 candidate_id
    자체를 새로 만든다(#2355 AC1). 방향은 «끈 순서» — id=source(«여기서 시작함»), target_id=
    target(«여기로 놓음»).

    ⛔오르테가 지적(2026-07-31): 이미 declared인 쌍에 재호출하면 ON CONFLICT WHERE가 거짓이라
    실제로는 아무것도 안 바뀌는데, 응답이 늘 201·"바뀐 값처럼" 보이면 호출자가 조용히
    오독한다 — 409는 안 쓴다(이미 이어진 것은 오류가 아니다). 대신 `created`로 명시 구별하고
    (no-op이면 200으로 status_code도 함께 낮춘다), 부르는 쪽이 "이미 있었다"를 코드로
    구별할 수 있게 한다.

    ⛔IDOR 수정(오르테가 실측, 2026-07-31): target도 source와 «독립적으로» project 접근권을
    검사한다(references.py create_reference의 양쪽-아이템 게이트와 동형 — "반쪽 금지").
    이전엔 org_id만 걸러 접근 못 하는 프로젝트의 story를 target으로 연결할 수 있었고,
    404(없음)/201(성공)이 갈려 존재 여부까지 샜다. 미존재·무권한 두 경우 모두 같은
    404 "Target story not found"로 응답해 존재 비노출을 지킨다."""
    story = await repo.get(id)
    if story is None:
        raise HTTPException(status_code=404, detail="Story not found")
    await _assert_story_project_access(repo.session, auth, repo.org_id, story.project_id)

    if body.target_id == id:
        raise HTTPException(status_code=400, detail="Cannot link a story to itself")

    from app.services.project_auth import has_project_access

    target = (await repo.session.execute(
        select(Story.id, Story.project_id).where(Story.id == body.target_id, Story.org_id == repo.org_id)
    )).one_or_none()
    if target is None or not await has_project_access(
        repo.session, uuid.UUID(auth.user_id), target.project_id, repo.org_id
    ):
        raise HTTPException(status_code=404, detail="Target story not found")

    from app.services.reference_semantic_candidates import (
        InvalidPortRelationKindError,
        declare_new_candidate,
    )

    actor_id = await _resolve_team_member_id(auth, repo.org_id, repo.session)
    try:
        outcome = await declare_new_candidate(
            repo.session, org_id=repo.org_id, source_type="story", source_field="body",
            source_id=id, target_type="story", target_id=body.target_id,
            relation_kind=body.relation_kind, declared_by=actor_id,
        )
    except InvalidPortRelationKindError:
        raise HTTPException(status_code=400, detail="Invalid relation_kind")
    await repo.session.commit()
    candidate = outcome.candidate
    if not outcome.created:
        response.status_code = 200
    return {
        "id": str(candidate.id),
        "target_id": str(candidate.target_id),
        "relation_kind": candidate.relation_kind,
        "status": candidate.status,
        "declared_by": str(candidate.declared_by) if candidate.declared_by else None,
        "declared_at": candidate.declared_at.isoformat() if candidate.declared_at else None,
        "created": outcome.created,
    }


@router.post("/{id}/reference-candidates/{candidate_id}/declare")
async def declare_story_reference_candidate(
    id: uuid.UUID,
    candidate_id: uuid.UUID,
    repo: StoryRepository = Depends(_get_repo),
    auth: AuthContext = Depends(get_current_user),
) -> dict:
    """POST .../declare — AC5: 사람이 후보를 골라 「선언됨」으로 승격. ⛔AC4: 이 엔드포인트가
    바꾸는 것은 candidate.status/declared_by/declared_at 셋뿐이다 — 막힘·대기·종료·에이전트
    실행 등 다른 어떤 부수효과도 일으키지 않는다(회귀 테스트가 이 계약을 지킨다)."""
    story = await repo.get(id)
    if story is None:
        raise HTTPException(status_code=404, detail="Story not found")
    await _assert_story_project_access(repo.session, auth, repo.org_id, story.project_id)

    from app.services.reference_semantic_candidates import (
        CandidateNotFoundError,
        declare_candidate,
    )

    actor_id = await _resolve_team_member_id(auth, repo.org_id, repo.session)
    try:
        candidate = await declare_candidate(
            repo.session, org_id=repo.org_id, source_id=id, candidate_id=candidate_id,
            declared_by=actor_id,
        )
    except CandidateNotFoundError:
        raise HTTPException(status_code=404, detail="Reference candidate not found")
    await repo.session.commit()
    return {
        "id": str(candidate.id),
        "status": candidate.status,
        "declared_by": str(candidate.declared_by) if candidate.declared_by else None,
        "declared_at": candidate.declared_at.isoformat() if candidate.declared_at else None,
    }


class SetReferenceCandidateRelationKindRequest(BaseModel):
    relation_kind: str | None = None


@router.post("/{id}/reference-candidates/{candidate_id}/relation-kind")
async def set_story_reference_candidate_relation_kind(
    id: uuid.UUID,
    candidate_id: uuid.UUID,
    body: SetReferenceCandidateRelationKindRequest,
    repo: StoryRepository = Depends(_get_repo),
    auth: AuthContext = Depends(get_current_user),
) -> dict:
    """POST .../relation-kind — story #2223 판정(오르테가군, 2026-07-30): "이 연결이
    실재하는가"(declare, 위)와 "무슨 종류인가"(이 엔드포인트)는 «다른 질문» — 한 클릭에
    안 묶는다. declare 전후 아무 때나 호출 가능(순서 강제 없음). relation_kind=null로
    미분류로 되돌릴 수 있다(AC10 정신)."""
    story = await repo.get(id)
    if story is None:
        raise HTTPException(status_code=404, detail="Story not found")
    await _assert_story_project_access(repo.session, auth, repo.org_id, story.project_id)

    from app.services.reference_semantic_candidates import (
        CandidateNotFoundError,
        InvalidRelationKindError,
        set_candidate_relation_kind,
    )

    try:
        candidate = await set_candidate_relation_kind(
            repo.session, org_id=repo.org_id, source_id=id, candidate_id=candidate_id,
            relation_kind=body.relation_kind,
        )
    except CandidateNotFoundError:
        raise HTTPException(status_code=404, detail="Reference candidate not found")
    except InvalidRelationKindError:
        raise HTTPException(status_code=400, detail="Invalid relation_kind")
    await repo.session.commit()
    return {"id": str(candidate.id), "relation_kind": candidate.relation_kind}


class RejectRelationRequest(BaseModel):
    reason: str | None = None


@router.post("/{id}/reference-candidates/{candidate_id}/reject")
async def reject_story_reference_candidate(
    id: uuid.UUID,
    candidate_id: uuid.UUID,
    body: RejectRelationRequest = RejectRelationRequest(),
    repo: StoryRepository = Depends(_get_repo),
    auth: AuthContext = Depends(get_current_user),
) -> dict:
    """POST .../reject — story #2221 후속(오르테가 판정, 2026-07-30): 관계 단위 기각(간선이
    아니라 관계 — 유나 지적). 이 candidate 행이 가리키는 (source, target) 쌍 전체를
    `rejected_relations`에 기록하고, 같은 쌍을 가리키는 다른 field/form의 candidate 행도
    함께 지운다 — 그래야 「description에서 기각했는데 AC에서 또 뜬다」가 안 생긴다. 다음
    산문 임포트부터 이 쌍은 후보 생성 단계에서 걸러진다(지우기가 아니라 기록이라 영속)."""
    story = await repo.get(id)
    if story is None:
        raise HTTPException(status_code=404, detail="Story not found")
    await _assert_story_project_access(repo.session, auth, repo.org_id, story.project_id)

    from app.services.reference_semantic_candidates import (
        CandidateNotFoundError,
        reject_candidate,
    )

    actor_id = await _resolve_team_member_id(auth, repo.org_id, repo.session)
    try:
        await reject_candidate(
            repo.session, org_id=repo.org_id, source_id=id, candidate_id=candidate_id,
            rejected_by=actor_id, reason=body.reason,
        )
    except CandidateNotFoundError:
        raise HTTPException(status_code=404, detail="Reference candidate not found")
    await repo.session.commit()
    return {"ok": True}


@router.delete("/{id}/reference-candidates/{candidate_id}")
async def undeclare_story_reference_candidate(
    id: uuid.UUID,
    candidate_id: uuid.UUID,
    repo: StoryRepository = Depends(_get_repo),
    auth: AuthContext = Depends(get_current_user),
) -> dict:
    """DELETE .../reference-candidates/{candidate_id} — story #2355(AC8): 사람이 만든(또는
    승격한) 연결을 지운다. ⛔`reject`와 다른 것이다 — reject는 `rejected_relations`에 기록해
    다음 스캔에서도 영구히 거르지만, 이건 기록을 안 남긴다(실수로 지운 것을 영영 못 잇게
    되면 안 되므로). status='declared'가 아닌 행(아직 estimated인 기계 후보)은 400 —
    그런 행은 `reject`가 맞는 경로다."""
    story = await repo.get(id)
    if story is None:
        raise HTTPException(status_code=404, detail="Story not found")
    await _assert_story_project_access(repo.session, auth, repo.org_id, story.project_id)

    from app.services.reference_semantic_candidates import (
        CandidateNotDeclaredError,
        CandidateNotFoundError,
        undeclare_candidate,
    )

    try:
        await undeclare_candidate(
            repo.session, org_id=repo.org_id, source_id=id, candidate_id=candidate_id,
        )
    except CandidateNotFoundError:
        raise HTTPException(status_code=404, detail="Reference candidate not found")
    except CandidateNotDeclaredError:
        raise HTTPException(
            status_code=400, detail="Only a declared reference can be removed this way; use reject",
        )
    await repo.session.commit()
    return {"ok": True}


@router.get("/{id}/rejected-relations")
async def list_story_rejected_relations(
    id: uuid.UUID,
    repo: StoryRepository = Depends(_get_repo),
    auth: AuthContext = Depends(get_current_user),
) -> list[dict]:
    """GET .../rejected-relations — 이 story가 기각한 관계 목록(되살리기 UI용)."""
    story = await repo.get(id)
    if story is None:
        raise HTTPException(status_code=404, detail="Story not found")
    await _assert_story_project_access(repo.session, auth, repo.org_id, story.project_id)

    from sqlalchemy import select as _select

    from app.models.rejected_relation import RejectedRelation

    rows = (await repo.session.execute(
        _select(RejectedRelation).where(
            RejectedRelation.org_id == repo.org_id,
            RejectedRelation.source_type == "story",
            RejectedRelation.source_id == id,
        )
    )).scalars().all()
    return [
        {
            "id": str(r.id),
            "target_type": r.target_type,
            "target_id": str(r.target_id),
            "reason": r.reason,
            "rejected_by": str(r.rejected_by) if r.rejected_by else None,
            "rejected_at": r.rejected_at.isoformat(),
        }
        for r in rows
    ]


@router.delete("/{id}/rejected-relations/{target_id}")
async def undo_story_rejected_relation(
    id: uuid.UUID,
    target_id: uuid.UUID,
    repo: StoryRepository = Depends(_get_repo),
    auth: AuthContext = Depends(get_current_user),
) -> dict:
    """DELETE .../rejected-relations/{target_id} — 되살리기(오르테가 판정: 지금은 단순하게,
    rejected_relations 행을 삭제한다 — 되살린 기록 자체는 안 남긴다). ⛔되살려도 candidate
    행이 즉시 돌아오지 않는다 — 다음 story 저장이 있어야 새로 후보가 생긴다(이 모듈의
    "새 참조만" 설계 원칙, #2328 ③)."""
    story = await repo.get(id)
    if story is None:
        raise HTTPException(status_code=404, detail="Story not found")
    await _assert_story_project_access(repo.session, auth, repo.org_id, story.project_id)

    from app.services.reference_semantic_candidates import (
        RejectedRelationNotFoundError,
        undo_rejection,
    )

    try:
        await undo_rejection(
            repo.session, org_id=repo.org_id, source_type="story", source_id=id,
            target_type="story", target_id=target_id,
        )
    except RejectedRelationNotFoundError:
        raise HTTPException(status_code=404, detail="Rejected relation not found")
    await repo.session.commit()
    return {"ok": True}


async def _visible_target_ids(
    session: AsyncSession, org_id: uuid.UUID, caller_id: uuid.UUID,
    ids_by_type: dict[str, set[uuid.UUID]], auth: AuthContext,
    conversation_id_by_target_id: dict[uuid.UUID, uuid.UUID] | None = None,
) -> dict[str, set[uuid.UUID]]:
    """story #2263 AC6 — outgoing references의 TARGET 측 가시성. C-3(#2261)의 존재-비노출
    규율 그대로: 등록되지 않은 target_type이거나 project_id를 못 구하면(row 없음) 안 보이는
    쪽으로 fail-closed — reference_registry.PROJECT_ID_RESOLVERS(story #2314가 evidence에
    이미 재사용한 그 SSOT)를 여기서도 그대로 쓴다, 새 인증경로 발명 없음.

    ⛔chat_message는 예외 축 — project로 스코프되지 않는다(참여자 기반, #2261 시기부터 알려진
    "넷째 경계"). PROJECT_ID_RESOLVERS에 없으므로 project 분기를 안 타고, POST 라우트이 이미
    쓰는 `_can_read_conversation`(participant 기반 SSOT)를 그대로 재사용한다 — conversation_id
    는 ConversationMessage row를 다시 join하지 않고 `Reference.proof_payload`에 이미 저장된
    값을 호출부가 넘겨준다(그 payload가 유일한 SSOT — write 시점에 검증된 그 conversation_id
    그대로, message row 존재 여부와 무관하게 일관된 값)."""
    from app.services.project_auth import has_project_access
    from app.services.reference_registry import PROJECT_ID_RESOLVERS

    visible: dict[str, set[uuid.UUID]] = {}
    conversation_id_by_target_id = conversation_id_by_target_id or {}
    for target_type, target_ids in ids_by_type.items():
        if target_type == "chat_message":
            from app.routers.conversations import _can_read_conversation

            for target_id in target_ids:
                conv_id = conversation_id_by_target_id.get(target_id)
                if conv_id is not None and await _can_read_conversation(conv_id, session, auth, org_id):
                    visible.setdefault(target_type, set()).add(target_id)
            continue

        resolver = PROJECT_ID_RESOLVERS.get(target_type)
        if resolver is None:
            continue
        for target_id in target_ids:
            project_id = await resolver(session, org_id, target_id)
            if project_id is not None and await has_project_access(session, caller_id, project_id, org_id):
                visible.setdefault(target_type, set()).add(target_id)
    return visible


@router.get("/{id}/references")
async def get_story_outgoing_references(
    id: uuid.UUID,
    direction: str = Query(default="outgoing"),
    repo: StoryRepository = Depends(_get_repo),
    auth: AuthContext = Depends(get_current_user),
) -> dict:
    """GET /api/v2/stories/{id}/references?direction=outgoing — story #2263 AC6(오르테가
    판정 2026-07-29): 이 story가 가리키는 것(reference_core.list_references의 첫 실제
    소비자 — 그때까지 이 함수를 부르는 라우터가 0곳이었다). `direction=incoming`은 이 라우트
    범위 밖(그건 이미 GET /{id}/backlinks가 다른 응답 shape로 다룬다) — 명시 400으로 거부해
    「둘 다 되는 척」을 안 한다.

    TARGET(이 story 자신)은 get_story_backlinks와 동일 게이트(`_assert_story_project_access`
    — 없으면 404, 있지만 project 밖이면 404, #2322 PR#1 통일 반영). 다시 가리키는 쪽(outgoing
    의 반대편, 즉 이 story가 가리키는 대상들)의 가시성은 `_visible_target_ids`가 판정 —
    C-3(#2261)이 세운 것과 같은 규율(못 보는 대상은 존재 사실도 새지 않는다).

    응답은 proof_payload를 그대로 싣는다(PO 정정, 2026-07-29): 처음엔 "목록=메타만·단건=
    payload전량"으로 갈랐으나, 그 갈림이 소비 패턴을 안 보고 낸 판단이었다 — C-7 proof
    섹션은 카드를 여럿 펼쳐 보이는 자리라 단건 상세 라우트를 따로 지으면 N+1이 된다(그리고
    아무도 그 단건 라우트를 지은 적이 없어 "저장은 되는데 읽을 길이 없다"는 상태이기도
    했다). 크기 문제는 응답 shape이 아니라 저장 시점 범위 상한으로 막는다(PO: 지금은 하드
    리밋 없이 로그만, 실사용 뒤 정한다)."""
    if direction != "outgoing":
        raise HTTPException(status_code=400, detail="direction must be 'outgoing' (incoming: use /backlinks)")

    story = await repo.get(id)
    if story is None:
        raise HTTPException(status_code=404, detail="Story not found")
    await _assert_story_project_access(repo.session, auth, repo.org_id, story.project_id)

    from app.models.reference import Reference
    from app.services.reference_core import list_references

    raw_targets = (await repo.session.execute(
        select(Reference.target_type, Reference.target_id, Reference.proof_payload).where(
            Reference.org_id == repo.org_id, Reference.source_type == "story", Reference.source_id == id,
        )
    )).all()
    ids_by_type: dict[str, set[uuid.UUID]] = {}
    conversation_id_by_target_id: dict[uuid.UUID, uuid.UUID] = {}
    for target_type, target_id, proof_payload in raw_targets:
        ids_by_type.setdefault(target_type, set()).add(target_id)
        if target_type == "chat_message" and proof_payload and proof_payload.get("conversation_id"):
            conversation_id_by_target_id[target_id] = uuid.UUID(str(proof_payload["conversation_id"]))

    caller_id = uuid.UUID(str(auth.user_id))
    visible = await _visible_target_ids(
        repo.session, repo.org_id, caller_id, ids_by_type, auth, conversation_id_by_target_id,
    )

    refs = await list_references(
        repo.session, org_id=repo.org_id, entity_type="story", entity_id=id,
        direction="outgoing", visible_ids_by_type=visible,
    )

    # story #2269(C-11) AC0-2 축B(2026-07-29, PO 지적): 「#<번호> 관찰 수집(축A, #2643)」만
    # 해서는 화면에 아무것도 안 뜬다 — render-time 치환에 필요한 번호→story_id 매핑을 이
    # 응답에 함께 싣는다. description+acceptance_criteria 둘 다 스캔해 하나로 합친다(번호는
    # project 스코프라 필드와 무관하게 항상 같은 대상을 가리킨다). ⛔대괄호 참조(위 `refs`)와
    # 달리 이 매핑은 가시성(visible) 필터를 거치지 않는다 — story는 이 write-path가 project
    # 안에서만 해소하므로(project_id 스코프 자체가 가시성 경계와 같다) 별도 존재-비노출
    # 판정이 이미 필요 없다(C-3 원칙과 충돌하지 않음 — target이 항상 caller와 같은 project다).
    from app.services.mention_parser import resolve_bare_number_story_targets

    bare_number_targets: dict[int, uuid.UUID] = {}
    for field_text in (story.description, story.acceptance_criteria):
        if not field_text:
            continue
        resolved = await resolve_bare_number_story_targets(
            repo.session, org_id=repo.org_id, project_id=story.project_id, content=field_text,
        )
        bare_number_targets.update(resolved)

    return {
        "data": [
            {
                "id": str(r.id),
                "form": r.form,
                "target_type": r.target_type,
                "target_id": str(r.target_id),
                # story #2262 AC1(「지점」, PO 판정 2026-07-30): 「이 참조가 언제 생겼나」이지
                # 「대상이 언제 만들어졌나」가 아니다 — mention_parser.fetch_stored_references()는
                # 이미 referenced_at으로 나가는데(conversations.py 소비), 이 라우트(story의
                # outgoing references)는 reference_core.list_references()를 써서 이름이 안 바뀐
                # 채 남아 있었다(실 dev GET으로 발견 — 본문의 "이미 반환한다"는 처방이지 현재
                # 상태가 아니었다).
                "referenced_at": r.created_at.isoformat(),
                "still_exists": r.still_exists,
                "proof_payload": r.proof_payload,
            }
            for r in refs
        ],
        "bare_number_targets": {str(number): str(story_id) for number, story_id in bare_number_targets.items()},
    }


class CreateStoryProofReferenceRequest(BaseModel):
    """story #2263 AC6(2026-07-29, 오르테가 판정) — C-7(#2265) 「선택→저장」 전용 write
    계약. 지금은 target=chat_message·form=proof 조합 하나만 지원한다(다른 target_type/form은
    이 라우트가 필요해지면 그때 넓힌다 — #2260/#2261이 반복한 "안 쓰는 라우터 미리 짓지
    않는다" 원칙과 동형)."""

    target_type: str
    target_id: uuid.UUID
    form: str
    proof_payload: dict


@router.post("/{id}/references", status_code=201)
async def create_story_proof_reference(
    id: uuid.UUID,
    body: CreateStoryProofReferenceRequest,
    repo: StoryRepository = Depends(_get_repo),
    auth: AuthContext = Depends(get_current_user),
) -> dict:
    """POST /api/v2/stories/{id}/references — story #2263 AC6 후속(2026-07-29, 오르테가
    판정): `insert_reference`가 프로덕션 호출부 0건이라 C-7(#2265, 대화 조각 인용)이 저장할
    라우트가 없었다 — 그 첫 write 소비자를 연다. 읽기(GET /{id}/references)와 같은 PR —
    write→read 왕복이 그 안에서 증명된다.

    지금은 target_type="chat_message"·form="proof" 조합만 지원(위 스키마 docstring 참조) —
    그 밖은 명시 400(조용한 무시 금지).

    권한 셋:
    ①source(이 story)는 get_story_backlinks/GET references와 동일 게이트
      (`_assert_story_project_access`, #2322 통일).
    ②target(인용되는 conversation) — 그 대화를 못 읽는 사람이 조각을 박으면 안 된다(PO
      판정) — `conversations._can_read_conversation`(canonical 단건 predicate, SSOT 재사용
      — 새 인증경로 발명 없음)로 `proof_payload["conversation_id"]`를 검사한다.
    ③범위 상한 — C-7 규격("증거이지 대화 사본이 아니다")이 있으나 PO가 숫자를 아직 안
      박았다(2026-07-29: "일단 안 막되 크기를 로그로 남긴다, 실사용 뒤 정한다") — 그래서
      여기서 하드 리밋을 걸지 않고 `logger.info`로 snapshot 길이만 남긴다."""
    if body.target_type != "chat_message" or body.form != "proof":
        raise HTTPException(
            status_code=400,
            detail="이 라우트는 지금 target_type='chat_message'·form='proof' 조합만 지원합니다",
        )

    conversation_id = body.proof_payload.get("conversation_id")
    if not conversation_id:
        raise HTTPException(status_code=400, detail="proof_payload.conversation_id is required")

    story = await repo.get(id)
    if story is None:
        raise HTTPException(status_code=404, detail="Story not found")
    await _assert_story_project_access(repo.session, auth, repo.org_id, story.project_id)

    from app.routers.conversations import _can_read_conversation

    can_read = await _can_read_conversation(
        uuid.UUID(str(conversation_id)), repo.session, auth, repo.org_id,
    )
    if not can_read:
        raise HTTPException(status_code=404, detail="Conversation not found")

    snapshot = body.proof_payload.get("snapshot") or []
    logger.info(
        "create_story_proof_reference: story=%s snapshot_messages=%d", id, len(snapshot),
    )

    from app.services.reference_core import insert_reference

    caller_id = uuid.UUID(str(auth.user_id))
    ref = await insert_reference(
        repo.session, org_id=repo.org_id, source_type="story", source_field="proof",
        source_id=id, target_type=body.target_type, target_id=body.target_id,
        form=body.form, created_by=caller_id, proof_payload=body.proof_payload,
    )
    await repo.session.commit()

    return {
        "id": str(ref.id),
        "form": ref.form,
        "target_type": ref.target_type,
        "target_id": str(ref.target_id),
        "created_at": ref.created_at.isoformat(),
        "proof_payload": ref.proof_payload,
    }


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
# 채팅 없이 board/API 서 안다(FE S11 데이터 소스). 없는 story 404·active 없으면 terminal 5개
# history·engine_degraded/grandfathered 명시.
# story #2245(형제 비대칭): org-scope만으론 불충분하다 — 바로 위 get_story가 이미 그걸 알고
# _assert_story_project_access를 추가로 부른다. 이 엔드포인트만 org-scope에서 멈춰 있었다.
@router.get("/{id}/workflow-line/status", response_model=WorkflowLineStatusResponse)
async def get_workflow_line_status(
    id: uuid.UUID,
    repo: StoryRepository = Depends(_get_repo),
    auth: AuthContext = Depends(get_current_user),
) -> WorkflowLineStatusResponse:
    story = await repo.get(id)  # org-scoped·scope 밖/없으면 None→404
    if story is None:
        raise HTTPException(status_code=404, detail="Story not found")
    await _assert_story_project_access(repo.session, auth, repo.org_id, story.project_id)
    return await build_workflow_line_status(repo.session, repo.org_id, id)


class FallbackNotifyRequest(BaseModel):
    step_run_id: uuid.UUID


# E-DG S12 Gap2: stuck handoff fallback human notification. 없는 story 404·dispatch_notification
# 재사용·idempotent(run당 1회·already_notified)·status rollback 0.
# story #2245(형제 비대칭 — 쓰기): _get_repo가 org-scope만 걸어 project 접근권 검사가 없었다.
# 형제 get_story/get_workflow_line_status와 동일 가드(_assert_story_project_access) 재사용.
@router.post("/{id}/workflow-line/fallback-notify")
async def workflow_line_fallback_notify(
    id: uuid.UUID,
    body: FallbackNotifyRequest,
    repo: StoryRepository = Depends(_get_repo),
    auth: AuthContext = Depends(get_current_user),
) -> dict:
    story = await repo.get(id)
    if story is None:
        raise HTTPException(status_code=404, detail="Story not found")
    await _assert_story_project_access(repo.session, auth, repo.org_id, story.project_id)
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
# story #2245(형제 비대칭 — 쓰기): _get_repo가 org-scope만 걸어 project 접근권 검사가 없었다.
# 형제 get_story/get_workflow_line_status와 동일 가드(_assert_story_project_access) 재사용 —
# requester/owner/admin(아래 withdraw_pending_run 내부 판정)보다 먼저, project 접근권 자체가
# 없으면 그 판정에 도달하지도 못하게 한다.
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
    await _assert_story_project_access(repo.session, auth, repo.org_id, story.project_id)
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
    # ⛔story #2346 AC7: allow_shrink는 stories 컬럼이 아니므로 repo.update 전에 분리(assignee_ids와 동형).
    allow_shrink = data.pop("allow_shrink", False)
    # E-BOARD S5: assignee_ids는 stories 컬럼이 아니므로 repo.update 전에 분리.
    assignee_ids_in = data.pop("assignee_ids", None)
    # assignee_ids만 제공되면 단일 assignee_id(주담당)를 첫 요소로 동기화 → 기존 event/notify 로직 재사용.
    if assignee_ids_in is not None and "assignee_id" not in data:
        data["assignee_id"] = assignee_ids_in[0] if assignee_ids_in else None
    old_assignee_id: uuid.UUID | None = None
    old_position: int | None = None
    old_field_lengths: dict[str, int] = {}
    story_before = None
    # story #2172 AC2: position 변경도 old-value 대조가 필요해 assignee_id와 같은 사전조회를 공유.
    # story #2346 AC3: 긴 텍스트 필드 급감 기록도 같은 사전조회(repo.update() 前 old 값)가 필요.
    if "assignee_id" in data or "position" in data or any(f in data for f in _LENGTH_TRACKED_FIELDS):
        story_before = await repo.get(id)
        if story_before:
            old_assignee_id = story_before.assignee_id
            old_position = story_before.position
            # ⛔story_before는 같은 세션의 identity map이라 repo.update() 뒤 story와 «같은
            # 객체»가 된다(속성이 그 자리서 덮어써짐) — old_assignee_id/old_position처럼
            # «스칼라 값»으로 지금 떠 둬야 update 前 값을 실제로 보존한다.
            for _f in _LENGTH_TRACKED_FIELDS:
                if _f in data:
                    old_field_lengths[_f] = len(getattr(story_before, _f) or "")
    # ⛔story #2346 AC7: 긴 텍스트 필드가 50% 이상 줄면 거부 — 오늘 실제 3건 사고(모두 -80%대)가
    # 전부 이 게이트에 막혔을 것이다. allow_shrink=true로 명시 승인(정당한 축약)만 통과.
    if old_field_lengths and not allow_shrink:
        for _f, _before_len in old_field_lengths.items():
            if _before_len == 0:
                continue
            _after_len = len(data.get(_f) or "")
            _lost_chars = _before_len - _after_len
            _is_relative_shrink = _after_len < _before_len * (1 - _SHRINK_BLOCK_THRESHOLD)
            if _is_relative_shrink and _lost_chars >= _SHRINK_BLOCK_MIN_LOST_CHARS:
                # ⛔story #2346(PO 2026-07-30 08:12Z): 「가드 신호를 사용자 숙제로 번역하지
                # 않는다」— 「거부되었습니다」만 오면 포기하거나 우회한다. «무엇이»(story_number)
                # «어디가»(필드명) «얼마나»(전→후 길이) 줄었는지와 «다음에 뭘 할지»
                # (allow_shrink=true)를 한 메시지 안에 전부 싣는다 — #2342형 대상 혼동 사고를
                # 그 자리서 보이게 하는 목적도 겸한다.
                raise HTTPException(
                    status_code=400,
                    detail=(
                        f"#{story_before.story_number} {_f} shrank {_before_len}→{_after_len} chars "
                        f"({round((1 - _after_len / _before_len) * 100)}% smaller) — "
                        "if intentional, resend with allow_shrink=true"
                    ),
                )
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

    # story #2301(E-CONNECT, 오르테가 판정 2026-07-29): story 본문/AC의 `#` 엔티티 토큰이
    # 저장 시 entity_references로 걷히지 않던 갭(#2597이 FE 삽입 UI만 열고 BE 파서가 아예
    # 없었다) — insert_chat_mentions·reconcile_doc_mentions를 병합한 공용 코어
    # `reconcile_entity_references`를 직접 호출한다(AC1: story 전용 write 헬퍼를 새로
    # 만들지 않는다). description과 acceptance_criteria는 **서로 다른 source_field**라
    # 각각 독립적으로 reconcile — 같은 대상을 본문과 AC 양쪽에 걸면 두 행 다 남는다(멱등
    # 키에 source_field가 있어 서로 다른 참조로 선다). **같은 트랜잭션**(commit 전, 실패
    # 시 예외 propagate로 story 저장 전체가 롤백 — chat/doc과 동일 AC4 원자성).
    # ⛔실제 reconcile·candidate 로직은 `_reconcile_story_references_and_candidates`
    # (create_story와 공유) — 2026-07-30, create에 이 훅이 없던 결함 수정 시 두 벌 대신
    # 공용 함수로 추출.
    if "description" in data or "acceptance_criteria" in data:
        _mention_actor_id: uuid.UUID | None = None
        try:
            _mention_actor_id = await _resolve_team_member_id(auth, repo.org_id, db)
        except Exception:
            _mention_actor_id = None
        await _reconcile_story_references_and_candidates(
            db, org_id=repo.org_id, story=story,
            check_description="description" in data,
            check_acceptance_criteria="acceptance_criteria" in data,
            mention_actor_id=_mention_actor_id,
        )

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
        _context: dict = {"fields": list(data.keys()), "story_title": story.title}
        # ⛔story #2346 AC3(2026-07-30): 「지워졌는지 원래 없었는지 구분할 수단이 없다」던
        # 갭 — 전문 스냅샷은 비싸 「이전 길이 → 이후 길이」만 남긴다. 길이가 «안 변한» 경우엔
        # 안 남긴다(양성 대조 — 매번 남으면 로그가 잡음이 된다). docs.py·agent_runs.py는
        # 아직 activity 로깅 자체가 없어 미착수 — #2346 본문에 남은 항목으로 적어 둔다.
        if old_field_lengths:
            _length_changes = {}
            for _f, _before_len in old_field_lengths.items():
                _after_len = len(getattr(story, _f) or "")
                if _before_len != _after_len:
                    _length_changes[_f] = {"before": _before_len, "after": _after_len}
            if _length_changes:
                _context["length_changes"] = _length_changes
        background_tasks.add_task(
            record_activity_bg,
            org_id=repo.org_id,
            action="story_updated",
            actor_id=actor_id,
            project_id=story.project_id,
            entity_type="story",
            entity_id=id,
            context=_context,
        )

    await _attach_assignee_ids(db, repo.org_id, [story])
    await _attach_has_evidence(db, [story])
    # story #2459 prod 회귀(2026-08-05): model_validate는 동기 호출이라 story의 어떤 컬럼이
    # unloaded 상태면(원인 미확定 — repo.update()가 flush+refresh 直後인데도 관측됨)
    # MissingGreenlet 500(await_only 호출 불가 — sync 컨텍스트에서 lazy load 시도)으로
    # 죽는다. 직렬화 直前 명시 refresh로 db가 아직 살아있는 async 컨텍스트에서 강제 재로드
    # — 어떤 경로로 unload되든 안전(포지티브 컨트롤: test_2459_regression_full_request_cycle_
    # realdb.py::test_update_story_survives_forced_attribute_expiry_before_serialize).
    await db.refresh(story)
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
    # story #2459 prod 회귀(2026-08-05): update_story와 동형 — model_validate 直前 명시
    # refresh로 unloaded 컬럼(예: updated_at) MissingGreenlet 500을 막는다.
    await db.refresh(story)
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

    story #2428: 그 "정본"이 사실 `created_at` 단독 정렬+cursor였다 — 동률(같은 created_at)
    두 행이 페이지 경계에 걸치면 행이 누락/중복될 수 있었다(docs.py encode_doc_cursor·
    backlinks.py encode_cursor가 각자 발견해 고친 것과 동형 결함인데 이 "정본"엔 한 번도
    안 돌아갔었다). `app.core.pagination`의 (created_at, id) 복합 cursor로 이관 — 순수
    리팩터가 아니라 수정이다. 기존(단독 평문) cursor는 이제 무효이며 `decode_cursor`가
    명시로 거부한다(조용히 재해석해 틀린 페이지를 주지 않는다).
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
    # #2540 CI 교훈(오르테가군): "값이 있는지"만 보면 안 되고 "그 값이 문자열인지"까지 봐야
    # 한다 — 이 함수를 FastAPI DI 없이 직접 호출하며 cursor= 를 누락하면 파이썬 기본값인
    # Query(...) 센티넬 객체(truthy) 가 그대로 들어온다. 문자열이 아니면 커서 없음으로 취급.
    if isinstance(cursor, str) and cursor:
        cursor_dt, cursor_id = decode_cursor(cursor)
        q = q.where(tuple_(StoryComment.created_at, StoryComment.id) < tuple_(cursor_dt, cursor_id))
    q = q.order_by(StoryComment.created_at.desc(), StoryComment.id.desc()).limit(limit + 1)
    result = await db.execute(q)
    rows = list(result.scalars())
    page, has_more, next_cursor = assemble_page(rows, limit, lambda r: (r.created_at, r.id))
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


@router.post("/{id}/request-verification", response_model=GateResponse, status_code=201)
async def request_verification(
    id: uuid.UUID,
    db: AsyncSession = Depends(get_db),
    repo: StoryRepository = Depends(_get_repo),
    auth: AuthContext = Depends(get_current_user),
) -> GateResponse:
    """story #2258 — 검증요청: 제네릭 게이트 생성(POST /api/v2/gates)은 이미 있었는데(work_item_type
    무관) FE가 story에서 부르는 곳이 0곳이었다(member_id/role_id를 client가 알아야 해 실질적으로
    막혀 있었음). doc.py::transition_doc이 doc_approval 게이트를 상신 시 자동 생성하는 것과
    동형 패턴 — 여기서도 role_id를 서버가 `_default_role_id`로 해소해 client가 아무것도 몰라도
    되게 한다. gate_type="qa"(GATE_TYPES 중 「검증」에 가장 가까운 값). create_gate 자체가 멱등
    (재요청 시 기존 pending 재사용, rejected는 자동 재오픈)이라 여기서 별도 처리 불필요.
    """
    story = await repo.get(id)
    if story is None:
        raise HTTPException(status_code=404, detail="Story not found")
    await _assert_story_project_access(repo.session, auth, repo.org_id, story.project_id)

    from app.services.gate_service import create_gate
    from app.services.workflow_line_config import _default_role_id

    member_id = await _resolve_team_member_id(auth, repo.org_id, db)
    role_id = await _default_role_id(db, repo.org_id) or story.id
    gate = await create_gate(
        db, repo.org_id, story.id, "story", "qa",
        member_id, role_id,
        neutral_facts={"requested_by_member_id": str(member_id), "story_title": story.title},
        project_id=story.project_id,
    )
    await db.commit()
    # story #2459 회귀 동형 방어(2026-08-05): commit 後 model_validate 前 명시 refresh.
    await db.refresh(gate)
    return GateResponse.model_validate(gate)


# ─── Activities ───────────────────────────────────────────────────────────────

@router.get("/{id}/activities")
async def list_activities(
    id: uuid.UUID,
    limit: int = Query(default=20, le=100),
    cursor: str | None = Query(default=None),
    db: AsyncSession = Depends(get_db),
    repo: StoryRepository = Depends(_get_repo),
    auth: AuthContext = Depends(get_current_user),
) -> dict:
    """story #2247: FE(story-detail-panel.tsx)의 「더보기」가 이미 완결돼 기다리고 있었는데
    이 엔드포인트에 cursor 자체가 없어 원천적으로 도달 불가였다(#2231 표 CAPPED-NO-NEXT-PAGE).
    #2231 정본 규약 A(limit+1 오버페치 + has_more/next_cursor body meta, 참조 구현:
    stories.py::list_comments — #2230에서 이미 같은 처방을 받은 형제 엔드포인트)로 도달 가능하게 한다.

    story #2428: list_comments와 동형 결함(단독 created_at cursor, 동률 시 페이지 경계
    누락/중복) — (created_at, id) 복합 cursor로 이관. 순수 리팩터 아님, 기존 cursor 무효화.
    """
    # SEC(story #2206) — list_comments(1339)와 동형 갭·동형 처방. 자세한 사유는 그쪽 주석 참조.
    story = await repo.get(id)
    if story is None:
        raise HTTPException(status_code=404, detail="Story not found")
    await _assert_story_project_access(repo.session, auth, repo.org_id, story.project_id)
    q = select(StoryActivity).where(StoryActivity.story_id == id)
    # #2540 CI 교훈(오르테가군): "값이 있는지"만 보면 안 되고 "그 값이 문자열인지"까지 봐야
    # 한다 — 이 함수를 FastAPI DI 없이 직접 호출하며 cursor= 를 누락하면 파이썬 기본값인
    # Query(...) 센티넬 객체(truthy) 가 그대로 들어온다. 문자열이 아니면 커서 없음으로 취급.
    if isinstance(cursor, str) and cursor:
        cursor_dt, cursor_id = decode_cursor(cursor)
        q = q.where(tuple_(StoryActivity.created_at, StoryActivity.id) < tuple_(cursor_dt, cursor_id))
    q = q.order_by(StoryActivity.created_at.desc(), StoryActivity.id.desc()).limit(limit + 1)
    result = await db.execute(q)
    rows = list(result.scalars())
    page, has_more, next_cursor = assemble_page(rows, limit, lambda r: (r.created_at, r.id))
    return {
        "data": [ActivityResponse.model_validate(r) for r in page],
        "meta": {"has_more": has_more, "next_cursor": next_cursor},
    }
