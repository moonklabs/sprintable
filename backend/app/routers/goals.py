"""계층 리네이밍 B1(story 1925): 구 routers/epics.py — 전면 rename(REST 경로+Python 식별자).

prefix를 여기서 하드코딩하지 않는다(hierarchy-rename-alias-mechanism-design §2) — main.py가
같은 router 객체를 신(`/api/v2/goals`)+구(`/api/v2/epics`, deprecated=True) 두 prefix로
include해 무중단 별칭 서빙을 구현한다.
"""
import uuid
from datetime import datetime

from fastapi import APIRouter, Depends, HTTPException, Query, Response
from fastapi.responses import JSONResponse
from pydantic import BaseModel
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.dependencies.auth import AuthContext, enforce_body_context, get_current_user, get_verified_org_id
from app.dependencies.database import get_db, get_read_db
from app.repositories.goal import GoalRepository
from app.schemas.goal import GoalCreate, GoalProgressResponse, GoalResponse, GoalUpdate, GoalWithGlanceResponse
from app.services.project_auth import has_project_access, require_project_access

router = APIRouter(tags=["goals", "Work"])


def _get_repo(
    session: AsyncSession = Depends(get_db),
    org_id: uuid.UUID = Depends(get_verified_org_id),
) -> GoalRepository:
    return GoalRepository(session, org_id)


# story #2451(§6 Phase3 A2): list_goals 전용 — 목록 조회는 create→self-read 흐름이 약함
# (replica lag 0.86s, PO 승인). 다른 라우트가 공유하는 위 _get_repo(get_db)는 그대로.
def _get_repo_read(
    session: AsyncSession = Depends(get_read_db),
    org_id: uuid.UUID = Depends(get_verified_org_id),
) -> GoalRepository:
    return GoalRepository(session, org_id)


async def _attach_org_project_slugs(session: AsyncSession, org_id: uuid.UUID, goals: list) -> None:
    """story #2642: stories.py `_attach_org_project_slugs`와 동형 — org_slug(요청당 1쿼리)+
    project_slug(distinct project_id 배치 1쿼리)를 transient attr로 부착(N+1 회피)."""
    if not goals:
        return
    from app.services.entity_slug import resolve_org_slug, resolve_project_slugs

    org_slug = await resolve_org_slug(session, org_id)
    project_slug_map = await resolve_project_slugs(session, {g.project_id for g in goals})
    for g in goals:
        g.org_slug = org_slug
        g.project_slug = project_slug_map.get(g.project_id)


@router.get("", response_model=None)
async def list_goals(
    response: Response,
    project_id: uuid.UUID | None = Query(default=None),
    status_filter: str | None = Query(default=None, alias="status"),
    ids: str | None = Query(default=None, description="comma-separated goal ids — 배치 앵커 조회(정확한 집합, ORDER BY/limit 무관, story #2262 PR② 칩 상태 배치조회)"),
    limit: int | None = Query(default=None, ge=1, le=2000),
    cursor: str | None = Query(default=None, description="Cursor: ISO 8601 created_at, fetch before this time"),
    order_by: str = Query(default="created_at"),
    include: str | None = Query(
        default=None,
        description='"glance"면 participant_ids/focal_story가 추가로 붙는다(story #2298, 옵트인).',
    ),
    repo: GoalRepository = Depends(_get_repo_read),
    org_id: uuid.UUID = Depends(get_verified_org_id),
    auth: AuthContext = Depends(get_current_user),
) -> list[GoalResponse] | JSONResponse:
    """목표 목록 — true cursor 페이지네이션 + 전체 카운트(X-Total-Count 헤더).

    1000+ 목표가 조용히 잘리던 문제(#1200/569f5316)를 근절: limit/cursor로 위임
    페이지네이션하고, 페이지와 무관한 전체 개수를 X-Total-Count로 노출한다.
    limit 미지정 시 기존 동작(최대 1000)과 호환되며, 1000+ 인 경우에도 헤더로
    잘림 여부를 호출자가 인지할 수 있어 silent-truncation이 아니다.

    ⛔story #2298(3단 웨이터폴 근절, 오르테가 계약 2026-07-29): `include=glance`는 순수
    옵트인이다 — 파라미터가 없으면 이 함수는 기존과 완전히 같은 코드 경로(`response_model`을
    `None`으로 바꾼 것은 두 응답 모델을 라우터가 직접 분기하기 위함일 뿐, 미지정 시 반환값은
    이전과 byte-identical — `test_2298_goals_glance_include_realdb.py`가 그걸 고정한다).
    `GoalResponse`에 optional 필드를 얹지 않고 별도 `GoalWithGlanceResponse`로 가른 이유도
    같다(같은 모델에 얹으면 기본값이라도 JSON에 항상 찍혀 계약이 깨진다)."""
    # story #2262 PR②(칩 상태 배치조회) — stories.py list_stories의 ids= 패턴 그대로 미러링.
    # cursor/glance/order_by 등 페이지네이션 로직 전부 우회(정확한 집합 요청이라 무관).
    # 카디르 QA(PR#2905, 2026-08-07): Query(default=None, ...) 기본값은 「값」이 아니라
    # 「센티널 객체」 — FastAPI 경유 없이 이 함수를 직접 호출하는 테스트가 ids를 안 넘기면
    # 그 센티널 그대로를 받는다. `is not None`은 센티널도 통과시켜 버려 `.split`이 터진다
    # (stories.py list_stories가 이미 겪은 동형 함정) — isinstance로 실제 타입을 검사한다.
    if isinstance(ids, str):
        try:
            goal_ids = [uuid.UUID(x) for x in ids.split(",") if x.strip()]
        except ValueError:
            raise HTTPException(status_code=422, detail="invalid goal id in ids")
        if not goal_ids:
            return []
        if len(goal_ids) > 200:
            raise HTTPException(status_code=422, detail="too many ids (max 200)")
        goals = await repo.list_by_ids(goal_ids)
        # 인가 스코프: org 소속이어도 caller가 접근 못 하는 project의 goal은 조용히 필터링
        # (stories.py list_stories와 동일 SSOT — accessible_project_ids_in_org).
        from app.services.project_auth import accessible_project_ids_in_org
        accessible = await accessible_project_ids_in_org(repo.session, uuid.UUID(auth.user_id), org_id)
        goals = [g for g in goals if g.project_id in accessible]
        await _attach_org_project_slugs(repo.session, org_id, goals)
        return [GoalResponse.model_validate(g) for g in goals]

    # ratchet round8(잔여 HIGH): project_id 필터(지정 시)에 caller 접근권 검증이 없어
    # same-org cross-project goal(제목/목표/전략의도)이 노출됐다 — resource-actual
    # project_id 직접검증. EE 훅 없음(이 엔드포인트는 EE RBAC 미적용 확認).
    if project_id is not None:
        if not await has_project_access(repo.session, uuid.UUID(auth.user_id), project_id, org_id):
            raise HTTPException(status_code=404, detail="Project not found")

    filters: dict = {}
    if project_id:
        filters["project_id"] = project_id
    if status_filter:
        filters["status"] = status_filter

    cursor_dt: datetime | None = None
    if cursor:
        try:
            cursor_dt = datetime.fromisoformat(cursor)
        except (ValueError, TypeError) as exc:
            # 잘못된 cursor는 silent 무시 대신 400으로 명확히 거절한다.
            raise HTTPException(
                status_code=400, detail="invalid cursor: expected ISO 8601 datetime"
            ) from exc

    goals, total = await repo.list_paginated(
        limit=limit, cursor=cursor_dt, order_by=order_by, **filters
    )

    if include != "glance":
        response.headers["X-Total-Count"] = str(total)
        # order_by="position"(옵트인 로드맵 조타 정렬, wedge #2)은 복합 정렬이라 created_at
        # cursor로 이어붙일 수 없다 — 이 모드에서는 X-Next-Cursor 미노출(호출자가 이어달리기
        # 시도 안 하도록).
        if goals and order_by != "position":
            response.headers["X-Next-Cursor"] = goals[-1].created_at.isoformat()
        await _attach_org_project_slugs(repo.session, org_id, goals)
        return [GoalResponse.model_validate(e) for e in goals]

    # ⛔직접 Response를 반환하면 위 `response: Response` 의존성에 건 헤더는 FastAPI가 안
    # 적용한다(반환한 Response 객체가 그대로 나간다) — 여기 JSONResponse에 같은 헤더를
    # 다시 건다.
    await repo.attach_glance_aggregates(goals)
    await _attach_org_project_slugs(repo.session, org_id, goals)
    glance_response = JSONResponse(
        content=[
            GoalWithGlanceResponse.model_validate(e).model_dump(mode="json") for e in goals
        ]
    )
    glance_response.headers["X-Total-Count"] = str(total)
    if goals and order_by != "position":
        glance_response.headers["X-Next-Cursor"] = goals[-1].created_at.isoformat()
    return glance_response


def _resolve_outcome_status(metric_definition: object, measure_after: object, current_status: str = "n_a") -> str:
    """intent가 완전히 선언(md+ma 둘 다 세팅)되면 n_a→pending 전이."""
    if metric_definition and measure_after and current_status == "n_a":
        return "pending"
    return current_status


@router.post("", response_model=GoalResponse, status_code=201)
async def create_goal(
    body: GoalCreate,
    session: AsyncSession = Depends(get_db),
    auth: AuthContext = Depends(get_current_user),
    org_id: uuid.UUID = Depends(get_verified_org_id),
) -> GoalResponse:
    await enforce_body_context(
        auth_org_id=org_id,
        body_org_id=body.org_id,
        body_project_id=body.project_id,
        auth_project_id=auth.claims.get("app_metadata", {}).get("project_id"),
        db=session,
        user_id=uuid.UUID(auth.user_id),
    )
    repo = GoalRepository(session, org_id)
    goal = await repo.create(
        project_id=body.project_id,
        title=body.title,
        status=body.status,
        priority=body.priority,
        description=body.description,
        objective=body.objective,
        success_criteria=body.success_criteria,
        target_sp=body.target_sp,
        target_date=body.target_date,
        success_hypothesis=body.success_hypothesis,
        metric_definition=body.metric_definition,
        measure_after=body.measure_after,
        outcome_status=_resolve_outcome_status(body.metric_definition, body.measure_after),
    )
    # E-GLANCE wedge #2(story 96b19bc3): epic.created 이벤트 — 오르테가 구독 채널(fire_webhooks).
    # actor 해소 실패는 emit 자체를 막지 않는다(bulk_update_stories와 동형 best-effort).
    from app.services.goal_events import emit_goal_created
    from app.services.member_resolver import resolve_member

    _actor_id: uuid.UUID | None = None
    try:
        _actor_id = (await resolve_member(auth, org_id, session)).id
    except Exception:  # noqa: BLE001
        _actor_id = None
    await emit_goal_created(session, org_id, goal, actor_id=_actor_id)
    await _attach_org_project_slugs(session, org_id, [goal])
    return GoalResponse.model_validate(goal)


@router.get("/{id}", response_model=GoalResponse)
async def get_goal(
    id: uuid.UUID,
    repo: GoalRepository = Depends(_get_repo),
    auth: AuthContext = Depends(get_current_user),
) -> GoalResponse:
    goal = await repo.get(id)
    if goal is None:
        raise HTTPException(status_code=404, detail="Goal not found")
    # #2237/#2697: 형제(update_goal)와 동일한 project 접근권 가드(판정 함수 한 곳).
    await require_project_access(repo.session, uuid.UUID(auth.user_id), goal.project_id, repo.org_id,
                                  not_found_detail="Goal not found")
    await _attach_org_project_slugs(repo.session, repo.org_id, [goal])
    return GoalResponse.model_validate(goal)


class BulkGoalPositionItem(BaseModel):
    id: uuid.UUID
    position: int


class BulkGoalPositionRequest(BaseModel):
    # stories.py bulk_update_stories와 동일 계약(items 래퍼) — FE dnd 공통 패턴.
    items: list[BulkGoalPositionItem]


class SteerDispatchRequest(BaseModel):
    """STEER 조타 커밋(ff662876). items=커밋된 순서 스냅샷(드래그로 이미 /bulk 저장된 상태와
    일치해야 함·서버 정합검증). recipient_member_ids=커밋한 인간이 **명시**하는 수신자(필수·
    None/빈값→400). 보편적 오케스트레이터란 없다(선생님 B)—BE는 추측 안 하고 인간 지정만 받는다.
    프리필 편의(오르테가 등)는 FE 몫."""
    items: list[BulkGoalPositionItem]
    recipient_member_ids: list[uuid.UUID] | None = None


# ⚠️ /bulk 은 /{id} 보다 **먼저** 선언해야 한다(FastAPI 라우트 매칭=선언 순서·specific-before-
# parameterized) — stories.py bulk_update_stories와 동일 교훈(PATCH /bulk가 /{id}에 매칭돼
# id="bulk" UUID 파싱 422로 shadow되는 사고 재발 방지).
@router.patch("/bulk", response_model=list[GoalResponse])
async def bulk_update_goals(
    payload: BulkGoalPositionRequest,
    response: Response,
    session: AsyncSession = Depends(get_db),
    org_id: uuid.UUID = Depends(get_verified_org_id),
    auth: AuthContext = Depends(get_current_user),
) -> list[GoalResponse]:
    """PATCH /api/v2/goals/bulk — 로드맵 조타(재정렬, story 96b19bc3 §1.4).

    SEC-S8 W/W2 하드닝을 **처음부터** 내장(bulk_update_stories 템플릿 그대로 이식 — 회귀로
    나중에 패치하지 않고 설계 단계서 봉인): org_id 필터로 cross-org IDOR 원천 차단(W) +
    has_project_access(대상 goal.project_id, resource-actual — body-claimed 아님)로 same-org
    cross-project도 차단(W2). 미접근 item은 not-found와 동형으로 조용히 스킵(존재 비노출·
    나머지 정당 item은 진행).

    story #3176 선행조건①(payload-배치 AU 계측): `X-Affected-Entities` 응답 헤더로 실제
    반영된 엔티티 수(len(updated) — 요청 개수가 아니라 접근권 스킵 제외한 실처리 수)를
    명시한다. AUMeteringMiddleware가 이 헤더를 읽어 5×N AU로 계상(au_metering.py 참고).
    """
    from app.models.pm import Goal

    updated: list[Goal] = []
    for item in payload.items:
        q = await session.execute(
            select(Goal).where(Goal.id == item.id, Goal.org_id == org_id)
        )
        goal = q.scalar_one_or_none()
        if not goal:
            continue
        if not await has_project_access(session, uuid.UUID(auth.user_id), goal.project_id, org_id):
            continue
        goal.position = item.position
        updated.append(goal)

    # P0/MissingGreenlet: setattr 후 flush만으로는 onupdate 서버생성 컬럼(updated_at)이 파이썬
    # 객체에 반영 안 됨 — bulk_update_stories와 동형으로 flush+refresh 후 commit.
    await session.flush()
    for e in updated:
        await session.refresh(e)
    await session.commit()
    # story #2459 회귀(2026-08-05): commit 前 refresh만으로는 불충분했다 — commit 自體이
    # (expire_on_commit=False에도 불구하고 관측상) attr를 다시 unloaded로 되돌릴 수 있어
    # commit 後에도 model_validate 前 재refresh가 필요하다(gates.py/stories.py와 동형).
    for e in updated:
        await session.refresh(e)

    # STEER 커밋-모델(ff662876·선생님 재정의): 드래그 재정렬은 **이벤트 0**(순수 초안 저장)이다.
    # 인간이 로드맵을 A→B→다시A로 번복하는 사고과정은 사적 초안이라 실시간 이벤트로 새면 안 된다.
    # epic.reordered 발화는 명시적 조타 커밋(POST /goals/steer-dispatch)에서만 1회. 여기선 emit 없음.
    await _attach_org_project_slugs(session, org_id, updated)
    response.headers["X-Affected-Entities"] = str(len(updated))
    return [GoalResponse.model_validate(e) for e in updated]


# ⚠️ /steer-dispatch 도 /{id} 보다 먼저 선언(정적 경로 shadow 방지 — /bulk와 동일 교훈).
@router.post("/steer-dispatch", status_code=200)
async def steer_dispatch(
    payload: SteerDispatchRequest,
    session: AsyncSession = Depends(get_db),
    org_id: uuid.UUID = Depends(get_verified_org_id),
    auth: AuthContext = Depends(get_current_user),
) -> dict:
    """STEER 조타 커밋-디스패치(ff662876·선생님 재정의). 드래그(PATCH /goals/bulk)는 무이벤트
    초안 저장이고, 이 명시적 커밋에서만 epic.reordered를 1회 발화한다(확定된 결정의 전달·초안
    사고과정 비노출). 커밋 endpoint는 신규 mutation 인가표면이므로(add_feedback 교훈): 대상 goal
    has_project_access(resource-actual) + recipient_member_ids 각각이 caller org 소속 member인지
    검증(body-claimed/cross-org 주입 차단).
    """
    from app.models.pm import Goal
    from app.services.goal_events import emit_goal_reordered
    from app.services.member_resolver import resolve_member, resolve_member_identity

    if not payload.items:
        raise HTTPException(status_code=400, detail="items required")

    # 1) 대상 goal 검증 + 서버 정합검증(Q1: payload 스냅샷 신뢰하되 저장 position과 대조).
    committed: list[dict] = []
    for item in payload.items:
        goal = (await session.execute(
            select(Goal).where(Goal.id == item.id, Goal.org_id == org_id)
        )).scalar_one_or_none()
        if goal is None:
            raise HTTPException(status_code=404, detail="Goal not found")
        if not await has_project_access(session, uuid.UUID(auth.user_id), goal.project_id, org_id):
            raise HTTPException(status_code=403, detail="No access to this project")
        # 커밋 스냅샷 position이 이미 /bulk로 저장된 확定 상태와 일치해야(미저장/경합 시 409 —
        # 커밋은 저장된 결정의 전달이지 재-write가 아니다).
        if goal.position != item.position:
            raise HTTPException(status_code=409, detail="Position snapshot conflict — save draft before dispatch")
        committed.append({
            "id": goal.id, "title": goal.title, "project_id": goal.project_id,
            "position": goal.position, "old_position": None,
        })

    # 2) 수신자 = **커밋한 인간이 명시**(선생님 B 확定): 보편적 오케스트레이터란 없다 — org마다
    #    팀 구성이 다르고 relay-owner=사람 owner는 특정 조직 가정이라, 매 조타마다 인간이 자기
    #    project 멤버 중 수신자를 지정하는 게 유일하게 일반적이다. relay-owner 추측 폴백 없음
    #    (None/빈값→400). 각 recipient는 caller org 소속 member인지 검증(cross-org 주입 차단·
    #    body-claimed 금지). 프리필 편의(오르테가 등)는 FE 몫이지 BE 추측이 아니다.
    if not payload.recipient_member_ids:
        raise HTTPException(status_code=400, detail="recipient_member_ids required")
    recipients: set[uuid.UUID] = set()
    for mid in payload.recipient_member_ids:
        if await resolve_member_identity(mid, org_id, session) is None:
            raise HTTPException(status_code=400, detail="recipient_member_id not in org")
        recipients.add(mid)

    # 3) actor(best-effort) + emit 1회(지정 수신자 게이팅·preserve_broadcast=False).
    actor_id: uuid.UUID | None = None
    try:
        actor_id = (await resolve_member(auth, org_id, session)).id
    except Exception:  # noqa: BLE001
        actor_id = None
    await emit_goal_reordered(session, org_id, committed, recipients, actor_id=actor_id)

    return {
        "dispatched": True,
        "epic_count": len(committed),
        "recipient_member_ids": [str(r) for r in recipients],
    }


@router.patch("/{id}", response_model=GoalResponse)
async def update_goal(
    id: uuid.UUID,
    body: GoalUpdate,
    repo: GoalRepository = Depends(_get_repo),
    auth: AuthContext = Depends(get_current_user),
) -> GoalResponse:
    current = await repo.get(id)
    if current is None:
        raise HTTPException(status_code=404, detail="Goal not found")
    # 5285888c 라운드1(#1): repo는 org-scope만이라 접근권 없는 same-org 다른 project의 goal을
    # title/goal/전략까지 무가드로 덮어쓸 수 있었다(PATH_ID 뮤테이션 project-scope IDOR). resolved
    # -resource(현 goal의 실 project_id)에 has_project_access 사전검증(404·존재 비노출·body-claimed
    # 금지). GoalUpdate엔 project_id 필드 없어 cross-project 이동 경로는 원천 부재.
    await require_project_access(repo.session, uuid.UUID(auth.user_id), current.project_id, repo.org_id,
                                  not_found_detail="Goal not found")
    data = body.model_dump(exclude_unset=True)
    # ⭐RC#2(D1' 봉인): goal status(lifecycle) **변경**은 generic PATCH 금지 — 전용 transition 엔드포인트
    # (POST /goals/{id}/transition)가 FSM(_GOAL_VALID_TRANSITIONS)+SoD+overlay-gate 보유. generic 으로
    # 변경 보내면 그 3중 가드 우회. ⭐미변경 동봉(status==current)은 무시(FE always-send 호환·no-op·
    # RC#1 resolver_id "잔류하되 무시" 동형). outcome_status(아래)는 별개 필드라 무관.
    if "status" in data:
        if data["status"] != current.status:
            raise HTTPException(
                status_code=422,
                detail="goal status 변경은 POST /goals/{id}/transition 전용 엔드포인트를 사용하세요 "
                       "(FSM·SoD·gate 우회 방지).",
            )
        data.pop("status", None)
    # intent가 이번 업데이트로 완성되면 n_a→pending 전이
    effective_md = data.get("metric_definition", current.metric_definition)
    effective_ma = data.get("measure_after", current.measure_after)
    new_status = _resolve_outcome_status(effective_md, effective_ma, current.outcome_status)
    if new_status != current.outcome_status:
        data["outcome_status"] = new_status
    goal = await repo.update(id, **data)
    if goal is None:
        raise HTTPException(status_code=404, detail="Goal not found")
    # story #3180 후속(카디르 QA REQUEST_CHANGES, PR#3593) — commit-then-publish로 정렬
    # (dependencies.py 3곳과 동일 근거 — get_db implicit commit보다 먼저 push하면 FE 재조회가
    # 아직 안 보이는 상태를 읽는다). measure_after 재계획은 loop_overdue_goal(도과 기준선
    # 이동) 파생의 실 입력이다(전용 transition 엔드포인트 밖의 유일한 그 변경 경로).
    if "measure_after" in data:
        from app.services.attention_events import notify_attention_changed

        await repo.session.commit()
        # story 50662d49(commit-then-model_validate refresh lint) — dependencies.py와 동형.
        await repo.session.refresh(goal)
        await notify_attention_changed(repo.org_id)
    await _attach_org_project_slugs(repo.session, repo.org_id, [goal])
    return GoalResponse.model_validate(goal)


@router.delete("/{id}", status_code=200)
async def delete_goal(
    id: uuid.UUID,
    repo: GoalRepository = Depends(_get_repo),
    session: AsyncSession = Depends(get_db),
    auth: AuthContext = Depends(get_current_user),
    org_id: uuid.UUID = Depends(get_verified_org_id),
) -> dict:
    """목표 삭제 — admin/owner 전용 게이트.

    파괴적 작업이므로 org-level owner/admin 만 허용한다. FE 의 requireRole 게이트는
    Supabase 레거시(db=undefined) 의존으로 깨져 있었고 그게 유일한 admin/owner 가드였다.
    삭제하면 권한 누수(org member/viewer 가 목표 삭제)이므로 authz 를 BE SSOT 로 옮긴다.
    admin/owner 는 org-wide 접근권이라 project 접근권을 자동 충족한다(별도 project 게이트 불요).

    E-SECURITY SEC-S1 확장(까심 적대적 QA 발견): is_org_owner_or_admin은 org_members(휴먼 전용
    grant 테이블)만 조회해 에이전트가 구조적으로 통과 불가하나, 그건 암묵적 부산물일 뿐 — cascade로
    소속 stories까지 물리삭제되는 파괴력을 고려해 delete_story와 동형인 명시적 human-only 체크를
    추가한다(암묵적 방어에만 기대지 않음).
    """
    from app.repositories.dependency import DependencyRepository
    from app.repositories.label import ItemLabelRepository
    from app.services.member_resolver import resolve_member
    from app.services.project_auth import is_org_owner_or_admin

    # 존재 검증 먼저(없으면 404) — authz 결과로 존재 여부가 새지 않도록 404 우선.
    goal = await repo.get(id)
    if goal is None:
        raise HTTPException(status_code=404, detail="Goal not found")

    resolved = await resolve_member(auth, org_id, session)
    if resolved.type != "human":
        raise HTTPException(status_code=403, detail="Goal 삭제는 휴먼 멤버만 가능합니다 (에이전트 API키 차단)")

    if not await is_org_owner_or_admin(session, uuid.UUID(auth.user_id), org_id):
        raise HTTPException(
            status_code=403, detail="Goal deletion requires admin or owner role"
        )

    from app.models.deletion_audit import DeletionAuditLog
    session.add(DeletionAuditLog(
        id=uuid.uuid4(), org_id=org_id, actor_id=resolved.id,
        entity_type="epic", entity_id=id, entity_title=goal.title,
    ))
    # E-GLANCE wedge #2: 삭제 前 title/project_id 캡처(삭제 後 조회 불가) — epic.removed 이벤트용.
    _epic_title = goal.title
    _epic_project_id = goal.project_id
    ok = await repo.delete(id)
    if not ok:
        raise HTTPException(status_code=404, detail="Goal not found")
    await DependencyRepository(session, org_id).delete_by_item(id, "epic")
    await ItemLabelRepository(session, org_id).delete_by_item(id, "epic")

    from app.services.goal_events import emit_goal_removed
    await emit_goal_removed(
        session, org_id, id, _epic_title, _epic_project_id, actor_id=resolved.id,
    )
    return {"ok": True}


@router.get("/{id}/progress", response_model=GoalProgressResponse)
async def get_goal_progress(
    id: uuid.UUID,
    repo: GoalRepository = Depends(_get_repo),
    auth: AuthContext = Depends(get_current_user),
) -> GoalProgressResponse:
    goal = await repo.get(id)
    if goal is None:
        raise HTTPException(status_code=404, detail="Goal not found")
    # #2237/#2697: 형제(update_goal)와 동일한 project 접근권 가드(판정 함수 한 곳).
    await require_project_access(repo.session, uuid.UUID(auth.user_id), goal.project_id, repo.org_id,
                                  not_found_detail="Goal not found")
    return await repo.get_progress(id)


@router.get("/{id}/reference-candidates")
async def get_goal_reference_candidates(
    id: uuid.UUID,
    repo: GoalRepository = Depends(_get_repo),
    auth: AuthContext = Depends(get_current_user),
) -> list[dict]:
    """GET .../goals/{id}/reference-candidates — story #2223 후속(오르테가군 판정,
    2026-07-30): 캔버스가 에픽 하나치 「의미 후보」(간선 재료)를 한 번에 받는 자리.
    story별 개별 조회(`/stories/{id}/reference-candidates`)는 N+1이라 캔버스엔 못 쓴다 —
    이 엔드포인트는 그 에픽 소속 story 전체의 candidate를 한 번에 반환한다. 응답에
    `source_id`를 명시로 싣는다(단건 story 엔드포인트는 URL이 이미 source를 담아 생략했지만,
    여러 story가 섞이는 이 응답에선 각 행이 어느 story에서 왔는지를 알아야 간선을 그린다)."""
    goal = await repo.get(id)
    if goal is None:
        raise HTTPException(status_code=404, detail="Goal not found")
    await require_project_access(repo.session, uuid.UUID(auth.user_id), goal.project_id, repo.org_id,
                                  not_found_detail="Goal not found")

    from app.services.reference_semantic_candidates import list_candidates_for_epic_stories

    candidates = await list_candidates_for_epic_stories(repo.session, org_id=repo.org_id, epic_id=id)
    return [
        {
            "id": str(c.id),
            "source_id": str(c.source_id),
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


class GoalTransitionRequest(BaseModel):
    status: str
    # story #2843 — active→done 전이의 outcome 판정 계약(선택 — 미제공은 unmeasured 자동 마킹).
    outcome_status: str | None = None
    outcome_result: dict | None = None


@router.post("/{id}/transition", response_model=GoalResponse)
async def transition_goal_endpoint(
    id: uuid.UUID,
    body: GoalTransitionRequest,
    session: AsyncSession = Depends(get_db),
    org_id: uuid.UUID = Depends(get_verified_org_id),
    auth: AuthContext = Depends(get_current_user),
) -> GoalResponse:
    """E-DG S25: goal decision lifecycle 전이(create/update 분리). draft→active(human-only)·active→done
    line overlay. caller 는 인증 컨텍스트에서 도출(RC① 패턴·body 신뢰 X)."""
    from sqlalchemy import select

    from app.models.pm import Goal
    from app.services.goal import GoalTransitionError, transition_goal
    from app.services.goal_events import emit_goal_status_changed
    from app.services.member_resolver import resolve_member

    caller = await resolve_member(auth, org_id, session)
    try:
        # E-GLANCE wedge #2: 전이 前 old_status 포착(overlay-gate로 실제 미변경일 수도 있음 —
        # emit_goal_status_changed가 old==new no-op 자체 가드하므로 안전).
        _old_status = (await session.execute(
            select(Goal.status).where(Goal.id == id, Goal.org_id == org_id)
        )).scalar_one_or_none()
        goal = await transition_goal(
            session, org_id, caller, id, body.status,
            outcome_status=body.outcome_status, outcome_result=body.outcome_result,
        )
        await session.commit()
        await emit_goal_status_changed(session, org_id, goal, _old_status, actor_id=caller.id)
        # story #2459 회귀 동형 방어(2026-08-05): commit 後 model_validate 前 명시 refresh.
        await session.refresh(goal)
        await _attach_org_project_slugs(session, org_id, [goal])
        return GoalResponse.model_validate(goal)
    except GoalTransitionError as e:
        _codes = {
            "EPIC_NOT_FOUND": 404, "HUMAN_CONFIRM_REQUIRED": 403,
            "INVALID_STATUS": 422, "INVALID_EPIC_TRANSITION": 422,
            # story #2843
            "INVALID_OUTCOME_STATUS": 422, "OUTCOME_RESULT_REQUIRED": 422,
            "OUTCOME_REASON_REQUIRED": 422,
        }
        raise HTTPException(
            status_code=_codes.get(e.code, 400), detail={"code": e.code, "message": e.message}
        )
