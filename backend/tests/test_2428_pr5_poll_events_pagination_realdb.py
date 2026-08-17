"""story #2428 PR⑤(마지막 ⓐ) — `poll_events`(`GET /api/v2/events/pending`) 페이지네이션 실
Postgres 검증.

그라운딩(디디·페드루, 2026-08-17): `.limit()` 자체가 없어 pending이 무한 누적 가능(만료/
reaper는 status=delivered에만 있음). goals.py/tasks.py와 동일 규약(필터 適用 後·limit
適用 前 COUNT에 cursor 포함) — 단 정렬이 오래된순(asc, get_pending_events 기존 결정 무변경)
이라 cursor는 forward(`created_at > cursor`, artifact_comments와 동형).
"""
from __future__ import annotations

import os
import uuid
from datetime import datetime, timedelta, timezone

import pytest

from tests.test_1994_backlink_api_realdb import (
    _client_for,
    _make_human_member,
    _make_org,
    _make_project,
    _session_factory,
    _setup_app_human,
)

_REAL_DB_URL = os.getenv("PARITY_TEST_DATABASE_URL") or os.getenv("ALEMBIC_DATABASE_URL")

pytestmark = [
    pytest.mark.skipif(not _REAL_DB_URL, reason="통합 테스트는 실 PG(PARITY/ALEMBIC_DATABASE_URL) 필요"),
    pytest.mark.anyio,
]


@pytest.fixture
def anyio_backend():
    return "asyncio"


@pytest.fixture(autouse=True)
async def _dispose_global_engine_after_test():
    yield
    from app.core.database import engine as _global_engine
    await _global_engine.dispose()


async def _make_pending_event(session, org_id, project_id, recipient_id, created_at, event_type="test.event"):
    from app.models.event import Event
    e = Event(
        id=uuid.uuid4(), org_id=org_id, project_id=project_id, event_type=event_type,
        recipient_id=recipient_id, recipient_type="human", payload={}, status="pending",
        created_at=created_at,
    )
    session.add(e)
    await session.commit()
    return e


def _stagger(base: datetime, total: int, seq: int) -> datetime:
    return base - timedelta(seconds=total - seq)


@pytest.mark.anyio
async def test_get_pending_events_last_page_x_total_count_matches_remaining():
    """5건을 limit=2로 3페이지 끝까지 실제로 걸어(오래된순 forward-cursor), 마지막 페이지에서
    X-Total-Count == 그 페이지 건수(has_more=False로 정확히 떨어짐)까지 확認."""
    from app.main import app

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org = await _make_org(s)
            project = await _make_project(s, org.id)
            recipient_id, user_id = await _make_human_member(s, org.id, project.id)
            base = datetime.now(timezone.utc)
            for i in range(5):
                await _make_pending_event(s, org.id, project.id, recipient_id, _stagger(base, 5, i))
        await _setup_app_human(app, Session, user_id, org.id)
        client = _client_for(app)
        try:
            seen_ids: set[str] = set()
            cursor = None
            pages = 0
            last_total = last_len = None
            while True:
                params = {"recipient_id": str(recipient_id), "limit": 2}
                if cursor:
                    params["cursor"] = cursor
                resp = await client.get("/api/v2/events/pending", params=params)
                assert resp.status_code == 200, resp.text
                body = resp.json()
                pages += 1
                seen_ids.update(x["id"] for x in body)
                last_total = int(resp.headers["x-total-count"])
                last_len = len(body)
                has_more = last_total > last_len
                cursor = resp.headers.get("x-next-cursor")
                if not has_more or not body:
                    break
                assert pages < 10
            assert len(seen_ids) == 5
            assert pages == 3
            assert last_total == last_len
        finally:
            await client.aclose()
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()


@pytest.mark.anyio
async def test_get_pending_events_no_limit_returns_all_and_total_matches():
    """limit 미지정(기존 동작 무회귀) — 다 오고 X-Total-Count도 같은 값."""
    from app.main import app

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org = await _make_org(s)
            project = await _make_project(s, org.id)
            recipient_id, user_id = await _make_human_member(s, org.id, project.id)
            base = datetime.now(timezone.utc)
            for i in range(3):
                await _make_pending_event(s, org.id, project.id, recipient_id, _stagger(base, 3, i))
        await _setup_app_human(app, Session, user_id, org.id)
        client = _client_for(app)
        try:
            resp = await client.get("/api/v2/events/pending", params={"recipient_id": str(recipient_id)})
            assert resp.status_code == 200, resp.text
            assert len(resp.json()) == 3
            assert resp.headers["x-total-count"] == "3"
        finally:
            await client.aclose()
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()


@pytest.mark.anyio
async def test_get_pending_events_invalid_cursor_400():
    from app.main import app

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org = await _make_org(s)
            project = await _make_project(s, org.id)
            recipient_id, user_id = await _make_human_member(s, org.id, project.id)
        await _setup_app_human(app, Session, user_id, org.id)
        client = _client_for(app)
        try:
            resp = await client.get(
                "/api/v2/events/pending", params={"recipient_id": str(recipient_id), "cursor": "not-a-datetime"}
            )
            assert resp.status_code == 400
        finally:
            await client.aclose()
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()
