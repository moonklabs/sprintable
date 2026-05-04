import uuid

from fastapi import APIRouter, Depends, Header, HTTPException, Query, Response, status
from sqlalchemy.ext.asyncio import AsyncSession

from app.dependencies.auth import AuthContext, get_current_user
from app.dependencies.database import get_db
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
    auth: AuthContext = Depends(get_current_user),
    x_org_id: str | None = Header(default=None, alias="X-Org-Id"),
) -> RetroSessionRepository:
    org_id_str = auth.claims.get("app_metadata", {}).get("org_id") or x_org_id
    if not org_id_str:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="org_id required",
        )
    return RetroSessionRepository(db, uuid.UUID(str(org_id_str)))


@router.get("", response_model=list[SessionListResponse])
async def list_sessions(
    project_id: uuid.UUID | None = Query(default=None),
    sprint_id: uuid.UUID | None = Query(default=None),
    repo: RetroSessionRepository = Depends(_get_session_repo),
) -> list[SessionListResponse]:
    filters: dict = {}
    if project_id:
        filters["project_id"] = project_id
    if sprint_id:
        filters["sprint_id"] = sprint_id
    sessions = await repo.list(**filters)
    return [SessionListResponse.model_validate(s) for s in sessions]


@router.post("", response_model=SessionListResponse, status_code=201)
async def create_session(
    body: CreateSession,
    db: AsyncSession = Depends(get_db),
    _auth: AuthContext = Depends(get_current_user),
) -> SessionListResponse:
    repo = RetroSessionRepository(db, body.org_id)
    session = await repo.create(
        project_id=body.project_id,
        title=body.title,
        sprint_id=body.sprint_id,
        created_by=body.created_by,
    )
    return SessionListResponse.model_validate(session)


@router.get("/{id}", response_model=SessionResponse)
async def get_session(
    id: uuid.UUID,
    db: AsyncSession = Depends(get_db),
    repo: RetroSessionRepository = Depends(_get_session_repo),
) -> SessionResponse:
    session = await repo.get(id)
    if session is None:
        raise HTTPException(status_code=404, detail="Retro session not found")

    item_repo = RetroItemRepository(db)
    action_repo = RetroActionRepository(db)
    items = await item_repo.list_by_session(id)
    actions = await action_repo.list_by_session(id)

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
        items=[ItemResponse.model_validate(i) for i in items],
        actions=[ActionResponse.model_validate(a) for a in actions],
    )


@router.patch("/{id}/phase", response_model=SessionListResponse)
async def advance_phase(
    id: uuid.UUID,
    body: PhaseTransition,
    repo: RetroSessionRepository = Depends(_get_session_repo),
) -> SessionListResponse:
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
    repo: RetroSessionRepository = Depends(_get_session_repo),
) -> ItemResponse:
    session = await repo.get(id)
    if session is None:
        raise HTTPException(status_code=404, detail="Retro session not found")
    item_repo = RetroItemRepository(db)
    item = await item_repo.create(
        session_id=id, category=body.category, text=body.text, author_id=body.author_id
    )
    return ItemResponse.model_validate(item)


@router.delete("/{id}/items/{item_id}", status_code=200)
async def delete_item(
    id: uuid.UUID,
    item_id: uuid.UUID,
    db: AsyncSession = Depends(get_db),
    repo: RetroSessionRepository = Depends(_get_session_repo),
) -> dict:
    session = await repo.get(id)
    if session is None:
        raise HTTPException(status_code=404, detail="Retro session not found")
    item_repo = RetroItemRepository(db)
    ok = await item_repo.delete(item_id)
    if not ok:
        raise HTTPException(status_code=404, detail="Item not found")
    return {"ok": True}


@router.post("/{id}/items/{item_id}/vote", response_model=VoteResponse, status_code=201)
async def vote_item(
    id: uuid.UUID,
    item_id: uuid.UUID,
    voter_id: uuid.UUID = Query(...),
    db: AsyncSession = Depends(get_db),
    repo: RetroSessionRepository = Depends(_get_session_repo),
) -> VoteResponse:
    session = await repo.get(id)
    if session is None:
        raise HTTPException(status_code=404, detail="Retro session not found")
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
    repo: RetroSessionRepository = Depends(_get_session_repo),
) -> list[ActionResponse]:
    session = await repo.get(id)
    if session is None:
        raise HTTPException(status_code=404, detail="Retro session not found")
    action_repo = RetroActionRepository(db)
    actions = await action_repo.list_by_session(id)
    return [ActionResponse.model_validate(a) for a in actions]


@router.post("/{id}/actions", response_model=ActionResponse, status_code=201)
async def create_action(
    id: uuid.UUID,
    body: CreateAction,
    db: AsyncSession = Depends(get_db),
    repo: RetroSessionRepository = Depends(_get_session_repo),
) -> ActionResponse:
    session = await repo.get(id)
    if session is None:
        raise HTTPException(status_code=404, detail="Retro session not found")
    action_repo = RetroActionRepository(db)
    action = await action_repo.create(
        session_id=id, title=body.title, assignee_id=body.assignee_id
    )
    return ActionResponse.model_validate(action)


@router.patch("/{id}/actions/{action_id}", response_model=ActionResponse)
async def update_action(
    id: uuid.UUID,
    action_id: uuid.UUID,
    body: UpdateAction,
    db: AsyncSession = Depends(get_db),
    repo: RetroSessionRepository = Depends(_get_session_repo),
) -> ActionResponse:
    session = await repo.get(id)
    if session is None:
        raise HTTPException(status_code=404, detail="Retro session not found")
    action_repo = RetroActionRepository(db)
    data = body.model_dump(exclude_unset=True)
    action = await action_repo.update(action_id, **data)
    if action is None:
        raise HTTPException(status_code=404, detail="Action not found")
    return ActionResponse.model_validate(action)


@router.get("/{id}/export")
async def export_session(
    id: uuid.UUID,
    db: AsyncSession = Depends(get_db),
    repo: RetroSessionRepository = Depends(_get_session_repo),
) -> Response:
    session = await repo.get(id)
    if session is None:
        raise HTTPException(status_code=404, detail="Retro session not found")

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
