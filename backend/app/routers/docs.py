import uuid
from datetime import datetime

from fastapi import APIRouter, Body, Depends, Header, HTTPException, Query, status
from pydantic import BaseModel
from sqlalchemy import or_, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.dependencies.auth import AuthContext, get_current_user
from app.dependencies.database import get_db
from app.models.doc import DocComment, DocRevision
from app.models.team import TeamMember
from app.repositories.doc import DocRepository
from app.schemas.doc import DocCreate, DocResponse, DocUpdate

router = APIRouter(prefix="/api/v2/docs", tags=["docs"])


def _get_repo(
    session: AsyncSession = Depends(get_db),
    auth: AuthContext = Depends(get_current_user),
    x_org_id: str | None = Header(default=None, alias="X-Org-Id"),
) -> DocRepository:
    org_id_str = auth.claims.get("app_metadata", {}).get("org_id") or x_org_id
    if not org_id_str:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="org_id required (X-Org-Id header or JWT app_metadata)",
        )
    return DocRepository(session, uuid.UUID(str(org_id_str)))


@router.get("", response_model=list[DocResponse])
async def list_docs(
    project_id: uuid.UUID | None = Query(default=None),
    parent_id: uuid.UUID | None = Query(default=None),
    doc_type: str | None = Query(default=None),
    tags: str | None = Query(default=None, description="comma-separated tags"),
    repo: DocRepository = Depends(_get_repo),
) -> list[DocResponse]:
    if tags and project_id:
        tag_list = [t.strip() for t in tags.split(",") if t.strip()]
        docs = await repo.search_by_tags(project_id, tag_list)
        return [DocResponse.model_validate(d) for d in docs]

    if project_id and parent_id is not None:
        docs = await repo.list_tree(project_id, parent_id)
        return [DocResponse.model_validate(d) for d in docs]

    filters: dict = {}
    if project_id:
        filters["project_id"] = project_id
    if doc_type:
        filters["doc_type"] = doc_type
    docs = await repo.list(**filters)
    return [DocResponse.model_validate(d) for d in docs]


@router.post("", response_model=DocResponse, status_code=201)
async def create_doc(
    body: DocCreate,
    session: AsyncSession = Depends(get_db),
    _auth: AuthContext = Depends(get_current_user),
) -> DocResponse:
    repo = DocRepository(session, body.org_id)
    doc = await repo.create(
        project_id=body.project_id,
        title=body.title,
        slug=body.slug,
        content=body.content,
        parent_id=body.parent_id,
        created_by=body.created_by,
        icon=body.icon,
        sort_order=body.sort_order,
        doc_type=body.doc_type,
        content_format=body.content_format,
        tags=body.tags,
    )
    return DocResponse.model_validate(doc)


# ─── Schemas ──────────────────────────────────────────────────────────────────

class DocCommentResponse(BaseModel):
    id: uuid.UUID
    doc_id: uuid.UUID
    org_id: uuid.UUID
    project_id: uuid.UUID
    content: str
    created_by: uuid.UUID
    created_at: datetime

    model_config = {"from_attributes": True}


class DocRevisionResponse(BaseModel):
    id: uuid.UUID
    doc_id: uuid.UUID
    org_id: uuid.UUID
    project_id: uuid.UUID
    content: str
    created_by: uuid.UUID | None = None
    created_at: datetime

    model_config = {"from_attributes": True}


class DocPreviewResponse(BaseModel):
    id: uuid.UUID
    title: str
    icon: str | None = None
    slug: str
    embed_chain: list[str] = []


# ─── Preview (must be before /{id} to avoid routing conflict) ─────────────────

@router.get("/preview", response_model=DocPreviewResponse)
async def get_doc_preview(
    q: str = Query(..., description="slug or UUID"),
    db: AsyncSession = Depends(get_db),
    repo: DocRepository = Depends(_get_repo),
) -> DocPreviewResponse:
    from app.models.doc import Doc

    try:
        doc_uuid = uuid.UUID(q)
        stmt = select(Doc).where(Doc.id == doc_uuid, Doc.org_id == repo.org_id, Doc.deleted_at.is_(None))
    except ValueError:
        stmt = select(Doc).where(Doc.slug == q, Doc.org_id == repo.org_id, Doc.deleted_at.is_(None))

    result = await db.execute(stmt.limit(1))
    doc = result.scalar_one_or_none()
    if doc is None:
        raise HTTPException(status_code=404, detail="Document not found")

    return DocPreviewResponse(
        id=doc.id,
        title=doc.title,
        icon=doc.icon,
        slug=doc.slug,
        embed_chain=[],
    )


# ─── CRUD ─────────────────────────────────────────────────────────────────────

@router.get("/{id}", response_model=DocResponse)
async def get_doc(
    id: uuid.UUID,
    repo: DocRepository = Depends(_get_repo),
) -> DocResponse:
    doc = await repo.get(id)
    if doc is None:
        raise HTTPException(status_code=404, detail="Doc not found")
    return DocResponse.model_validate(doc)


@router.patch("/{id}", response_model=DocResponse)
async def update_doc(
    id: uuid.UUID,
    body: DocUpdate,
    repo: DocRepository = Depends(_get_repo),
) -> DocResponse:
    data = body.model_dump(exclude_unset=True)
    doc = await repo.update(id, **data)
    if doc is None:
        raise HTTPException(status_code=404, detail="Doc not found")
    return DocResponse.model_validate(doc)


@router.delete("/{id}", status_code=200)
async def delete_doc(
    id: uuid.UUID,
    repo: DocRepository = Depends(_get_repo),
) -> dict:
    ok = await repo.delete(id)
    if not ok:
        raise HTTPException(status_code=404, detail="Doc not found")
    return {"ok": True}


# ─── Helpers ──────────────────────────────────────────────────────────────────

async def _resolve_doc_member_id(auth: AuthContext, org_id: uuid.UUID, db: AsyncSession) -> uuid.UUID:
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
    if not member:
        raise HTTPException(status_code=403, detail="Team member not found for current user")
    return member.id


# ─── Comments ─────────────────────────────────────────────────────────────────

@router.get("/{id}/comments", response_model=list[DocCommentResponse])
async def list_doc_comments(
    id: uuid.UUID,
    limit: int = Query(default=20, le=100),
    db: AsyncSession = Depends(get_db),
    _repo: DocRepository = Depends(_get_repo),
) -> list[DocCommentResponse]:
    q = select(DocComment).where(
        DocComment.doc_id == id,
    ).order_by(DocComment.created_at.asc()).limit(limit)
    result = await db.execute(q)
    return [DocCommentResponse.model_validate(r) for r in result.scalars()]


@router.post("/{id}/comments", response_model=DocCommentResponse, status_code=201)
async def add_doc_comment(
    id: uuid.UUID,
    content: str = Body(..., embed=True),
    db: AsyncSession = Depends(get_db),
    repo: DocRepository = Depends(_get_repo),
    auth: AuthContext = Depends(get_current_user),
) -> DocCommentResponse:
    from app.models.doc import Doc
    doc_result = await db.execute(select(Doc).where(Doc.id == id, Doc.org_id == repo.org_id))
    doc = doc_result.scalar_one_or_none()
    if not doc:
        raise HTTPException(status_code=404, detail="Doc not found")
    created_by = await _resolve_doc_member_id(auth, repo.org_id, db)
    comment = DocComment(
        doc_id=id,
        org_id=repo.org_id,
        project_id=doc.project_id,
        content=content,
        created_by=created_by,
    )
    db.add(comment)
    await db.commit()
    await db.refresh(comment)
    return DocCommentResponse.model_validate(comment)


# ─── Revisions ────────────────────────────────────────────────────────────────

@router.get("/{id}/revisions", response_model=list[DocRevisionResponse])
async def list_doc_revisions(
    id: uuid.UUID,
    limit: int = Query(default=50, le=100),
    db: AsyncSession = Depends(get_db),
    _repo: DocRepository = Depends(_get_repo),
) -> list[DocRevisionResponse]:
    q = select(DocRevision).where(
        DocRevision.doc_id == id,
    ).order_by(DocRevision.created_at.desc()).limit(limit)
    result = await db.execute(q)
    return [DocRevisionResponse.model_validate(r) for r in result.scalars()]
