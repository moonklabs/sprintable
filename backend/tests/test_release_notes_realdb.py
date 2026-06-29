"""E-POLISH 53bc0945: release_notes API + 시드 realdb. DB env 없으면 skip(CI alembic-fresh).

마이그 0142 가 테이블+시드(v1.2~v1.5) 생성 → list 가 4개 published newest-first·shape(id=note_key·
publishedAt=display_period) 반환. CRUD 는 owner/admin(is_org_owner_or_admin) 게이트.
"""
from __future__ import annotations

import os
import uuid
from unittest.mock import AsyncMock, MagicMock, patch

import pytest
from fastapi import HTTPException
from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine

_RAW = os.environ.get("ALEMBIC_DATABASE_URL") or os.environ.get("PARITY_TEST_DATABASE_URL") or ""
_ASYNC = _RAW.replace("postgresql+psycopg2://", "postgresql+asyncpg://").replace(
    "postgresql://", "postgresql+asyncpg://"
)
pytestmark = pytest.mark.skipif(not _RAW, reason="real-DB URL 미설정 — skip")

ORG = uuid.uuid4()


@pytest.fixture
def anyio_backend():
    return "asyncio"


def _auth():
    a = MagicMock()
    a.user_id = str(uuid.uuid4())
    return a


@pytest.mark.anyio
async def test_list_returns_seeded_newest_first():
    from app.routers.release_notes import list_release_notes
    engine = create_async_engine(_ASYNC)
    Session = async_sessionmaker(engine, expire_on_commit=False)
    try:
        async with Session() as s:
            out = await list_release_notes(session=s, _auth=_auth())
            keys = [r.id for r in out]
            # 시드 4개가 newest-first(v1.5→v1.2)로 선두에(다른 테스트가 추가했을 수 있어 포함 검사).
            assert "2026-06-v1-5" in keys and "2026-05-v1-2" in keys
            idx = {k: i for i, k in enumerate(keys)}
            assert idx["2026-06-v1-5"] < idx["2026-06-v1-4"] < idx["2026-06-v1-3"] < idx["2026-05-v1-2"]
            v15 = next(r for r in out if r.id == "2026-06-v1-5")
            assert v15.version == "v1.5" and v15.publishedAt == "2026년 6월"  # display_period→publishedAt
            assert v15.items and v15.items[0].text  # JSONB items 매핑
    finally:
        await engine.dispose()


@pytest.mark.anyio
async def test_create_requires_owner_admin():
    from app.routers.release_notes import ReleaseNoteCreate, create_release_note
    engine = create_async_engine(_ASYNC)
    Session = async_sessionmaker(engine, expire_on_commit=False)
    key = f"test-{uuid.uuid4()}"
    body = ReleaseNoteCreate(
        note_key=key, version="vT", published_at="2026-07-01T00:00:00+00:00",
        display_period="2026년 7월", title="T", summary="s", items=[{"text": "x"}],
    )
    try:
        async with Session() as s:
            # 비-admin → 403
            with patch("app.routers.release_notes.is_org_owner_or_admin",
                       new_callable=AsyncMock, return_value=False):
                with pytest.raises(HTTPException) as e:
                    await create_release_note(body=body, session=s, org_id=ORG, auth=_auth())
                assert e.value.status_code == 403
            # admin → 201 생성
            with patch("app.routers.release_notes.is_org_owner_or_admin",
                       new_callable=AsyncMock, return_value=True):
                created = await create_release_note(body=body, session=s, org_id=ORG, auth=_auth())
                assert created.id == key and created.version == "vT"
    finally:
        await engine.dispose()


@pytest.mark.anyio
async def test_unpublished_excluded_and_patch_delete():
    from app.routers.release_notes import (
        ReleaseNoteCreate,
        ReleaseNoteUpdate,
        create_release_note,
        delete_release_note,
        list_release_notes,
        update_release_note,
    )
    engine = create_async_engine(_ASYNC)
    Session = async_sessionmaker(engine, expire_on_commit=False)
    key = f"unpub-{uuid.uuid4()}"
    try:
        with patch("app.routers.release_notes.is_org_owner_or_admin",
                   new_callable=AsyncMock, return_value=True):
            async with Session() as s:
                # 미발행 생성 → list 제외.
                await create_release_note(
                    body=ReleaseNoteCreate(
                        note_key=key, version="vU", published_at="2026-08-01T00:00:00+00:00",
                        display_period="2026년 8월", title="U", summary="", items=[], is_published=False),
                    session=s, org_id=ORG, auth=_auth())
                assert key not in [r.id for r in await list_release_notes(session=s, _auth=_auth())]
                # patch 발행 → list 포함.
                await update_release_note(note_key=key, body=ReleaseNoteUpdate(is_published=True),
                                          session=s, org_id=ORG, auth=_auth())
                assert key in [r.id for r in await list_release_notes(session=s, _auth=_auth())]
                # delete.
                await delete_release_note(note_key=key, session=s, org_id=ORG, auth=_auth())
                assert key not in [r.id for r in await list_release_notes(session=s, _auth=_auth())]
    finally:
        await engine.dispose()
