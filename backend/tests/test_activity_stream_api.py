"""L1 BE-5: Activity Stream API (GET /api/v2/activity-stream) 테스트.

query_activity_stream(org scope·필터·activity_seq cursor)은 real-DB로, 라우터 wiring/응답
shape는 mock으로 검증한다.
"""
from __future__ import annotations

import os
import uuid
from datetime import datetime, timezone
from unittest.mock import AsyncMock, MagicMock

import pytest
from httpx import ASGITransport, AsyncClient

TS = datetime(2026, 6, 11, 12, 0, 0, tzinfo=timezone.utc)


@pytest.fixture
def anyio_backend():
    return "asyncio"


# ── query_activity_stream — real-DB ──────────────────────────────────────────────

_RAW = os.environ.get("PARITY_TEST_DATABASE_URL") or os.environ.get("ALEMBIC_DATABASE_URL") or ""
_ASYNC_URL = (
    _RAW.replace("postgresql+psycopg2://", "postgresql+asyncpg://").replace("postgresql://", "postgresql+asyncpg://")
    if _RAW
    else ""
)
_db = pytest.mark.skipif(not _ASYNC_URL, reason="real-DB URL 미설정 — skip")


@_db
@pytest.mark.anyio
async def test_query_org_scope_filters_and_cursor():
    from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine

    from app.models.activity_event import ActivityEvent
    from app.services.activity_stream import query_activity_stream

    engine = create_async_engine(_ASYNC_URL)
    Session = async_sessionmaker(engine, expire_on_commit=False)
    org_a, org_b, proj = uuid.uuid4(), uuid.uuid4(), uuid.uuid4()
    try:
        async with engine.begin() as conn:
            await conn.run_sync(ActivityEvent.__table__.create, checkfirst=True)
        async with Session() as s:
            def _act(org, verb, dk):
                return ActivityEvent(
                    org_id=org, project_id=proj, actor_id=None, verb=verb,
                    object_type="memo", object_id=uuid.uuid4(), occurred_at=TS,
                    source_event_ids=[uuid.uuid4()], recipient_ids=[uuid.uuid4()],
                    recipient_types=["human"], payload={"title": "t"}, dedup_key=dk,
                )
            s.add_all([
                _act(org_a, "memo_created", "a1"),
                _act(org_a, "memo_replied", "a2"),
                _act(org_a, "memo_created", "a3"),
                _act(org_b, "memo_created", "b1"),  # 다른 org — 노출되면 안 됨
            ])
            await s.commit()

            # AC① org scope: org_a만.
            rows, nxt = await query_activity_stream(s, org_a, limit=50)
            assert len(rows) == 3 and all(r.org_id == org_a for r in rows)
            assert [r.activity_seq for r in rows] == sorted(r.activity_seq for r in rows)  # seq ASC

            # AC② verb 필터.
            rows_v, _ = await query_activity_stream(s, org_a, verb="memo_created", limit=50)
            assert len(rows_v) == 2 and all(r.verb == "memo_created" for r in rows_v)

            # AC③ cursor: limit=2 → next_after_seq, after_seq로 다음 페이지.
            page1, nxt1 = await query_activity_stream(s, org_a, limit=2)
            assert len(page1) == 2 and nxt1 == page1[-1].activity_seq
            page2, nxt2 = await query_activity_stream(s, org_a, after_seq=nxt1, limit=2)
            assert len(page2) == 1 and nxt2 is None  # 더 없음
            assert page2[0].activity_seq > nxt1  # strict cursor — 중복 없음
    finally:
        await engine.dispose()


# ── 라우터 wiring/응답 shape — mock ───────────────────────────────────────────────

async def _client(activity_rows):
    from app.dependencies.auth import get_verified_org_id
    from app.dependencies.database import get_db
    from app.main import app

    mock_session = AsyncMock()
    result = MagicMock()
    result.scalars.return_value.all.return_value = activity_rows
    mock_session.execute = AsyncMock(return_value=result)

    async def override_db():
        yield mock_session

    app.dependency_overrides[get_db] = override_db
    app.dependency_overrides[get_verified_org_id] = lambda: uuid.uuid4()
    return AsyncClient(transport=ASGITransport(app=app), base_url="http://test"), app


def _row():
    r = MagicMock()
    r.activity_id = uuid.uuid4(); r.project_id = uuid.uuid4(); r.actor_id = None
    r.verb = "memo_created"; r.object_type = "memo"; r.object_id = uuid.uuid4()
    r.occurred_at = TS; r.source_event_ids = [uuid.uuid4()]; r.recipient_ids = [uuid.uuid4()]
    r.recipient_types = ["human"]; r.payload = {"title": "t"}; r.activity_seq = 7
    return r


@pytest.mark.anyio
async def test_activity_stream_endpoint_shape_and_cursor():
    client, app = await _client([_row()])
    try:
        async with client as c:
            resp = await c.get("/api/v2/activity-stream?limit=1")
        assert resp.status_code == 200
        body = resp.json()
        assert len(body["items"]) == 1
        item = body["items"][0]
        assert item["verb"] == "memo_created"
        assert "source_event_ids" in item and "recipient_ids" in item and "payload" in item
        assert "status" not in item and "read_at" not in item  # AC⑤ delivery-only 미포함
        assert body["next_after_seq"] == 7  # limit=1·1행 → cursor
    finally:
        app.dependency_overrides.clear()


@pytest.mark.anyio
async def test_activity_stream_empty_no_cursor():
    client, app = await _client([])
    try:
        async with client as c:
            resp = await c.get("/api/v2/activity-stream")
        assert resp.status_code == 200
        body = resp.json()
        assert body["items"] == [] and body["next_after_seq"] is None
    finally:
        app.dependency_overrides.clear()
