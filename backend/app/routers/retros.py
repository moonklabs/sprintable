import uuid

from fastapi import APIRouter, Depends, HTTPException, Query, Response
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.dependencies.auth import AuthContext, get_current_user, get_verified_org_id
from app.dependencies.database import get_db
from app.models.retro import RetroItem, RetroSession, RetroVote
from app.services.member_resolver import canonicalize_member_id, resolve_member
from app.services.project_auth import has_project_access
from app.repositories.retro import (
    RetroActionRepository,
    RetroItemRepository,
    RetroSessionRepository,
    RetroVoteRepository,
)
from app.schemas.retro import (
    ActionResponse,
    CreateAction,
    CreateItem,
    CreateSession,
    ItemResponse,
    PhaseTransition,
    SessionListResponse,
    SessionResponse,
    UpdateAction,
    VoteResponse,
)

router = APIRouter(prefix="/api/v2/retros", tags=["retros"])


def _get_session_repo(
    db: AsyncSession = Depends(get_db),
    org_id: uuid.UUID = Depends(get_verified_org_id),
) -> RetroSessionRepository:
    return RetroSessionRepository(db, org_id)


async def _require_retro_project_access(
    session: AsyncSession, session_id: uuid.UUID, user_id: uuid.UUID, org_id: uuid.UUID
) -> RetroSession:
    """대상 retro session의 canonical project-scope authz(doc-gate #1796 `_require_doc_project_access`
    와 동일 패턴). session을 org-scope로 로드하고 caller의 그 session project 접근(has_project_access
    SSOT=team_member∪grant∪owner/admin)을 강제 — 없으면 404·무권한 403. 기존 `_get_session_repo`가
    org-level만 검증해 same-org cross-project IDOR가 있었음(#1801 까심 QA HIGH). 반환=로드된
    session(caller 재사용 가능)."""
    retro = (
        await session.execute(
            select(RetroSession).where(RetroSession.id == session_id, RetroSession.org_id == org_id)
        )
    ).scalar_one_or_none()
    if retro is None:
        raise HTTPException(status_code=404, detail="Retro session not found")
    if not await has_project_access(session, user_id, retro.project_id, org_id):
        raise HTTPException(status_code=403, detail="해당 회고의 프로젝트 접근 권한이 없습니다")
    return retro


async def _require_item_in_session(
    session: AsyncSession, session_id: uuid.UUID, item_id: uuid.UUID
) -> RetroItem:
    """item_id가 session_id 소속인지 확인(2차 IDOR 방어 — item_id를 타 session 것으로 조작해
    부모 session project-access 체크만 우회하는 것 차단)."""
    item = (
        await session.execute(
            select(RetroItem).where(RetroItem.id == item_id, RetroItem.session_id == session_id)
        )
    ).scalar_one_or_none()
    if item is None:
        raise HTTPException(status_code=404, detail="Item not found")
    return item


@router.get("", response_model=list[SessionListResponse])
async def list_sessions(
    project_id: uuid.UUID | None = Query(default=None),
    sprint_id: uuid.UUID | None = Query(default=None),
    db: AsyncSession = Depends(get_db),
    auth: AuthContext = Depends(get_current_user),
    repo: RetroSessionRepository = Depends(_get_session_repo),
) -> list[SessionListResponse]:
    user_id = uuid.UUID(auth.user_id)
    if project_id is not None:
        # 명시 필터 시 그 프로젝트 접근권 선검증(무권한 project_id로 org 존재 여부 탐색 차단).
        if not await has_project_access(db, user_id, project_id, repo.org_id):
            raise HTTPException(status_code=403, detail="해당 프로젝트 접근 권한이 없습니다")
    filters: dict = {}
    if project_id:
        filters["project_id"] = project_id
    if sprint_id:
        filters["sprint_id"] = sprint_id
    sessions = await repo.list(**filters)
    if project_id is None:
        # project_id 생략 시 org 전체 세션이 나오던 갭 — 각 세션의 실제 project 접근권으로 필터.
        sessions = [
            s for s in sessions if await has_project_access(db, user_id, s.project_id, repo.org_id)
        ]
    return [SessionListResponse.model_validate(s) for s in sessions]


@router.post("", response_model=SessionListResponse, status_code=201)
async def create_session(
    body: CreateSession,
    db: AsyncSession = Depends(get_db),
    auth: AuthContext = Depends(get_current_user),
    org_id: uuid.UUID = Depends(get_verified_org_id),
) -> SessionListResponse:
    # body.project_id 를 검증 없이 신뢰하면 무권한 project 에 session 을 심는 mutation IDOR.
    if not await has_project_access(db, uuid.UUID(auth.user_id), body.project_id, org_id):
        raise HTTPException(status_code=403, detail="해당 프로젝트 접근 권한이 없습니다")
    repo = RetroSessionRepository(db, org_id)
    session = await repo.create(
        project_id=body.project_id,
        title=body.title,
        sprint_id=body.sprint_id,
        # AC3-2d(1b): 작성자 식별자 canonical 정규화(레거시 휴먼 tm.id→members.id). (A) write.
        created_by=(await canonicalize_member_id(body.created_by, db)) if body.created_by else None,
    )
    return SessionListResponse.model_validate(session)


@router.get("/{id}", response_model=SessionResponse)
async def get_session(
    id: uuid.UUID,
    db: AsyncSession = Depends(get_db),
    auth: AuthContext = Depends(get_current_user),
    repo: RetroSessionRepository = Depends(_get_session_repo),
) -> SessionResponse:
    session = await _require_retro_project_access(db, id, uuid.UUID(auth.user_id), repo.org_id)

    item_repo = RetroItemRepository(db)
    action_repo = RetroActionRepository(db)
    items = await item_repo.list_by_session(id)
    actions = await action_repo.list_by_session(id)

    # B4: voted_by_me — client 지정 voter_id 무신뢰. auth 로 canonical requester id 를 직접 해소
    # (RetroVote.voter_id 는 vote 시 canonicalize_member_id 를 거친 members.id 공간이고, 휴먼은
    # members.id=org_members.id 로 ID-preserving 백필돼 resolve_member(레거시 경로).id 와 동일
    # 공간 — 별도 매핑 불요).
    resolved = await resolve_member(auth, session.org_id, db, project_id=session.project_id)
    voted_item_ids: set[uuid.UUID] = set()
    if items:
        voted_rows = await db.execute(
            select(RetroVote.item_id).where(
                RetroVote.voter_id == resolved.id,
                RetroVote.item_id.in_([i.id for i in items]),
            )
        )
        voted_item_ids = set(voted_rows.scalars().all())

    return SessionResponse(
        id=session.id,
        project_id=session.project_id,
        org_id=session.org_id,
        sprint_id=session.sprint_id,
        created_by=session.created_by,
        title=session.title,
        phase=session.phase,
        created_at=session.created_at,
        updated_at=session.updated_at,
        items=[
            ItemResponse(
                id=i.id,
                session_id=i.session_id,
                author_id=i.author_id,
                category=i.category,
                text=i.text,
                vote_count=i.vote_count,
                created_at=i.created_at,
                voted_by_me=i.id in voted_item_ids,
            )
            for i in items
        ],
        actions=[ActionResponse.model_validate(a) for a in actions],
    )


@router.patch("/{id}/phase", response_model=SessionListResponse)
async def advance_phase(
    id: uuid.UUID,
    body: PhaseTransition,
    db: AsyncSession = Depends(get_db),
    auth: AuthContext = Depends(get_current_user),
    repo: RetroSessionRepository = Depends(_get_session_repo),
) -> SessionListResponse:
    await _require_retro_project_access(db, id, uuid.UUID(auth.user_id), repo.org_id)
    try:
        session = await repo.set_phase(id, body.phase)
    except (ValueError, Exception) as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    return SessionListResponse.model_validate(session)


@router.post("/{id}/items", response_model=ItemResponse, status_code=201)
async def add_item(
    id: uuid.UUID,
    body: CreateItem,
    db: AsyncSession = Depends(get_db),
    auth: AuthContext = Depends(get_current_user),
    repo: RetroSessionRepository = Depends(_get_session_repo),
) -> ItemResponse:
    await _require_retro_project_access(db, id, uuid.UUID(auth.user_id), repo.org_id)
    item_repo = RetroItemRepository(db)
    author_id = (await canonicalize_member_id(body.author_id, db)) if body.author_id else None
    item = await item_repo.create(
        session_id=id, category=body.category, text=body.text, author_id=author_id
    )
    return ItemResponse.model_validate(item)


@router.delete("/{id}/items/{item_id}", status_code=200)
async def delete_item(
    id: uuid.UUID,
    item_id: uuid.UUID,
    db: AsyncSession = Depends(get_db),
    auth: AuthContext = Depends(get_current_user),
    repo: RetroSessionRepository = Depends(_get_session_repo),
) -> dict:
    await _require_retro_project_access(db, id, uuid.UUID(auth.user_id), repo.org_id)
    item_repo = RetroItemRepository(db)
    ok = await item_repo.delete_from_session(id, item_id)
    if not ok:
        raise HTTPException(status_code=404, detail="Item not found")
    return {"ok": True}


@router.post("/{id}/items/{item_id}/vote", response_model=VoteResponse, status_code=201)
async def vote_item(
    id: uuid.UUID,
    item_id: uuid.UUID,
    voter_id: uuid.UUID = Query(...),
    db: AsyncSession = Depends(get_db),
    auth: AuthContext = Depends(get_current_user),
    repo: RetroSessionRepository = Depends(_get_session_repo),
) -> VoteResponse:
    await _require_retro_project_access(db, id, uuid.UUID(auth.user_id), repo.org_id)
    await _require_item_in_session(db, id, item_id)
    voter_id = await canonicalize_member_id(voter_id, db)  # AC3-2d(1b): canonical 정규화
    vote_repo = RetroVoteRepository(db)
    try:
        vote = await vote_repo.vote(item_id, voter_id)
    except ValueError as exc:
        if "DUPLICATE_VOTE" in str(exc):
            raise HTTPException(status_code=409, detail="Already voted") from exc
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    return VoteResponse.model_validate(vote)


@router.get("/{id}/actions", response_model=list[ActionResponse])
async def list_actions(
    id: uuid.UUID,
    db: AsyncSession = Depends(get_db),
    auth: AuthContext = Depends(get_current_user),
    repo: RetroSessionRepository = Depends(_get_session_repo),
) -> list[ActionResponse]:
    await _require_retro_project_access(db, id, uuid.UUID(auth.user_id), repo.org_id)
    action_repo = RetroActionRepository(db)
    actions = await action_repo.list_by_session(id)
    return [ActionResponse.model_validate(a) for a in actions]


@router.post("/{id}/actions", response_model=ActionResponse, status_code=201)
async def create_action(
    id: uuid.UUID,
    body: CreateAction,
    db: AsyncSession = Depends(get_db),
    auth: AuthContext = Depends(get_current_user),
    repo: RetroSessionRepository = Depends(_get_session_repo),
) -> ActionResponse:
    await _require_retro_project_access(db, id, uuid.UUID(auth.user_id), repo.org_id)
    action_repo = RetroActionRepository(db)
    assignee_id = (await canonicalize_member_id(body.assignee_id, db)) if body.assignee_id else None
    action = await action_repo.create(
        session_id=id, title=body.title, assignee_id=assignee_id
    )
    return ActionResponse.model_validate(action)


@router.patch("/{id}/actions/{action_id}", response_model=ActionResponse)
async def update_action(
    id: uuid.UUID,
    action_id: uuid.UUID,
    body: UpdateAction,
    db: AsyncSession = Depends(get_db),
    auth: AuthContext = Depends(get_current_user),
    repo: RetroSessionRepository = Depends(_get_session_repo),
) -> ActionResponse:
    # #1801 까심 QA HIGH — 이 라우트가 org-only 게이트였던 원 적출 지점.
    await _require_retro_project_access(db, id, uuid.UUID(auth.user_id), repo.org_id)
    action_repo = RetroActionRepository(db)
    data = body.model_dump(exclude_unset=True)
    action = await action_repo.update_in_session(id, action_id, **data)
    if action is None:
        raise HTTPException(status_code=404, detail="Action not found")
    return ActionResponse.model_validate(action)


@router.get("/{id}/export")
async def export_session(
    id: uuid.UUID,
    db: AsyncSession = Depends(get_db),
    auth: AuthContext = Depends(get_current_user),
    repo: RetroSessionRepository = Depends(_get_session_repo),
) -> Response:
    session = await _require_retro_project_access(db, id, uuid.UUID(auth.user_id), repo.org_id)

    item_repo = RetroItemRepository(db)
    action_repo = RetroActionRepository(db)
    items = await item_repo.list_by_session(id)
    actions = await action_repo.list_by_session(id)

    lines = [
        f"# {session.title}",
        f"**Phase:** {session.phase}",
        "",
        "## 잘된 점 (Good)",
        *[f"- {i.text} ({i.vote_count} votes)" for i in items if i.category == "good"],
        "",
        "## 아쉬운 점 (Bad)",
        *[f"- {i.text} ({i.vote_count} votes)" for i in items if i.category == "bad"],
        "",
        "## 개선할 점 (Improve)",
        *[f"- {i.text} ({i.vote_count} votes)" for i in items if i.category == "improve"],
        "",
        "## Action Items",
        *[f"- [{a.status}] {a.title}" for a in actions],
    ]

    return Response(content="\n".join(lines), media_type="text/markdown")
