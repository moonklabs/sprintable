"""E1-S3: /api/v2/hypotheses 라우터 (9 엔드포인트, 블루프린트 §3.2~§3.10).

계약: 성공은 raw model/list 반환, 오류는 HTTPException(dict detail {code,message}) —
main.py 핸들러가 {data:null,error:{code,message,...},meta:null}로 감싼다.

라우트 선언 순서: `/draft`를 `/{id}` 계열보다 먼저 선언한다(§3.9.7 — /bulk shadow #1386 재발 방지).

라우터 레벨 가드(S2에서 인계·AC⑥):
- §3.7.2 cross-project 링크 금지 — 대상 epic/story의 project가 hypothesis와 같아야 한다.
- §3.1.7 'active' 전이는 owner 휴먼 또는 org owner/admin만.
"""
import uuid

from fastapi import APIRouter, Depends, HTTPException, Query, Response
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.dependencies.auth import (
    AuthContext,
    get_current_user,
    get_project_scoped_org_id,
    get_verified_org_id,
)
from app.dependencies.database import get_db
from app.models.pm import Epic, Story
from app.repositories.hypothesis import HypothesisRepository
from app.schemas.hypothesis import (
    HypothesisCreate,
    HypothesisDraftRequest,
    HypothesisDraftResponse,
    HypothesisLinkRequest,
    HypothesisResponse,
    HypothesisTransition,
    HypothesisUnlinkRequest,
    HypothesisUpdate,
)
from app.services import hypothesis as svc
from app.services.member_resolver import ResolvedMember, resolve_member

router = APIRouter(prefix="/api/v2/hypotheses", tags=["hypotheses"])

_ADMIN_ROLES = frozenset({"owner", "admin"})

# 서비스 도메인 오류 code → HTTP status.
_ERROR_STATUS: dict[str, int] = {
    "HUMAN_OWNER_REQUIRED": 400,
    "HUMAN_CONFIRM_REQUIRED": 403,
    "INVALID_CREATE_STATUS": 422,
    "INVALID_STATUS": 422,
    "INVALID_HYPOTHESIS_TRANSITION": 409,
    "NO_VALID_FIELDS": 400,
    "HYPOTHESIS_NOT_FOUND": 404,
    "CROSS_PROJECT_LINK_FORBIDDEN": 403,
}


def _raise(err: svc.HypothesisServiceError) -> None:
    raise HTTPException(
        status_code=_ERROR_STATUS.get(err.code, 400),
        detail={"code": err.code, "message": err.message},
    )


async def _assert_targets_same_project(
    session: AsyncSession,
    project_id: uuid.UUID,
    epic_ids: list[uuid.UUID],
    story_ids: list[uuid.UUID],
) -> None:
    """§3.7.2 — 링크 대상 epic/story가 hypothesis와 다른 project면 403."""
    if epic_ids:
        rows = (await session.execute(
            select(Epic.id, Epic.project_id).where(Epic.id.in_(epic_ids))
        )).all()
        if any(pid != project_id for _id, pid in rows) or len(rows) != len(set(epic_ids)):
            raise HTTPException(
                status_code=403,
                detail={"code": "CROSS_PROJECT_LINK_FORBIDDEN",
                        "message": "다른 프로젝트의 에픽에는 연결할 수 없습니다."},
            )
    if story_ids:
        rows = (await session.execute(
            select(Story.id, Story.project_id).where(Story.id.in_(story_ids))
        )).all()
        if any(pid != project_id for _id, pid in rows) or len(rows) != len(set(story_ids)):
            raise HTTPException(
                status_code=403,
                detail={"code": "CROSS_PROJECT_LINK_FORBIDDEN",
                        "message": "다른 프로젝트의 스토리에는 연결할 수 없습니다."},
            )


def _assert_active_authorized(caller: ResolvedMember, owner_member_id: uuid.UUID) -> None:
    """§3.1.7 — 'active' 전이는 owner 휴먼 또는 org owner/admin만."""
    if caller.id == owner_member_id or caller.role in _ADMIN_ROLES:
        return
    raise HTTPException(
        status_code=403,
        detail={"code": "ACTIVE_TRANSITION_FORBIDDEN",
                "message": "active 전이는 owner 또는 org owner/admin만 가능합니다."},
    )


# ── /draft — /{id} 계열보다 먼저 선언(§3.9.7) ────────────────────────────────────

@router.post("/draft", response_model=HypothesisDraftResponse)
async def draft(
    body: HypothesisDraftRequest,
    session: AsyncSession = Depends(get_db),
    auth: AuthContext = Depends(get_current_user),
    org_id: uuid.UUID = Depends(get_verified_org_id),
) -> HypothesisDraftResponse:
    caller = await resolve_member(auth, org_id, session, project_id=body.project_id)
    try:
        return await svc.draft_hypothesis(session, org_id, caller, body)
    except svc.HypothesisServiceError as err:
        _raise(err)


# ── list / create ──────────────────────────────────────────────────────────────

@router.get("", response_model=list[HypothesisResponse])
async def list_hypotheses(
    response: Response,
    project_id: uuid.UUID = Query(...),
    epic_id: uuid.UUID | None = Query(default=None),
    story_id: uuid.UUID | None = Query(default=None),
    status_filter: str | None = Query(default=None, alias="status"),
    owner_member_id: uuid.UUID | None = Query(default=None),
    limit: int = Query(default=100, ge=1, le=2000),
    session: AsyncSession = Depends(get_db),
    org_id: uuid.UUID = Depends(get_project_scoped_org_id),
) -> list[HypothesisResponse]:
    items = await svc.list_hypotheses(
        session, org_id, project_id,
        status=status_filter, owner_member_id=owner_member_id,
        epic_id=epic_id, story_id=story_id, limit=limit,
    )
    response.headers["X-Total-Count"] = str(len(items))
    return items


@router.post("", response_model=HypothesisResponse, status_code=201)
async def create_hypothesis(
    body: HypothesisCreate,
    session: AsyncSession = Depends(get_db),
    auth: AuthContext = Depends(get_current_user),
    org_id: uuid.UUID = Depends(get_verified_org_id),
) -> HypothesisResponse:
    # resolve_member(project_id)가 프로젝트 접근을 검증한다(§3.1.2).
    caller = await resolve_member(auth, org_id, session, project_id=body.project_id)
    try:
        return await svc.create_hypothesis(session, org_id, caller, body)
    except svc.HypothesisServiceError as err:
        _raise(err)


# ── by-id ────────────────────────────────────────────────────────────────────

@router.get("/{hypothesis_id}", response_model=HypothesisResponse)
async def get_hypothesis(
    hypothesis_id: uuid.UUID,
    session: AsyncSession = Depends(get_db),
    org_id: uuid.UUID = Depends(get_verified_org_id),
) -> HypothesisResponse:
    try:
        return await svc.get_hypothesis(session, org_id, hypothesis_id)
    except svc.HypothesisServiceError as err:
        _raise(err)


@router.patch("/{hypothesis_id}", response_model=HypothesisResponse)
async def update_hypothesis(
    hypothesis_id: uuid.UUID,
    body: HypothesisUpdate,
    session: AsyncSession = Depends(get_db),
    auth: AuthContext = Depends(get_current_user),
    org_id: uuid.UUID = Depends(get_verified_org_id),
) -> HypothesisResponse:
    caller = await resolve_member(auth, org_id, session)
    try:
        return await svc.update_hypothesis(session, org_id, caller, hypothesis_id, body)
    except svc.HypothesisServiceError as err:
        _raise(err)


@router.post("/{hypothesis_id}/transition", response_model=HypothesisResponse)
async def transition_hypothesis(
    hypothesis_id: uuid.UUID,
    body: HypothesisTransition,
    session: AsyncSession = Depends(get_db),
    auth: AuthContext = Depends(get_current_user),
    org_id: uuid.UUID = Depends(get_verified_org_id),
) -> HypothesisResponse:
    caller = await resolve_member(auth, org_id, session)
    # §3.1.7 active 전이 권한은 라우터에서 보강(owner 휴먼 또는 org admin/owner).
    if body.status == "active":
        repo = HypothesisRepository(session, org_id)
        hyp = await repo.get(hypothesis_id)
        if hyp is None:
            raise HTTPException(
                status_code=404,
                detail={"code": "HYPOTHESIS_NOT_FOUND", "message": "가설을 찾을 수 없습니다."},
            )
        _assert_active_authorized(caller, hyp.owner_member_id)
    try:
        return await svc.transition_hypothesis(session, org_id, caller, hypothesis_id, body)
    except svc.HypothesisServiceError as err:
        _raise(err)


@router.post("/{hypothesis_id}/links", response_model=HypothesisResponse)
async def link_hypothesis(
    hypothesis_id: uuid.UUID,
    body: HypothesisLinkRequest,
    session: AsyncSession = Depends(get_db),
    org_id: uuid.UUID = Depends(get_verified_org_id),
) -> HypothesisResponse:
    # §3.7.2 cross-project 링크 금지는 라우터에서 — 대상 epic/story project 대조.
    repo = HypothesisRepository(session, org_id)
    hyp = await repo.get(hypothesis_id)
    if hyp is None:
        raise HTTPException(
            status_code=404,
            detail={"code": "HYPOTHESIS_NOT_FOUND", "message": "가설을 찾을 수 없습니다."},
        )
    await _assert_targets_same_project(session, hyp.project_id, body.epic_ids, body.story_ids)
    try:
        return await svc.link_hypothesis(session, org_id, hypothesis_id, body)
    except svc.HypothesisServiceError as err:
        _raise(err)


@router.delete("/{hypothesis_id}/links", response_model=HypothesisResponse)
async def unlink_hypothesis(
    hypothesis_id: uuid.UUID,
    body: HypothesisUnlinkRequest,
    session: AsyncSession = Depends(get_db),
    org_id: uuid.UUID = Depends(get_verified_org_id),
) -> HypothesisResponse:
    try:
        return await svc.unlink_hypothesis(session, org_id, hypothesis_id, body)
    except svc.HypothesisServiceError as err:
        _raise(err)


@router.delete("/{hypothesis_id}", status_code=200)
async def archive_hypothesis(
    hypothesis_id: uuid.UUID,
    session: AsyncSession = Depends(get_db),
    org_id: uuid.UUID = Depends(get_verified_org_id),
) -> dict:
    try:
        await svc.archive_hypothesis(session, org_id, hypothesis_id)
    except svc.HypothesisServiceError as err:
        _raise(err)
    return {"ok": True}
