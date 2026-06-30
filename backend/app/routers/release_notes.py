"""릴리즈 노트 **공개 API** — GET(published·전역·authed user)만 노출.

write(생성/수정/삭제)는 3f1f2408 에서 공개 API 에서 **제거**: 릴노트는 sprintable 플랫폼 전역 changelog
(전 고객 공유)인데, write 가 `is_org_owner_or_admin(호출자 자기 org)` 게이트라 **아무 고객 org owner 가
전역 릴노트 편집/삭제 가능 = 멀티테넌시 침해**였다(실행 실증·EXPLOITABLE). 공개 API 에서 write route 자체를
빼서 고객 write 경로를 0 으로 만든다. 릴노트 **관리(write)는 별도 비공개 운영자 어드민 경로**로만 제공(별 설계).
모델/서비스(`release_note.py`)는 GET + 향후 어드민이 재사용하므로 **보존**.

GET response 는 FE `ReleaseNote` shape(`note_key→id`·`display_period→publishedAt`) 그대로 매핑(dialog 무회귀).
"""
from __future__ import annotations

from fastapi import APIRouter, Depends
from pydantic import BaseModel
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.dependencies.auth import get_current_user
from app.dependencies.database import get_db
from app.models.release_note import ReleaseNote

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


def _to_response(row: ReleaseNote) -> ReleaseNoteResponse:
    return ReleaseNoteResponse(
        id=row.note_key,
        version=row.version,
        publishedAt=row.display_period,
        title=row.title,
        summary=row.summary,
        items=[ReleaseNoteItemModel(**i) if isinstance(i, dict) else i for i in (row.items or [])],
    )


@router.get("", response_model=list[ReleaseNoteResponse])
async def list_release_notes(
    session: AsyncSession = Depends(get_db),
    _auth=Depends(get_current_user),
) -> list[ReleaseNoteResponse]:
    """published 릴노트 newest-first(published_at desc). 전역(org 무관)·authed user. write 는 공개 API
    미노출(비공개 운영자 어드민 전용·3f1f2408)."""
    rows = (
        await session.execute(
            select(ReleaseNote)
            .where(ReleaseNote.is_published.is_(True))
            .order_by(ReleaseNote.published_at.desc())
        )
    ).scalars().all()
    return [_to_response(r) for r in rows]
