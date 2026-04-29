import uuid

from fastapi import APIRouter, Depends, Header, HTTPException, Query, status
from sqlalchemy.ext.asyncio import AsyncSession

from app.dependencies.auth import AuthContext, get_current_user
from app.dependencies.database import get_db
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
