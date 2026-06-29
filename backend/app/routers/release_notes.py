"""릴리즈 노트 API(E-POLISH 53bc0945) — 하드코딩 RELEASE_NOTES de-hardcode.

GET = published 노트(newest-first·전 org 공통·authed user). CRUD = org owner/admin(platform-admin 롤
부재·v1). response 는 FE `ReleaseNote` shape 그대로(`note_key→id`·`display_period→publishedAt`) 매핑해
dialog 무회귀. id(=note_key)는 FE localStorage seen-key 와 동일.
"""
from __future__ import annotations

import uuid
from datetime import datetime

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.dependencies.auth import get_current_user, get_verified_org_id
from app.dependencies.database import get_db
from app.models.release_note import ReleaseNote
from app.services.project_auth import is_org_owner_or_admin

router = APIRouter(prefix="/api/v2/release-notes", tags=["release-notes"])


class ReleaseNoteItemModel(BaseModel):
    text: str
    href: str | None = None


class ReleaseNoteResponse(BaseModel):
    id: str  # = note_key (FE seen-key·가시성 비교)
    version: str
    publishedAt: str  # = display_period(표시 문자열)
    title: str
    summary: str
    items: list[ReleaseNoteItemModel]


class ReleaseNoteCreate(BaseModel):
    note_key: str = Field(min_length=1)
    version: str = Field(min_length=1)
    published_at: datetime
    display_period: str = Field(min_length=1)
    title: str = Field(min_length=1)
    summary: str = ""
    items: list[ReleaseNoteItemModel] = Field(default_factory=list)
    is_published: bool = True


class ReleaseNoteUpdate(BaseModel):
    version: str | None = None
    published_at: datetime | None = None
    display_period: str | None = None
    title: str | None = None
    summary: str | None = None
    items: list[ReleaseNoteItemModel] | None = None
    is_published: bool | None = None


def _to_response(row: ReleaseNote) -> ReleaseNoteResponse:
    return ReleaseNoteResponse(
        id=row.note_key,
        version=row.version,
        publishedAt=row.display_period,
        title=row.title,
        summary=row.summary,
        items=[ReleaseNoteItemModel(**i) if isinstance(i, dict) else i for i in (row.items or [])],
    )


async def _require_admin(session: AsyncSession, auth, org_id: uuid.UUID) -> None:
    """CRUD = org owner/admin(canonical project_auth·ad-hoc role 금지). platform-admin 롤 부재로 유일 옵션."""
    if not await is_org_owner_or_admin(session, uuid.UUID(auth.user_id), org_id):
        raise HTTPException(status_code=403, detail="릴리즈 노트 관리는 org owner/admin 만 가능합니다.")


@router.get("", response_model=list[ReleaseNoteResponse])
async def list_release_notes(
    session: AsyncSession = Depends(get_db),
    _auth=Depends(get_current_user),
) -> list[ReleaseNoteResponse]:
    """published 릴노트 newest-first(published_at desc). 전역(org 무관)·authed user."""
    rows = (
        await session.execute(
            select(ReleaseNote)
            .where(ReleaseNote.is_published.is_(True))
            .order_by(ReleaseNote.published_at.desc())
        )
    ).scalars().all()
    return [_to_response(r) for r in rows]


@router.post("", response_model=ReleaseNoteResponse, status_code=201)
async def create_release_note(
    body: ReleaseNoteCreate,
    session: AsyncSession = Depends(get_db),
    org_id: uuid.UUID = Depends(get_verified_org_id),
    auth=Depends(get_current_user),
) -> ReleaseNoteResponse:
    await _require_admin(session, auth, org_id)
    dup = (await session.execute(
        select(ReleaseNote.id).where(ReleaseNote.note_key == body.note_key)
    )).scalar_one_or_none()
    if dup is not None:
        raise HTTPException(status_code=409, detail="같은 note_key 의 릴노트가 이미 있습니다.")
    row = ReleaseNote(
        note_key=body.note_key,
        version=body.version,
        published_at=body.published_at,
        display_period=body.display_period,
        title=body.title,
        summary=body.summary,
        items=[i.model_dump(exclude_none=True) for i in body.items],
        is_published=body.is_published,
    )
    session.add(row)
    await session.commit()
    await session.refresh(row)
    return _to_response(row)


@router.patch("/{note_key}", response_model=ReleaseNoteResponse)
async def update_release_note(
    note_key: str,
    body: ReleaseNoteUpdate,
    session: AsyncSession = Depends(get_db),
    org_id: uuid.UUID = Depends(get_verified_org_id),
    auth=Depends(get_current_user),
) -> ReleaseNoteResponse:
    await _require_admin(session, auth, org_id)
    row = (await session.execute(
        select(ReleaseNote).where(ReleaseNote.note_key == note_key)
    )).scalar_one_or_none()
    if row is None:
        raise HTTPException(status_code=404, detail="릴노트를 찾을 수 없습니다.")
    data = body.model_dump(exclude_unset=True)
    if "items" in data and data["items"] is not None:
        data["items"] = [i.model_dump(exclude_none=True) if hasattr(i, "model_dump")
                         else i for i in body.items]
    for k, v in data.items():
        setattr(row, k, v)
    await session.commit()
    await session.refresh(row)
    return _to_response(row)


@router.delete("/{note_key}", status_code=204)
async def delete_release_note(
    note_key: str,
    session: AsyncSession = Depends(get_db),
    org_id: uuid.UUID = Depends(get_verified_org_id),
    auth=Depends(get_current_user),
) -> None:
    await _require_admin(session, auth, org_id)
    row = (await session.execute(
        select(ReleaseNote).where(ReleaseNote.note_key == note_key)
    )).scalar_one_or_none()
    if row is None:
        raise HTTPException(status_code=404, detail="릴노트를 찾을 수 없습니다.")
    await session.delete(row)
    await session.commit()
