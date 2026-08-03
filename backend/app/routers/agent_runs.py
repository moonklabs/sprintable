import uuid
from datetime import datetime, timedelta, timezone

from fastapi import APIRouter, BackgroundTasks, Depends, HTTPException, Query
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.dependencies.auth import AuthContext, get_current_user, get_verified_org_id
from app.dependencies.database import get_db
from app.models.project import Project
from app.models.team import TeamMember
from app.repositories.agent_run import AgentRunRepository
from app.schemas.agent_run import AgentRunResponse, CreateAgentRun, UpdateAgentRun
from app.services.agent_run_lifecycle import AGENT_RUN_TIMEOUT_HOURS

router = APIRouter(prefix="/api/v2/agent-runs", tags=["agent-runs", "Work"])

# story #2161: PATCH가 이 세 상태로 전이시키는데 클라가 finished_at을 안 보내면 서버가 채운다
# (server-authority — MCP는 이미 finished_at을 보낼 수 있지만 항상 보낸다고 신뢰하지 않는다).
_TERMINAL_STATUSES = {"completed", "failed", "abandoned"}

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
    project_id: uuid.UUID = Query(...),
    agent_id: uuid.UUID | None = Query(default=None),
    story_id: uuid.UUID | None = Query(default=None),
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
    project agent의 run은 이 집합 밖이라 0건."""
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
    runs = await repo.list(
        project_id=project_id, agent_id=agent_id, story_id=story_id, limit=limit, cursor=cursor_dt
    )
    return [AgentRunResponse.model_validate(r) for r in runs]


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

    # story #2161: "시작할 때 이미 끝날 시각을 갖고 태어나게" — deadline_at은 클라 미제공(항상
    # 서버 계산, A2ATask.deadline_at 선례와 동형·클라가 자기 기한을 임의 연장 못 하게).
    run = await repo.create(
        org_id=org_id,
        agent_id=body.agent_id,
        project_id=body.project_id,
        trigger=body.trigger,
        model=body.model,
        story_id=body.story_id,
        memo_id=body.memo_id,
        status=body.status,
        result_summary=body.result_summary,
        input_tokens=body.input_tokens,
        output_tokens=body.output_tokens,
        cost_usd=body.cost_usd,
        deadline_at=datetime.now(timezone.utc) + timedelta(hours=AGENT_RUN_TIMEOUT_HOURS),
    )
    return AgentRunResponse.model_validate(run)


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
    return AgentRunResponse.model_validate(run)
