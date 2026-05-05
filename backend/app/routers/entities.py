import uuid
from typing import Literal

from fastapi import APIRouter, Depends, Header, HTTPException, Query, status
from pydantic import BaseModel
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.dependencies.auth import AuthContext, get_current_user
from app.dependencies.database import get_db
from app.models.doc import Doc
from app.models.pm import Epic, Story, Task

router = APIRouter(prefix="/api/v2/entities", tags=["entities"])

VALID_TYPES = {"story", "doc", "epic", "task"}
DEFAULT_LIMIT = 10


class EntitySearchResult(BaseModel):
    entity_type: str
    entity_id: uuid.UUID
    title: str
    status: str | None = None


def _get_org_id(
    auth: AuthContext,
    x_org_id: str | None,
) -> uuid.UUID:
    org_id_str = auth.claims.get("app_metadata", {}).get("org_id") or x_org_id
    if not org_id_str:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="org_id required",
        )
    return uuid.UUID(str(org_id_str))


@router.get("/search", response_model=list[EntitySearchResult])
async def search_entities(
    project_id: uuid.UUID = Query(...),
    q: str | None = Query(default=None),
    types: str | None = Query(default=None, description="Comma-separated: story,doc,epic,task"),
    db: AsyncSession = Depends(get_db),
    auth: AuthContext = Depends(get_current_user),
    x_org_id: str | None = Header(default=None, alias="X-Org-Id"),
) -> list[EntitySearchResult]:
    org_id = _get_org_id(auth, x_org_id)

    requested = set(types.split(",")) if types else VALID_TYPES
    requested = requested & VALID_TYPES

    search = f"%{q}%" if q else None
    results: list[EntitySearchResult] = []

    if "story" in requested:
        stmt = (
            select(Story.id, Story.title, Story.status)
            .where(
                Story.org_id == org_id,
                Story.project_id == project_id,
                Story.deleted_at.is_(None),
            )
        )
        if search:
            stmt = stmt.where(Story.title.ilike(search))
        stmt = stmt.order_by(Story.created_at.desc()).limit(DEFAULT_LIMIT)
        rows = await db.execute(stmt)
        for rid, title, st in rows:
            results.append(EntitySearchResult(entity_type="story", entity_id=rid, title=title, status=st))

    if "doc" in requested:
        stmt = (
            select(Doc.id, Doc.title)
            .where(
                Doc.org_id == org_id,
                Doc.project_id == project_id,
                Doc.deleted_at.is_(None),
            )
        )
        if search:
            stmt = stmt.where(Doc.title.ilike(search))
        stmt = stmt.order_by(Doc.created_at.desc()).limit(DEFAULT_LIMIT)
        rows = await db.execute(stmt)
        for rid, title in rows:
            results.append(EntitySearchResult(entity_type="doc", entity_id=rid, title=title))

    if "epic" in requested:
        stmt = (
            select(Epic.id, Epic.title, Epic.status)
            .where(
                Epic.org_id == org_id,
                Epic.project_id == project_id,
            )
        )
        if search:
            stmt = stmt.where(Epic.title.ilike(search))
        stmt = stmt.order_by(Epic.created_at.desc()).limit(DEFAULT_LIMIT)
        rows = await db.execute(stmt)
        for rid, title, st in rows:
            results.append(EntitySearchResult(entity_type="epic", entity_id=rid, title=title, status=st))

    if "task" in requested:
        stmt = (
            select(Task.id, Task.title, Task.status)
            .join(Story, Task.story_id == Story.id)
            .where(
                Task.org_id == org_id,
                Story.project_id == project_id,
                Task.deleted_at.is_(None),
            )
        )
        if search:
            stmt = stmt.where(Task.title.ilike(search))
        stmt = stmt.order_by(Task.created_at.desc()).limit(DEFAULT_LIMIT)
        rows = await db.execute(stmt)
        for rid, title, st in rows:
            results.append(EntitySearchResult(entity_type="task", entity_id=rid, title=title, status=st))

    # Sort by title when searching, by created_at (already DESC per type) otherwise
    if search:
        results.sort(key=lambda r: r.title.lower())

    return results[:DEFAULT_LIMIT]
