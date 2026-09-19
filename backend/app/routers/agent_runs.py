import logging
import uuid
from datetime import datetime, timedelta, timezone
from typing import Literal

from fastapi import APIRouter, BackgroundTasks, Depends, HTTPException, Query, Response
from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.dependencies.auth import AuthContext, get_current_user, get_verified_org_id
from app.dependencies.database import get_db
from app.models.agent_run_tool_call import AgentRunToolCall
from app.models.pm import Story
from app.models.project import Project
from app.models.team import TeamMember
from app.repositories.agent_run import AgentRunRepository
from app.schemas.agent_run import AgentRunResponse, CancelAgentRun, CreateAgentRun, UpdateAgentRun
from app.schemas.agent_run_tool_call import AgentRunToolCallResponse
from app.services.agent_run_lifecycle import AGENT_RUN_TIMEOUT_HOURS

router = APIRouter(prefix="/api/v2/agent-runs", tags=["agent-runs", "Work"])
logger = logging.getLogger(__name__)

# story #2161(원 3값) + story #3961(「정지」 액션, PO 확定 2026-09-16) — cancelled·
# cancelled_unacknowledged도 종결(그 run은 더 이상 진행 중이 아니다·finished_at 채움).
# cancel_requested는 **종결이 아니다**(아직 ack/타임아웃 대기 中 — _CANCELLABLE_STATUSES
# 참조) — PATCH가 이 상태들로 전이시키는데 클라가 finished_at을 안 보내면 서버가 채운다.
_TERMINAL_STATUSES = {"completed", "failed", "abandoned", "cancelled", "cancelled_unacknowledged"}

# story #3680 — list_agent_runs `status=` 필터의 유효값 집합. DB CHECK 제약
# (agent_runs_status_check, alembic/versions/0207_agent_runs_status_check_widen.py·
# 0379_agent_run_cancel_protocol.py가 3961의 cancel_requested/cancelled/
# cancelled_unacknowledged로 확장)이 이미 정본으로 갖고 있는 10값 그대로(신규 정의 0) —
# Literal이라 FastAPI가 불명값을 자동 422(코드 발명 없이, 이 스토리의 「불명값 422」 AC를
# 그대로 만족).
_AGENT_RUN_STATUS_VALUES = Literal[
    "queued", "held", "running", "hitl_pending", "completed", "failed", "abandoned",
    "cancel_requested", "cancelled", "cancelled_unacknowledged",
]

# story #3961 — 중단 요청이 가능한 "아직 살아있는" 상태(cancel_requested 자신은 제외 —
# 이미 요청 中인 run에 또 요청하면 requested_at/reason이 조용히 덮이는 혼란을 막는다,
# 409로 명시 거부).
_CANCELLABLE_STATUSES = {"queued", "held", "running", "hitl_pending"}

# story #3961(PO 확定 2026-09-16) — 자기보고 타이밍이 무보장(이 저장소에 고정 폴링 계약
# 0, AC1 그라운딩)이라 5분은 너무 짧아 "정상 진행 중인데 미응답으로 오판"이 흔해질 것 —
# 15분 지나면 "사람이 다른 손을 써야 한다"는 뜻으로 승격. PO 정의: unacknowledged는
# 드문 실패가 아니라 정상 결과(후속 자동화 0) — 화면 낱말도 「멈춤 요청함 · 아직 응답
# 없음」(실패 낱말 금지).
_CANCEL_ACK_TIMEOUT_MINUTES = 15


def _effective_cancel_outcome(
    status: str, cancel_requested_at: datetime | None, *, now: datetime | None = None,
) -> str | None:
    """story #3961 — status/cancel_requested_at만으로 "지금 시점 기준 만료됐는가"를 순수
    계산(부작용 0, DB 쓰기 없음). today_service.py의 read-only 집계(1콜·N+1 0 유지)와
    단건 엔드포인트의 lazy 확定(_expire_cancel_request_if_due, 실제 UPDATE)이 이 함수
    하나를 공유한다 — 판정 기준이 두 곳에서 갈릴 수 없다."""
    if status != "cancel_requested" or cancel_requested_at is None:
        return None
    _now = now or datetime.now(timezone.utc)
    elapsed = _now - cancel_requested_at
    if elapsed >= timedelta(minutes=_CANCEL_ACK_TIMEOUT_MINUTES):
        return "unacknowledged"
    return "requested"


async def _expire_cancel_request_if_due(repo: AgentRunRepository, run):
    """story #3961 AC1 처방("만료 판정 — 워커 tick 또는 읽기 시점 lazy") — 신규 워커 0,
    단건 조회/수정 경로(get_agent_run·update_agent_run·cancel_agent_run)에서 읽을 때마다
    확認. 만료면 실제로 cancelled_unacknowledged로 확定(PO 「서버가 확定한다」 표현 그대로 —
    계산값만 보여주고 DB는 그대로 두지 않는다) + finished_at·cancel_outcome 기록."""
    if _effective_cancel_outcome(run.status, run.cancel_requested_at) != "unacknowledged":
        return run
    now = datetime.now(timezone.utc)
    updated = await repo.update(
        run.id, status="cancelled_unacknowledged", finished_at=now, cancel_outcome="unacknowledged",
    )
    return updated or run

# story #2346 AC3(범위: 기록만) — 「긴 텍스트 필드」 정의, stories.py/docs.py와 동형.
_LENGTH_TRACKED_FIELDS = ("result_summary", "last_error_code")
# ⛔story #2346 AC7을 여기 «의도적으로» 안 넣는다 — 넣지 않는 것 자체가 판단이라 이유를 남긴다.
# stories.py/docs.py와 달리 이 라우터는 status 전이(_TERMINAL_STATUSES)와 얽혀 있다: 진행 중
# 요약("작업 중... X... Y...")이 완료 시 짧고 확정적인 요약("완료: Z")으로 «의도적으로» 줄어드는
# 것이 정상 흐름이다. stories.py의 급감 차단(50%+절대손실100자)을 그대로 이식하면 이 legitimate
# 축약이 매번 막혀 allow_shrink=true를 상시 붙여야 하는 잡음이 된다(PO 판정 2026-08-02) — AC3
# (기록)만으로 범위를 좁힌다. 나중에 이 라우터에 AC7을 넣고 싶으면 «완료 시 축약»과 «중간에
# 읽지 않고 덮어씀」을 가르는 별도 판별자부터 세워야 한다(이 코멘트를 지우지 말 것).


def _get_repo(session: AsyncSession = Depends(get_db)) -> AgentRunRepository:
    return AgentRunRepository(session)


@router.get("", response_model=list[AgentRunResponse])
async def list_agent_runs(
    response: Response,
    project_id: uuid.UUID = Query(...),
    agent_id: uuid.UUID | None = Query(default=None),
    story_id: uuid.UUID | None = Query(default=None),
    status: _AGENT_RUN_STATUS_VALUES | None = Query(default=None),
    from_: str | None = Query(default=None, alias="from"),
    to: str | None = Query(default=None),
    limit: int = Query(default=50, ge=1, le=200),
    cursor: str | None = Query(default=None),
    session: AsyncSession = Depends(get_db),
    org_id: uuid.UUID = Depends(get_verified_org_id),
    auth: AuthContext = Depends(get_current_user),
    repo: AgentRunRepository = Depends(_get_repo),
) -> list[AgentRunResponse]:
    """prod 핫픽스(S20 전수스캔 — create_agent_run과 동일 클래스): project_id가 caller org
    소속인지 검증 없이 임의 project의 agent run 목록을 열람할 수 있었다(cross-org).

    E-SECURITY SEC-S8(story 83ea3d6a) Y(까심 전수스윕): org-scope는 이미 닫혔으나 caller의
    실제 project 접근권(has_project_access)은 검증하지 않아, 같은 org 다른 project 멤버가
    project_id만 알면 그 project의 agent run을 열람할 수 있었다(G-class).

    story_id(story 7a7f6c36·Workcell 실 run 배선): 위 project 가드가 통과한 뒤, 이미
    project-bound된 run 집합을 story 단위로 좁히는 옵션 narrowing 필터. AND 축소라 결과를
    확장할 수 없고(A AND B ⊆ A) 신규 인가 축이 아니다 — 타 project story_id를 넣어도 그
    project agent의 run은 이 집합 밖이라 0건.

    story #3680(BE·결함) — 그라운딩(2026-09-07): 이 엔드포인트가 지금껏 `status`/`from`/
    `to`를 아예 안 받았다. FastAPI가 미선언 쿼리 파라미터를 조용히 버리므로(422도 아니고
    무시) `?status=failed`가 200으로 completed 행을 그대로 돌려주는 "오타로 써도 통과하나"
    클래스였다. `status`는 `agent_runs_status_check`(alembic 0207) DB CHECK가 이미 갖고
    있는 7값 그대로 `Literal`로 못박아 — 유효값 밖은 FastAPI가 자동 422(신규 코드 0).
    `from`/`to`는 ISO 8601(cursor와 동형 파싱·400)·`from>to`는 422(입력 자체가 모순).

    story #3851(BE·목록 상한) — X-Total-Count·X-Next-Cursor(story #3841/goals.py·
    retros.py와 동일 헤더 계약, /{id}/tool-calls의 X-Total-Count 선례를 이 목록
    라우트에도 이식). total은 cursor 適用 後 남은 개수(base.py 관례 그대로 — cursor
    前 grand total이 아니다). 바디는 그대로 bare list(봉투 변경 0) — 기존 소비처
    (FE·MCP)가 무변경으로 첫 페이지를 받는다."""
    from app.services.project_auth import has_project_access

    proj_r = await session.execute(select(Project.id).where(Project.id == project_id, Project.org_id == org_id))
    if proj_r.scalar_one_or_none() is None:
        raise HTTPException(status_code=404, detail="Project not found")
    if not await has_project_access(session, uuid.UUID(auth.user_id), project_id, org_id):
        raise HTTPException(status_code=403, detail="No access to this project")
    # 까심 부수발견(HIGH): cursor는 ISO created_at 문자열인데 repo가 timestamptz 컬럼에
    # varchar로 직비교해 asyncpg 캐스팅 실패(DataError)→500이었다. HTTP 계층에서 datetime으로
    # 파싱해 timestamptz 파라미터로 바인딩하고, 비-ISO cursor는 400으로 명시(500·조용한 무시 금지).
    cursor_dt: datetime | None = None
    if cursor:
        try:
            cursor_dt = datetime.fromisoformat(cursor)
        except ValueError:
            raise HTTPException(status_code=400, detail="Invalid cursor (expected ISO 8601 datetime)")
    from_dt: datetime | None = None
    if from_:
        try:
            from_dt = datetime.fromisoformat(from_)
        except ValueError:
            raise HTTPException(status_code=400, detail="Invalid from (expected ISO 8601 datetime)")
        if from_dt.tzinfo is None:
            from_dt = from_dt.replace(tzinfo=timezone.utc)
    to_dt: datetime | None = None
    if to:
        try:
            to_dt = datetime.fromisoformat(to)
        except ValueError:
            raise HTTPException(status_code=400, detail="Invalid to (expected ISO 8601 datetime)")
        if to_dt.tzinfo is None:
            to_dt = to_dt.replace(tzinfo=timezone.utc)
    if from_dt is not None and to_dt is not None and from_dt > to_dt:
        raise HTTPException(status_code=422, detail="from must not be after to")
    runs, total = await repo.list(
        project_id=project_id, agent_id=agent_id, story_id=story_id, status=status,
        from_dt=from_dt, to_dt=to_dt, limit=limit, cursor=cursor_dt,
    )
    response.headers["X-Total-Count"] = str(total)
    if runs:
        response.headers["X-Next-Cursor"] = runs[-1].created_at.isoformat()
    name_map = await _agent_name_map(session, {r.agent_id for r in runs})
    return [
        AgentRunResponse.model_validate(r).model_copy(update={"agent_name": name_map.get(r.agent_id)})
        for r in runs
    ]


@router.get("/{id}", response_model=AgentRunResponse)
async def get_agent_run(
    id: uuid.UUID,
    session: AsyncSession = Depends(get_db),
    org_id: uuid.UUID = Depends(get_verified_org_id),
    auth: AuthContext = Depends(get_current_user),
    repo: AgentRunRepository = Depends(_get_repo),
) -> AgentRunResponse:
    """story #4725d9c0(라이브 결함, 유나 배포 53) — 이 라우터에 단건 GET이 아예 없어(GET ""·
    POST ""·PATCH "/{id}"만 존재) 상세 화면이 405를 받았다(BFF는 이미 이 경로를 부르고
    있었다 — 구조적 미도달). PATCH와 동일 인가축(org 검증 후 has_project_access) — 존재하지
    않거나 타org·무접근권은 전부 404(비노출 관례)."""
    from app.services.project_auth import has_project_access

    run = await repo.get(id)
    if run is None or run.org_id != org_id:
        raise HTTPException(status_code=404, detail="Agent run not found")
    if not await has_project_access(session, uuid.UUID(auth.user_id), run.project_id, org_id):
        raise HTTPException(status_code=404, detail="Agent run not found")
    run = await _expire_cancel_request_if_due(repo, run)
    name_map = await _agent_name_map(session, {run.agent_id})
    return AgentRunResponse.model_validate(run).model_copy(update={"agent_name": name_map.get(run.agent_id)})


@router.get("/{id}/tool-calls", response_model=list[AgentRunToolCallResponse])
async def list_agent_run_tool_calls(
    response: Response,
    id: uuid.UUID,
    limit: int = Query(default=50, ge=1, le=200),
    cursor: str | None = Query(default=None),
    session: AsyncSession = Depends(get_db),
    org_id: uuid.UUID = Depends(get_verified_org_id),
    auth: AuthContext = Depends(get_current_user),
    repo: AgentRunRepository = Depends(_get_repo),
) -> list[AgentRunToolCallResponse]:
    """story #3722(Trust·BE) — AgentRunResponse엔 안 싣는다(크기·조회 축 분리, PO 確定).
    같은 인가축(get_agent_run과 동일 — org 검증 후 has_project_access, 없거나 타org·
    무접근권은 404). 최신순(created_at DESC) — cursor는 이전 페이지 마지막 행의
    created_at(ISO 8601), list_agent_runs의 커서 관례와 동형.

    X-Total-Count(페드루 PO 追加 2026-09-09) — run_id 기준 전체 건수(limit 適用 前,
    cursor 페이지와 무관) — 3703/3706류(«한 페이지=전부」 오판) 재발 방지, goals.py
    list_goals와 동형 관례."""
    from app.services.project_auth import has_project_access

    run = await repo.get(id)
    if run is None or run.org_id != org_id:
        raise HTTPException(status_code=404, detail="Agent run not found")
    if not await has_project_access(session, uuid.UUID(auth.user_id), run.project_id, org_id):
        raise HTTPException(status_code=404, detail="Agent run not found")

    cursor_dt: datetime | None = None
    if cursor:
        try:
            cursor_dt = datetime.fromisoformat(cursor)
        except ValueError:
            raise HTTPException(status_code=400, detail="Invalid cursor (expected ISO 8601 datetime)")

    total = (await session.execute(
        select(func.count()).select_from(AgentRunToolCall).where(AgentRunToolCall.run_id == id)
    )).scalar_one()
    response.headers["X-Total-Count"] = str(total)

    q = select(AgentRunToolCall).where(AgentRunToolCall.run_id == id)
    if cursor_dt is not None:
        q = q.where(AgentRunToolCall.created_at < cursor_dt)
    q = q.order_by(AgentRunToolCall.created_at.desc()).limit(limit)
    rows = list((await session.execute(q)).scalars().all())
    return [AgentRunToolCallResponse.model_validate(r) for r in rows]


async def _agent_name_map(session: AsyncSession, agent_ids: set[uuid.UUID]) -> dict[uuid.UUID, str]:
    """story #4725d9c0 — team_members는 멀티프로젝트 grant면 같은 id가 N행(VIEW)이지만 name은
    멤버 전역값이라 dict 축약이 안전(같은 키에 같은 값 재기록뿐). 못 찾는 id는 그냥 dict에 없다
    (호출부가 .get(...)으로 None 처리 — 지어내지 않는다)."""
    if not agent_ids:
        return {}
    result = await session.execute(select(TeamMember.id, TeamMember.name).where(TeamMember.id.in_(agent_ids)))
    return {row[0]: row[1] for row in result.all()}


async def _validate_conversation_link(
    session: AsyncSession, *, org_id: uuid.UUID,
    conversation_id: uuid.UUID | None, triggering_message_id: uuid.UUID | None,
) -> None:
    """story #3828 — conversation_id/triggering_message_id는 org 소속 실존 레코드만
    허용(존재 비노출 관례 그대로 — 없거나 타org=404, project_id 검증과 동형 폭).
    triggering_message_id가 있으면 그 메시지의 실제 conversation_id가(conversation_id도
    같이 왔다면) 서로 같은지 확인 — 다른 대화의 메시지를 엉뚱한 conversation_id와
    묶어 잇는 것을 막는다."""
    from app.models.conversation import Conversation, ConversationMessage

    if conversation_id is not None:
        row = await session.execute(
            select(Conversation.id).where(Conversation.id == conversation_id, Conversation.org_id == org_id)
        )
        if row.scalar_one_or_none() is None:
            raise HTTPException(status_code=404, detail="Conversation not found")

    if triggering_message_id is not None:
        msg_row = await session.execute(
            select(ConversationMessage.conversation_id)
            .join(Conversation, Conversation.id == ConversationMessage.conversation_id)
            .where(ConversationMessage.id == triggering_message_id, Conversation.org_id == org_id)
        )
        msg_conv_id = msg_row.scalar_one_or_none()
        if msg_conv_id is None:
            raise HTTPException(status_code=404, detail="Message not found")
        if conversation_id is not None and msg_conv_id != conversation_id:
            raise HTTPException(
                status_code=422, detail="triggering_message_id does not belong to conversation_id",
            )


@router.post("", response_model=AgentRunResponse, status_code=201)
async def create_agent_run(
    body: CreateAgentRun,
    session: AsyncSession = Depends(get_db),
    org_id: uuid.UUID = Depends(get_verified_org_id),
    auth: AuthContext = Depends(get_current_user),
    repo: AgentRunRepository = Depends(_get_repo),
) -> AgentRunResponse:
    """prod 핫픽스(S20 전수스캔 MUST): cross-org IDOR — org_id를 body.agent_id가 속한 org에서
    그대로 파생해(caller org 검증 없이) 타 org agent 명의로 run을 생성할 수 있었다. caller의
    get_verified_org_id로 파생하고 agent_id가 그 org 소속인지 검증한다.

    2a5f21d3: project_id는 DB NOT NULL·모델 정합으로 이제 필수 입력이다. body로 project_id를
    받는 순간 신규 mutation 인가 표면이 되므로 resource-actual has_project_access로 caller의
    실 접근권을 검증(body-claimed 금지·round1~9 규율)한다. 존재/타org=404, same-org 무접근권=403.
    """
    from app.services.project_auth import has_project_access

    # project_id 인가: caller org 소속 project인지(존재/타org 비노출 404) + 실 접근권(403).
    proj_r = await session.execute(
        select(Project.id).where(Project.id == body.project_id, Project.org_id == org_id)
    )
    if proj_r.scalar_one_or_none() is None:
        raise HTTPException(status_code=404, detail="Project not found")
    if not await has_project_access(session, uuid.UUID(auth.user_id), body.project_id, org_id):
        raise HTTPException(status_code=403, detail="No access to this project")

    # team_members 는 projection VIEW — 멀티프로젝트 grant 면 같은 agent_id 가 N 행. org_id 필터로
    # caller org 소속만 통과(cross-org 차단) — .limit(1) 로 MultipleResultsFound 회피.
    member_r = await session.execute(
        select(TeamMember.id).where(
            TeamMember.id == body.agent_id, TeamMember.type == "agent", TeamMember.org_id == org_id,
            TeamMember.is_active.is_(True),  # deactivated agent 는 run 생성 비도달(정합)
        ).limit(1)
    )
    if member_r.scalar_one_or_none() is None:
        raise HTTPException(status_code=400, detail="agent_id not found or not an agent")

    await _validate_conversation_link(
        session, org_id=org_id,
        conversation_id=body.conversation_id, triggering_message_id=body.triggering_message_id,
    )

    # story #2161: "시작할 때 이미 끝날 시각을 갖고 태어나게" — deadline_at은 클라 미제공(항상
    # 서버 계산, A2ATask.deadline_at 선례와 동형·클라가 자기 기한을 임의 연장 못 하게).
    #
    # story #3727 — started_at/finished_at은 미제공 시 각각 DB server_default(now())/NULL을
    # 그대로 둔다(named-arg로 항상 넘기면 미제공=None이 그 기본값을 덮어써 버린다 — 「생략」과
    # 「명시적 null」을 create 경로에서도 가른다, UpdateAgentRun의 exclude_unset과 동형 원칙).
    create_fields: dict = dict(
        org_id=org_id,
        agent_id=body.agent_id,
        project_id=body.project_id,
        trigger=body.trigger,
        model=body.model,
        story_id=body.story_id,
        memo_id=body.memo_id,
        conversation_id=body.conversation_id,
        triggering_message_id=body.triggering_message_id,
        status=body.status,
        result_summary=body.result_summary,
        error_message=body.error_message,
        last_error_code=body.last_error_code,
        input_tokens=body.input_tokens,
        output_tokens=body.output_tokens,
        cost_usd=body.cost_usd,
        deadline_at=datetime.now(timezone.utc) + timedelta(hours=AGENT_RUN_TIMEOUT_HOURS),
    )
    if body.started_at is not None:
        create_fields["started_at"] = body.started_at
    if body.finished_at is not None:
        create_fields["finished_at"] = body.finished_at
    run = await repo.create(**create_fields)
    name_map = await _agent_name_map(session, {run.agent_id})
    return AgentRunResponse.model_validate(run).model_copy(update={"agent_name": name_map.get(run.agent_id)})


@router.patch("/{id}", response_model=AgentRunResponse)
async def update_agent_run(
    id: uuid.UUID,
    body: UpdateAgentRun,
    background_tasks: BackgroundTasks,
    org_id: uuid.UUID = Depends(get_verified_org_id),
    auth: AuthContext = Depends(get_current_user),
    repo: AgentRunRepository = Depends(_get_repo),
) -> AgentRunResponse:
    """prod 핫픽스(S20 전수스캔 — create_agent_run과 동일 클래스): run id만으로 org 검증 없이
    임의 org의 agent run을 수정할 수 있었다."""
    from app.services.project_auth import has_project_access

    existing = await repo.get(id)
    if existing is None or existing.org_id != org_id:
        raise HTTPException(status_code=404, detail="Agent run not found")
    # 스캐너 라운드3(#5): org 검증은 있으나 resolved-resource(existing.project_id·AgentRun.project_id
    # NOT NULL)의 project 접근권 미검증 → same-org 다른 project 멤버가 run status/tokens/cost/error를
    # 덮어쓸 수 있었다(형제 list/create는 이미 has_project_access 有·불일치 시그널이 지목). 404·body-claimed 금지.
    if not await has_project_access(repo.session, uuid.UUID(auth.user_id), existing.project_id, org_id):
        raise HTTPException(status_code=404, detail="Agent run not found")
    # story #3961 — lazy 만료 확認이 PATCH 평가보다 먼저다: 이미 15분이 지난 cancel_requested를
    # 이 PATCH가 "지금 막 ack" 하려 해도, 서버 시각 기준 이미 cancelled_unacknowledged로
    # 確定됐어야 하는 자리라 그 확定을 먼저 반영한 뒤(existing 갱신) 아래 ack 검증을 그
    # 새 상태로 판정한다 — "만료 직전에 아슬아슬하게 ack"라는 경합을 서버 시각 하나로만 가른다.
    existing = await _expire_cancel_request_if_due(repo, existing)
    # story #3961 — 에이전트 자기보고 PATCH는 cancel_requested·cancelled_unacknowledged를
    # 직접 세팅 못 한다(둘 다 사람의 POST /cancel 또는 서버의 lazy 만료만의 전용 전이 —
    # "정지 요청"과 "타임아웃 확定"은 자기보고가 아니라 그 자체가 서버/사람 권위다).
    # cancelled 하나만 예외 허용(ack) — 단 existing.status가 이미 cancel_requested일 때만
    # (요청받은 적 없는데 스스로 "취소됐다"고 선언하는 위조 방지).
    if body.status in ("cancel_requested", "cancelled_unacknowledged"):
        raise HTTPException(
            status_code=422,
            detail=f"status={body.status!r} cannot be set via self-report (server/human-only transition).",
        )
    if body.status == "cancelled" and existing.status != "cancel_requested":
        raise HTTPException(
            status_code=409,
            detail=f"ack (status=cancelled) is only valid when the run is cancel_requested "
            f"(current status={existing.status!r}).",
        )
    _cancel_ack_fields: dict = {}
    if body.status == "cancelled":
        _cancel_ack_fields = {"cancel_ack_at": datetime.now(timezone.utc), "cancel_outcome": "acknowledged"}
    # story #2161: finished_at 갭 — MCP는 이미 보낼 수 있으나(sprintable_mcp update_run_status)
    # 항상 보낸다고 신뢰하지 않는다. 종단 상태로 전이인데 클라 미제공이면 서버가 now()로 채운다
    # (duration_ms GENERATED가 살아나는 유일한 경로 — 안 채우면 정상 종료도 영구 NULL).
    _finished_at = body.finished_at
    if _finished_at is None and body.status in _TERMINAL_STATUSES:
        _finished_at = datetime.now(timezone.utc)
    # ⛔story #2346 AC1(2026-07-30): result_summary·last_error_code가 «생략돼도 항상 덮어써져»
    # 매 status 갱신마다 앞선 값이 null로 지워지던 결함 — exclude_unset=True로 「캐폴러가
    # 실제로 이 요청에 넣은 필드만」 repo에 넘긴다. 캐폴러가 명시로 null을 보내면(의도적
    # 비우기) 여전히 지워진다 — "생략"과 "명시적 null"을 이제 구분한다(repo.update()의 예외
    # 특례는 그 구분을 못 해 항상 지웠다 — 아래에서 제거).
    _explicit_fields = body.model_dump(exclude_unset=True, exclude={"status", "finished_at"})
    await _validate_conversation_link(
        repo.session, org_id=org_id,
        conversation_id=_explicit_fields.get("conversation_id"),
        triggering_message_id=_explicit_fields.get("triggering_message_id"),
    )
    # story #2346 AC3(범위: 기록만, AC7 차단 없음 — 위 모듈 상단 코멘트 참조): existing이 이미
    # access-check용으로 조회돼 있어(stories.py처럼 조건부 재조회 불필요) old 길이를 지금 스칼라로
    # 떠 둔다.
    _old_lengths = {
        f: len(getattr(existing, f) or "") for f in _LENGTH_TRACKED_FIELDS if f in _explicit_fields
    }
    run = await repo.update(
        id,
        status=body.status,
        finished_at=_finished_at,
        **_cancel_ack_fields,
        **_explicit_fields,
    )
    if run is None:
        raise HTTPException(status_code=404, detail="Agent run not found")
    if _old_lengths:
        _length_changes = {}
        for _f, _before_len in _old_lengths.items():
            _after_len = len(getattr(run, _f) or "")
            if _before_len != _after_len:
                _length_changes[_f] = {"before": _before_len, "after": _after_len}
        if _length_changes:
            from app.services.activity_log import record_activity_bg
            from app.services.member_resolver import resolve_member

            _actor = await resolve_member(auth, org_id, repo.session, project_id=existing.project_id)
            background_tasks.add_task(
                record_activity_bg,
                org_id=org_id,
                action="agent_run_updated",
                actor_id=_actor.id,
                project_id=existing.project_id,
                entity_type="agent_run",
                entity_id=id,
                context={"length_changes": _length_changes},
            )
    name_map = await _agent_name_map(repo.session, {run.agent_id})
    return AgentRunResponse.model_validate(run).model_copy(update={"agent_name": name_map.get(run.agent_id)})


@router.post("/{id}/cancel", response_model=AgentRunResponse)
async def cancel_agent_run(
    id: uuid.UUID,
    body: CancelAgentRun,
    org_id: uuid.UUID = Depends(get_verified_org_id),
    auth: AuthContext = Depends(get_current_user),
    repo: AgentRunRepository = Depends(_get_repo),
) -> AgentRunResponse:
    """story #3961(「정지」 액션 — 중단 요청 프로토콜, PO 확定 2026-09-16) — 프로세스를
    죽이지 않는다. status를 ``cancel_requested``로 전이 + 감사 3필드(requested_by/at/reason)
    기록 + `preset.agent_run.cancel_requested` 이벤트 발행(대상 에이전트가 poll_events로
    자기보고보다 먼저 볼 수 있는 신호 자리 — AC1 그라운딩: 이 저장소엔 고정 폴링 계약이
    없어 자기보고 PATCH 응답 하나에만 기대면 장기 실행 run은 못 볼 수 있다).

    권한(PO 확定) = org owner/admin **또는** 그 run이 붙은 story의 assignee(사람, Story.
    assignee_id) **또는** 그 story를 위임한 사람(Story.human_owner_member_id) — 3959/
    today_service.py의 "위임/참여" 판정과 동일 두 컬럼(새 인가 축 발명 0). story_id가
    없는 run(체험/1회성)은 org owner/admin만 가능(대상 지정할 사람이 없다).
    """
    from app.services.member_resolver import resolve_member
    from app.services.project_auth import has_project_access, is_org_owner_or_admin

    existing = await repo.get(id)
    if existing is None or existing.org_id != org_id:
        raise HTTPException(status_code=404, detail="Agent run not found")
    if not await has_project_access(repo.session, uuid.UUID(auth.user_id), existing.project_id, org_id):
        raise HTTPException(status_code=404, detail="Agent run not found")

    existing = await _expire_cancel_request_if_due(repo, existing)

    caller = await resolve_member(auth, org_id, repo.session, project_id=existing.project_id)
    # PO 확定 문구 그대로("사람이... 인가된 절차로 멈춘다") — 이 액션의 주체는 항상 사람이다.
    # story.assignee_id가 에이전트를 가리키는 경우(위임 대상 컬럼은 human/agent 혼용, 3821
    # 그라운딩 근거)까지 "그 일의 assignee"로 인정하면 에이전트가 자기 자신·다른 에이전트의
    # run을 인가 없이 멈추게 허용하는 셈이라 명시로 막는다.
    if caller.type != "human":
        raise HTTPException(status_code=403, detail="Only a human can request this action.")
    is_admin = await is_org_owner_or_admin(repo.session, uuid.UUID(auth.user_id), org_id)
    is_story_owner = False
    if existing.story_id is not None:
        story_r = await repo.session.execute(
            select(Story.assignee_id, Story.human_owner_member_id).where(Story.id == existing.story_id)
        )
        story_row = story_r.first()
        if story_row is not None:
            assignee_id, human_owner_member_id = story_row
            is_story_owner = caller.id in (assignee_id, human_owner_member_id)
    if not (is_admin or is_story_owner):
        raise HTTPException(
            status_code=403,
            detail="Only org owner/admin or this work item's assignee can request cancellation.",
        )

    if existing.status not in _CANCELLABLE_STATUSES:
        raise HTTPException(
            status_code=409,
            detail=f"status={existing.status!r} runs cannot be cancel-requested "
            f"(cancellable statuses: {sorted(_CANCELLABLE_STATUSES)}).",
        )

    now = datetime.now(timezone.utc)
    run = await repo.update(
        id,
        status="cancel_requested",
        cancel_requested_by=caller.id,
        cancel_requested_at=now,
        cancel_reason=body.reason,
    )
    if run is None:
        raise HTTPException(status_code=404, detail="Agent run not found")

    # story #3961(페드루 PO CHANGES①, PR#4364 16:02Z) — best-effort 격리(story_status_events.py::
    # emit_story_status_changed와 동형 계약): 이벤트 발행 실패가 이미 확定된 cancel_requested
    # 전이 자체를 롤백하면 안 된다(발행은 부가 신호, 상태 전이가 1차 사실).
    # timeout_at(now+15분) — 수신 런타임이 "언제까지 ack해야 unacknowledged로 確定되는지"를
    # 자기 로컬 시계로 다시 계산할 필요 없게(_CANCEL_ACK_TIMEOUT_MINUTES SSOT는 서버 쪽에만
    # 있다 — 값을 페이로드에 실어 그대로 전달, 클라가 상수를 따로 하드코딩할 필요 0).
    try:
        from app.routers.events import publish_preset_event

        await publish_preset_event(
            repo.session, org_id, "preset.agent_run.cancel_requested",
            {
                "run_id": str(run.id),
                "agent_id": str(run.agent_id),
                "requested_by_member_id": str(caller.id),
                "reason": body.reason,
                "timeout_at": (now + timedelta(minutes=_CANCEL_ACK_TIMEOUT_MINUTES)).isoformat(),
            },
        )
    except Exception:
        logger.warning(
            "agent_run.cancel_requested 이벤트 발행 실패(run=%s org=%s)", run.id, org_id, exc_info=True,
        )

    name_map = await _agent_name_map(repo.session, {run.agent_id})
    return AgentRunResponse.model_validate(run).model_copy(update={"agent_name": name_map.get(run.agent_id)})
