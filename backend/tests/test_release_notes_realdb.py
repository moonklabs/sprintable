"""E-POLISH 53bc0945 + 3f1f2408: release_notes **GET** API realdb. DB env 없으면 skip(CI alembic-fresh).

마이그 0142 가 테이블+시드(v1.2~v1.5) → list 가 published newest-first·shape(id=note_key·
publishedAt=display_period) 반환. write route 는 3f1f2408 에서 공개 API 제거(멀티테넌시 침해 봉인) — write
테스트는 부재 가드(test_release_notes_no_write_routes.py·no-DB)로 이전. 여기선 GET 거동만.
"""
from __future__ import annotations

import os
import uuid
from datetime import datetime, timezone
from unittest.mock import MagicMock

import pytest
from sqlalchemy import select
from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine

_RAW = os.environ.get("ALEMBIC_DATABASE_URL") or os.environ.get("PARITY_TEST_DATABASE_URL") or ""
_ASYNC = _RAW.replace("postgresql+psycopg2://", "postgresql+asyncpg://").replace(
    "postgresql://", "postgresql+asyncpg://"
)
pytestmark = pytest.mark.skipif(not _RAW, reason="real-DB URL 미설정 — skip")


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
            # 0143(v1.5 += 용량경고·de-hardcode 데이터): 스토리지 용량경고 항목 append(idempotent).
            assert any("저장공간" in i.text for i in v15.items), "v1.5 용량경고 항목 누락(0143)"
    finally:
        await engine.dispose()


@pytest.mark.anyio
async def test_unpublished_excluded_from_list():
    """is_published=False 노트는 GET 제외·True 면 포함(published 필터 검증). write 엔드포인트 없이 ORM 직시드."""
    from app.models.release_note import ReleaseNote
    from app.routers.release_notes import list_release_notes
    engine = create_async_engine(_ASYNC)
    Session = async_sessionmaker(engine, expire_on_commit=False)
    key = f"unpub-{uuid.uuid4()}"
    try:
        async with Session() as s:
            s.add(ReleaseNote(
                note_key=key, version="vU",
                published_at=datetime(2026, 8, 1, tzinfo=timezone.utc),
                display_period="2026년 8월", title="U", summary="", items=[], is_published=False,
            ))
            await s.commit()
            assert key not in [r.id for r in await list_release_notes(session=s, _auth=_auth())]
            row = (await s.execute(
                select(ReleaseNote).where(ReleaseNote.note_key == key)
            )).scalar_one()
            row.is_published = True
            await s.commit()
            assert key in [r.id for r in await list_release_notes(session=s, _auth=_auth())]
            await s.delete(row)
            await s.commit()
    finally:
        await engine.dispose()
