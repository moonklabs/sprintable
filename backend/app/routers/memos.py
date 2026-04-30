import uuid

from fastapi import APIRouter, Depends, Header, HTTPException, Query, status
from sqlalchemy.ext.asyncio import AsyncSession

from app.dependencies.auth import AuthContext, get_current_user
from app.dependencies.database import get_db
from app.repositories.memo import MemoReplyRepository, MemoRepository
from app.schemas.memo import CreateMemo, CreateReply, MemoListResponse, MemoResponse, ReplyResponse, UpdateMemo

router = APIRouter(prefix="/api/v2/memos", tags=["memos"])


def _get_repo(
    session: AsyncSession = Depends(get_db),
    auth: AuthContext = Depends(get_current_user),
    x_org_id: str | None = Header(default=None, alias="X-Org-Id"),
) -> MemoRepository:
    org_id_str = auth.claims.get("app_metadata", {}).get("org_id") or x_org_id
    if not org_id_str:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="org_id required",
        )
    return MemoRepository(session, uuid.UUID(str(org_id_str)))


@router.get("", response_model=list[MemoListResponse])
async def list_memos(
    project_id: uuid.UUID | None = Query(default=None),
    assigned_to: uuid.UUID | None = Query(default=None),
    status_filter: str | None = Query(default=None, alias="status"),
    q: str | None = Query(default=None),
    repo: MemoRepository = Depends(_get_repo),
) -> list[MemoListResponse]:
    filters: dict = {}
    if project_id:
        filters["project_id"] = project_id
    if assigned_to:
        filters["assigned_to"] = assigned_to
    if status_filter:
        filters["status"] = status_filter
    if q:
        filters["q"] = q
    memos = await repo.list(**filters)
    return [MemoListResponse.model_validate(m) for m in memos]


@router.post("", response_model=MemoListResponse, status_code=201)
async def create_memo(
    body: CreateMemo,
    session: AsyncSession = Depends(get_db),
    _auth: AuthContext = Depends(get_current_user),
) -> MemoListResponse:
    repo = MemoRepository(session, body.org_id)
    memo = await repo.create(
        project_id=body.project_id,
        content=body.content,
        memo_type=body.memo_type,
        title=body.title,
        assigned_to=body.assigned_to,
        created_by=body.created_by,
        supersedes_id=body.supersedes_id,
        memo_metadata=body.memo_metadata,
    )
    return MemoListResponse.model_validate(memo)


@router.get("/{id}", response_model=MemoResponse)
async def get_memo(
    id: uuid.UUID,
    repo: MemoRepository = Depends(_get_repo),
) -> MemoResponse:
    memo = await repo.get(id)
    if memo is None:
        raise HTTPException(status_code=404, detail="Memo not found")
    return MemoResponse.model_validate(memo)


@router.patch("/{id}", response_model=MemoListResponse)
async def update_memo(
    id: uuid.UUID,
    body: UpdateMemo,
    repo: MemoRepository = Depends(_get_repo),
) -> MemoListResponse:
    data = body.model_dump(exclude_unset=True)
    memo = await repo.update(id, **data)
    if memo is None:
        raise HTTPException(status_code=404, detail="Memo not found")
    return MemoListResponse.model_validate(memo)


@router.delete("/{id}", status_code=200)
async def delete_memo(
    id: uuid.UUID,
    repo: MemoRepository = Depends(_get_repo),
) -> dict:
    ok = await repo.soft_delete(id)
    if not ok:
        raise HTTPException(status_code=404, detail="Memo not found")
    return {"ok": True}


@router.post("/{id}/replies", response_model=ReplyResponse, status_code=201)
async def add_reply(
    id: uuid.UUID,
    body: CreateReply,
    db: AsyncSession = Depends(get_db),
    repo: MemoRepository = Depends(_get_repo),
) -> ReplyResponse:
    memo = await repo.get(id)
    if memo is None:
        raise HTTPException(status_code=404, detail="Memo not found")
    reply_repo = MemoReplyRepository(db)
    reply = await reply_repo.create(
        memo_id=id, content=body.content, created_by=body.created_by, review_type=body.review_type
    )
    return ReplyResponse.model_validate(reply)


@router.post("/{id}/resolve", response_model=MemoListResponse)
async def resolve_memo(
    id: uuid.UUID,
    resolved_by: uuid.UUID = Query(...),
    repo: MemoRepository = Depends(_get_repo),
) -> MemoListResponse:
    memo = await repo.resolve(id, resolved_by)
    if memo is None:
        raise HTTPException(status_code=404, detail="Memo not found")
    return MemoListResponse.model_validate(memo)


@router.post("/{id}/archive", response_model=MemoListResponse)
async def archive_memo(
    id: uuid.UUID,
    repo: MemoRepository = Depends(_get_repo),
) -> MemoListResponse:
    memo = await repo.archive(id)
    if memo is None:
        raise HTTPException(status_code=404, detail="Memo not found")
    return MemoListResponse.model_validate(memo)


@router.post("/{id}/read", status_code=200)
async def mark_read(
    id: uuid.UUID,
    team_member_id: uuid.UUID = Query(...),
    repo: MemoRepository = Depends(_get_repo),
) -> dict:
    memo = await repo.get(id)
    if memo is None:
        raise HTTPException(status_code=404, detail="Memo not found")
    await repo.mark_read(id, team_member_id)
    return {"ok": True}


@router.get("/{id}/linked-docs")
async def get_linked_docs(
    id: uuid.UUID,
    repo: MemoRepository = Depends(_get_repo),
) -> list[dict]:
    memo = await repo.get(id)
    if memo is None:
        raise HTTPException(status_code=404, detail="Memo not found")
    links = await repo.get_doc_links(id)
    return [{"id": str(l.id), "memo_id": str(l.memo_id), "doc_id": str(l.doc_id)} for l in links]


@router.post("/convert", status_code=201)
async def convert_to_doc(
    memo_id: uuid.UUID = Query(...),
    repo: MemoRepository = Depends(_get_repo),
) -> dict:
    memo = await repo.get(memo_id)
    if memo is None:
        raise HTTPException(status_code=404, detail="Memo not found")
    # Phase B stub — actual doc creation in Phase D
    return {"ok": True, "memo_id": str(memo_id), "doc_id": None}
