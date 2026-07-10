import uuid
from datetime import datetime

from fastapi import APIRouter, Depends, HTTPException, Query, Response
from pydantic import BaseModel
from sqlalchemy.ext.asyncio import AsyncSession

from app.dependencies.auth import AuthContext, enforce_body_context, get_current_user, get_verified_org_id
from app.dependencies.database import get_db
from app.repositories.epic import EpicRepository
from app.schemas.epic import EpicCreate, EpicProgressResponse, EpicResponse, EpicUpdate

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
) -> list[EpicResponse]:
    """에픽 목록 — true cursor 페이지네이션 + 전체 카운트(X-Total-Count 헤더).

    1000+ 에픽이 조용히 잘리던 문제(#1200/569f5316)를 근절: limit/cursor로 위임
    페이지네이션하고, 페이지와 무관한 전체 개수를 X-Total-Count로 노출한다.
    limit 미지정 시 기존 동작(최대 1000)과 호환되며, 1000+ 인 경우에도 헤더로
    잘림 여부를 호출자가 인지할 수 있어 silent-truncation이 아니다.
    """
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
    if epics:
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
    ok = await repo.delete(id)
    if not ok:
        raise HTTPException(status_code=404, detail="Epic not found")
    await DependencyRepository(session, org_id).delete_by_item(id, "epic")
    await ItemLabelRepository(session, org_id).delete_by_item(id, "epic")
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
    from app.services.epic import EpicTransitionError, transition_epic
    from app.services.member_resolver import resolve_member

    caller = await resolve_member(auth, org_id, session)
    try:
        epic = await transition_epic(session, org_id, caller, id, body.status)
        await session.commit()
        return EpicResponse.model_validate(epic)
    except EpicTransitionError as e:
        _codes = {
            "EPIC_NOT_FOUND": 404, "HUMAN_CONFIRM_REQUIRED": 403,
            "INVALID_STATUS": 422, "INVALID_EPIC_TRANSITION": 422,
        }
        raise HTTPException(
            status_code=_codes.get(e.code, 400), detail={"code": e.code, "message": e.message}
        )
