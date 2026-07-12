import uuid
from datetime import datetime

from fastapi import APIRouter, Depends, HTTPException, Query, Response
from pydantic import BaseModel
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.dependencies.auth import AuthContext, enforce_body_context, get_current_user, get_verified_org_id
from app.dependencies.database import get_db
from app.repositories.epic import EpicRepository
from app.schemas.epic import EpicCreate, EpicProgressResponse, EpicResponse, EpicUpdate
from app.services.project_auth import has_project_access

router = APIRouter(prefix="/api/v2/epics", tags=["epics"])


def _get_repo(
    session: AsyncSession = Depends(get_db),
    org_id: uuid.UUID = Depends(get_verified_org_id),
) -> EpicRepository:
    return EpicRepository(session, org_id)


@router.get("", response_model=list[EpicResponse])
async def list_epics(
    response: Response,
    project_id: uuid.UUID | None = Query(default=None),
    status_filter: str | None = Query(default=None, alias="status"),
    limit: int | None = Query(default=None, ge=1, le=2000),
    cursor: str | None = Query(default=None, description="Cursor: ISO 8601 created_at, fetch before this time"),
    order_by: str = Query(default="created_at"),
    repo: EpicRepository = Depends(_get_repo),
    org_id: uuid.UUID = Depends(get_verified_org_id),
    auth: AuthContext = Depends(get_current_user),
) -> list[EpicResponse]:
    """에픽 목록 — true cursor 페이지네이션 + 전체 카운트(X-Total-Count 헤더).

    1000+ 에픽이 조용히 잘리던 문제(#1200/569f5316)를 근절: limit/cursor로 위임
    페이지네이션하고, 페이지와 무관한 전체 개수를 X-Total-Count로 노출한다.
    limit 미지정 시 기존 동작(최대 1000)과 호환되며, 1000+ 인 경우에도 헤더로
    잘림 여부를 호출자가 인지할 수 있어 silent-truncation이 아니다.
    """
    # ratchet round8(잔여 HIGH): project_id 필터(지정 시)에 caller 접근권 검증이 없어
    # same-org cross-project epic(제목/목표/전략의도)이 노출됐다 — resource-actual
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

    epics, total = await repo.list_paginated(
        limit=limit, cursor=cursor_dt, order_by=order_by, **filters
    )
    response.headers["X-Total-Count"] = str(total)
    # order_by="position"(옵트인 로드맵 조타 정렬, wedge #2)은 복합 정렬이라 created_at cursor로
    # 이어붙일 수 없다 — 이 모드에서는 X-Next-Cursor 미노출(호출자가 이어달리기 시도 안 하도록).
    if epics and order_by != "position":
        response.headers["X-Next-Cursor"] = epics[-1].created_at.isoformat()
    return [EpicResponse.model_validate(e) for e in epics]


def _resolve_outcome_status(metric_definition: object, measure_after: object, current_status: str = "n_a") -> str:
    """intent가 완전히 선언(md+ma 둘 다 세팅)되면 n_a→pending 전이."""
    if metric_definition and measure_after and current_status == "n_a":
        return "pending"
    return current_status


@router.post("", response_model=EpicResponse, status_code=201)
async def create_epic(
    body: EpicCreate,
    session: AsyncSession = Depends(get_db),
    auth: AuthContext = Depends(get_current_user),
    org_id: uuid.UUID = Depends(get_verified_org_id),
) -> EpicResponse:
    await enforce_body_context(
        auth_org_id=org_id,
        body_org_id=body.org_id,
        body_project_id=body.project_id,
        auth_project_id=auth.claims.get("app_metadata", {}).get("project_id"),
        db=session,
        user_id=uuid.UUID(auth.user_id),
    )
    repo = EpicRepository(session, org_id)
    epic = await repo.create(
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
    from app.services.epic_events import emit_epic_created
    from app.services.member_resolver import resolve_member

    _actor_id: uuid.UUID | None = None
    try:
        _actor_id = (await resolve_member(auth, org_id, session)).id
    except Exception:  # noqa: BLE001
        _actor_id = None
    await emit_epic_created(session, org_id, epic, actor_id=_actor_id)
    return EpicResponse.model_validate(epic)


@router.get("/{id}", response_model=EpicResponse)
async def get_epic(
    id: uuid.UUID,
    repo: EpicRepository = Depends(_get_repo),
) -> EpicResponse:
    epic = await repo.get(id)
    if epic is None:
        raise HTTPException(status_code=404, detail="Epic not found")
    return EpicResponse.model_validate(epic)


class BulkEpicPositionItem(BaseModel):
    id: uuid.UUID
    position: int


class BulkEpicPositionRequest(BaseModel):
    # stories.py bulk_update_stories와 동일 계약(items 래퍼) — FE dnd 공통 패턴.
    items: list[BulkEpicPositionItem]


class SteerDispatchRequest(BaseModel):
    """STEER 조타 커밋(ff662876). items=커밋된 순서 스냅샷(드래그로 이미 /bulk 저장된 상태와
    일치해야 함·서버 정합검증). recipient_member_ids=인간이 커밋 시 지정(생략/빈 값이면 대상
    project의 relay-owner=오케스트레이터 기본 프리필)."""
    items: list[BulkEpicPositionItem]
    recipient_member_ids: list[uuid.UUID] | None = None


# ⚠️ /bulk 은 /{id} 보다 **먼저** 선언해야 한다(FastAPI 라우트 매칭=선언 순서·specific-before-
# parameterized) — stories.py bulk_update_stories와 동일 교훈(PATCH /bulk가 /{id}에 매칭돼
# id="bulk" UUID 파싱 422로 shadow되는 사고 재발 방지).
@router.patch("/bulk", response_model=list[EpicResponse])
async def bulk_update_epics(
    payload: BulkEpicPositionRequest,
    session: AsyncSession = Depends(get_db),
    org_id: uuid.UUID = Depends(get_verified_org_id),
    auth: AuthContext = Depends(get_current_user),
) -> list[EpicResponse]:
    """PATCH /api/v2/epics/bulk — 로드맵 조타(재정렬, story 96b19bc3 §1.4).

    SEC-S8 W/W2 하드닝을 **처음부터** 내장(bulk_update_stories 템플릿 그대로 이식 — 회귀로
    나중에 패치하지 않고 설계 단계서 봉인): org_id 필터로 cross-org IDOR 원천 차단(W) +
    has_project_access(대상 epic.project_id, resource-actual — body-claimed 아님)로 same-org
    cross-project도 차단(W2). 미접근 item은 not-found와 동형으로 조용히 스킵(존재 비노출·
    나머지 정당 item은 진행).
    """
    from app.models.pm import Epic

    updated: list[Epic] = []
    for item in payload.items:
        q = await session.execute(
            select(Epic).where(Epic.id == item.id, Epic.org_id == org_id)
        )
        epic = q.scalar_one_or_none()
        if not epic:
            continue
        if not await has_project_access(session, uuid.UUID(auth.user_id), epic.project_id, org_id):
            continue
        epic.position = item.position
        updated.append(epic)

    # P0/MissingGreenlet: setattr 후 flush만으로는 onupdate 서버생성 컬럼(updated_at)이 파이썬
    # 객체에 반영 안 됨 — bulk_update_stories와 동형으로 flush+refresh 후 commit.
    await session.flush()
    for e in updated:
        await session.refresh(e)
    await session.commit()

    # STEER 커밋-모델(ff662876·선생님 재정의): 드래그 재정렬은 **이벤트 0**(순수 초안 저장)이다.
    # 인간이 로드맵을 A→B→다시A로 번복하는 사고과정은 사적 초안이라 실시간 이벤트로 새면 안 된다.
    # epic.reordered 발화는 명시적 조타 커밋(POST /epics/steer-dispatch)에서만 1회. 여기선 emit 없음.
    return [EpicResponse.model_validate(e) for e in updated]


# ⚠️ /steer-dispatch 도 /{id} 보다 먼저 선언(정적 경로 shadow 방지 — /bulk와 동일 교훈).
@router.post("/steer-dispatch", status_code=200)
async def steer_dispatch(
    payload: SteerDispatchRequest,
    session: AsyncSession = Depends(get_db),
    org_id: uuid.UUID = Depends(get_verified_org_id),
    auth: AuthContext = Depends(get_current_user),
) -> dict:
    """STEER 조타 커밋-디스패치(ff662876·선생님 재정의). 드래그(PATCH /epics/bulk)는 무이벤트
    초안 저장이고, 이 명시적 커밋에서만 epic.reordered를 1회 발화한다(확定된 결정의 전달·초안
    사고과정 비노출). 커밋 endpoint는 신규 mutation 인가표면이므로(add_feedback 교훈): 대상 epic
    has_project_access(resource-actual) + recipient_member_ids 각각이 caller org 소속 member인지
    검증(body-claimed/cross-org 주입 차단).
    """
    from app.models.pm import Epic
    from app.services.epic_events import emit_epic_reordered
    from app.services.member_resolver import resolve_member, resolve_member_identity
    from app.services.project_auth import resolve_project_relay_owner

    if not payload.items:
        raise HTTPException(status_code=400, detail="items required")

    # 1) 대상 epic 검증 + 서버 정합검증(Q1: payload 스냅샷 신뢰하되 저장 position과 대조).
    committed: list[dict] = []
    project_ids: set[uuid.UUID] = set()
    for item in payload.items:
        epic = (await session.execute(
            select(Epic).where(Epic.id == item.id, Epic.org_id == org_id)
        )).scalar_one_or_none()
        if epic is None:
            raise HTTPException(status_code=404, detail="Epic not found")
        if not await has_project_access(session, uuid.UUID(auth.user_id), epic.project_id, org_id):
            raise HTTPException(status_code=403, detail="No access to this project")
        # 커밋 스냅샷 position이 이미 /bulk로 저장된 확定 상태와 일치해야(미저장/경합 시 409 —
        # 커밋은 저장된 결정의 전달이지 재-write가 아니다).
        if epic.position != item.position:
            raise HTTPException(status_code=409, detail="Position snapshot conflict — save draft before dispatch")
        committed.append({
            "id": epic.id, "title": epic.title, "project_id": epic.project_id,
            "position": epic.position, "old_position": None,
        })
        project_ids.add(epic.project_id)

    # 2) 수신자 해소. 지정 시 각각 caller org 소속 검증(cross-org 주입 차단), 생략 시 대상 project
    #    relay-owner(=orchestrator) union 프리필(신규 원천데이터 불요).
    recipients: set[uuid.UUID] = set()
    if payload.recipient_member_ids:
        for mid in payload.recipient_member_ids:
            if await resolve_member_identity(mid, org_id, session) is None:
                raise HTTPException(status_code=400, detail="recipient_member_id not in org")
            recipients.add(mid)
    else:
        for pid in project_ids:
            owner = await resolve_project_relay_owner(session, pid, org_id)
            if owner is not None:
                recipients.add(owner)

    # 3) actor(best-effort) + emit 1회(지정 수신자 게이팅·preserve_broadcast=False).
    actor_id: uuid.UUID | None = None
    try:
        actor_id = (await resolve_member(auth, org_id, session)).id
    except Exception:  # noqa: BLE001
        actor_id = None
    await emit_epic_reordered(session, org_id, committed, recipients, actor_id=actor_id)

    return {
        "dispatched": True,
        "epic_count": len(committed),
        "recipient_member_ids": [str(r) for r in recipients],
    }


@router.patch("/{id}", response_model=EpicResponse)
async def update_epic(
    id: uuid.UUID,
    body: EpicUpdate,
    repo: EpicRepository = Depends(_get_repo),
) -> EpicResponse:
    current = await repo.get(id)
    if current is None:
        raise HTTPException(status_code=404, detail="Epic not found")
    data = body.model_dump(exclude_unset=True)
    # ⭐RC#2(D1' 봉인): epic status(lifecycle) **변경**은 generic PATCH 금지 — 전용 transition 엔드포인트
    # (POST /epics/{id}/transition)가 FSM(_EPIC_VALID_TRANSITIONS)+SoD+overlay-gate 보유. generic 으로
    # 변경 보내면 그 3중 가드 우회. ⭐미변경 동봉(status==current)은 무시(FE always-send 호환·no-op·
    # RC#1 resolver_id "잔류하되 무시" 동형). outcome_status(아래)는 별개 필드라 무관.
    if "status" in data:
        if data["status"] != current.status:
            raise HTTPException(
                status_code=422,
                detail="epic status 변경은 POST /epics/{id}/transition 전용 엔드포인트를 사용하세요 "
                       "(FSM·SoD·gate 우회 방지).",
            )
        data.pop("status", None)
    # intent가 이번 업데이트로 완성되면 n_a→pending 전이
    effective_md = data.get("metric_definition", current.metric_definition)
    effective_ma = data.get("measure_after", current.measure_after)
    new_status = _resolve_outcome_status(effective_md, effective_ma, current.outcome_status)
    if new_status != current.outcome_status:
        data["outcome_status"] = new_status
    epic = await repo.update(id, **data)
    if epic is None:
        raise HTTPException(status_code=404, detail="Epic not found")
    return EpicResponse.model_validate(epic)


@router.delete("/{id}", status_code=200)
async def delete_epic(
    id: uuid.UUID,
    repo: EpicRepository = Depends(_get_repo),
    session: AsyncSession = Depends(get_db),
    auth: AuthContext = Depends(get_current_user),
    org_id: uuid.UUID = Depends(get_verified_org_id),
) -> dict:
    """에픽 삭제 — admin/owner 전용 게이트.

    파괴적 작업이므로 org-level owner/admin 만 허용한다. FE 의 requireRole 게이트는
    Supabase 레거시(db=undefined) 의존으로 깨져 있었고 그게 유일한 admin/owner 가드였다.
    삭제하면 권한 누수(org member/viewer 가 에픽 삭제)이므로 authz 를 BE SSOT 로 옮긴다.
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
    epic = await repo.get(id)
    if epic is None:
        raise HTTPException(status_code=404, detail="Epic not found")

    resolved = await resolve_member(auth, org_id, session)
    if resolved.type != "human":
        raise HTTPException(status_code=403, detail="Epic 삭제는 휴먼 멤버만 가능합니다 (에이전트 API키 차단)")

    if not await is_org_owner_or_admin(session, uuid.UUID(auth.user_id), org_id):
        raise HTTPException(
            status_code=403, detail="Epic deletion requires admin or owner role"
        )

    from app.models.deletion_audit import DeletionAuditLog
    session.add(DeletionAuditLog(
        id=uuid.uuid4(), org_id=org_id, actor_id=resolved.id,
        entity_type="epic", entity_id=id, entity_title=epic.title,
    ))
    # E-GLANCE wedge #2: 삭제 前 title/project_id 캡처(삭제 後 조회 불가) — epic.removed 이벤트용.
    _epic_title = epic.title
    _epic_project_id = epic.project_id
    ok = await repo.delete(id)
    if not ok:
        raise HTTPException(status_code=404, detail="Epic not found")
    await DependencyRepository(session, org_id).delete_by_item(id, "epic")
    await ItemLabelRepository(session, org_id).delete_by_item(id, "epic")

    from app.services.epic_events import emit_epic_removed
    await emit_epic_removed(
        session, org_id, id, _epic_title, _epic_project_id, actor_id=resolved.id,
    )
    return {"ok": True}


@router.get("/{id}/progress", response_model=EpicProgressResponse)
async def get_epic_progress(
    id: uuid.UUID,
    repo: EpicRepository = Depends(_get_repo),
) -> EpicProgressResponse:
    epic = await repo.get(id)
    if epic is None:
        raise HTTPException(status_code=404, detail="Epic not found")
    return await repo.get_progress(id)


class EpicTransitionRequest(BaseModel):
    status: str


@router.post("/{id}/transition", response_model=EpicResponse)
async def transition_epic_endpoint(
    id: uuid.UUID,
    body: EpicTransitionRequest,
    session: AsyncSession = Depends(get_db),
    org_id: uuid.UUID = Depends(get_verified_org_id),
    auth: AuthContext = Depends(get_current_user),
) -> EpicResponse:
    """E-DG S25: epic decision lifecycle 전이(create/update 분리). draft→active(human-only)·active→done
    line overlay. caller 는 인증 컨텍스트에서 도출(RC① 패턴·body 신뢰 X)."""
    from sqlalchemy import select

    from app.models.pm import Epic
    from app.services.epic import EpicTransitionError, transition_epic
    from app.services.epic_events import emit_epic_status_changed
    from app.services.member_resolver import resolve_member

    caller = await resolve_member(auth, org_id, session)
    try:
        # E-GLANCE wedge #2: 전이 前 old_status 포착(overlay-gate로 실제 미변경일 수도 있음 —
        # emit_epic_status_changed가 old==new no-op 자체 가드하므로 안전).
        _old_status = (await session.execute(
            select(Epic.status).where(Epic.id == id, Epic.org_id == org_id)
        )).scalar_one_or_none()
        epic = await transition_epic(session, org_id, caller, id, body.status)
        await session.commit()
        await emit_epic_status_changed(session, org_id, epic, _old_status, actor_id=caller.id)
        return EpicResponse.model_validate(epic)
    except EpicTransitionError as e:
        _codes = {
            "EPIC_NOT_FOUND": 404, "HUMAN_CONFIRM_REQUIRED": 403,
            "INVALID_STATUS": 422, "INVALID_EPIC_TRANSITION": 422,
        }
        raise HTTPException(
            status_code=_codes.get(e.code, 400), detail={"code": e.code, "message": e.message}
        )
