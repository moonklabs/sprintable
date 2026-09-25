"""story #4297 — 활동 스트림 최신순(order=desc) + 이전 커서(before_seq).

사람이 보는 활동 로그가 ASC LIMIT를 받아 뒤집어, 창 안 활동이 limit를 넘으면 가장 오래된 limit건만 보였다(최신 활동은 어떤 요청으로도
닿지 않음 · moonklabs 7일 10,111건). 기본(ASC · after_seq)은 에이전트 team-context 읽기 공개 계약이라 그대로 두고 desc를 덧붙인다.
query_activity_stream은 real-DB로, 라우터 wiring/응답 shape · 커서 짝 검증은 mock으로.
"""
from __future__ import annotations

import os
import uuid
from datetime import UTC, datetime, timedelta
from unittest.mock import AsyncMock, MagicMock

import pytest
from httpx import ASGITransport, AsyncClient

T0 = datetime(2026, 9, 1, 0, 0, 0, tzinfo=UTC)

_RAW = os.environ.get("PARITY_TEST_DATABASE_URL") or os.environ.get("ALEMBIC_DATABASE_URL") or ""
_ASYNC_URL = (
    _RAW.replace("postgresql+psycopg2://", "postgresql+asyncpg://").replace("postgresql://", "postgresql+asyncpg://")
    if _RAW
    else ""
)
_db = pytest.mark.skipif(not _ASYNC_URL, reason="real-DB URL 미설정 — skip")


@pytest.fixture
def anyio_backend():
    return "asyncio"


async def _seed(occurred: list[datetime]):
    """새 org 하나에 occurred 순서대로 활동을 넣는다(activity_seq는 넣은 순서 = Identity 단조 증가). 반환: engine, Session, org, 넣은 seq 목록."""
    from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine

    from app.models.activity_event import ActivityEvent

    engine = create_async_engine(_ASYNC_URL)
    Session = async_sessionmaker(engine, expire_on_commit=False)
    org, proj = uuid.uuid4(), uuid.uuid4()
    async with engine.begin() as conn:
        await conn.run_sync(ActivityEvent.__table__.create, checkfirst=True)
    async with Session() as s:
        rows = []
        for i, at in enumerate(occurred):
            row = ActivityEvent(
                org_id=org, project_id=proj, actor_id=None, verb="memo_created",
                object_type="memo", object_id=uuid.uuid4(), occurred_at=at,
                source_event_ids=[uuid.uuid4()], recipient_ids=[], recipient_types=[],
                payload={"i": i}, dedup_key=f"4297-{org.hex[:8]}-{i}",
            )
            s.add(row)
            await s.flush()  # 한 건씩 flush — 넣은 순서대로 seq가 붙는다
            rows.append(row)
        await s.commit()
        seqs = [r.activity_seq for r in rows]
    return engine, Session, org, seqs


@_db
@pytest.mark.anyio
async def test_desc_first_page_is_newest_and_cursor_walks_to_the_end_without_gaps():
    """AC1 · AC2 — 205건(경계에 같은 시각 둘 포함): 첫 쪽 = 최신 200(내림차순) · before_seq로 나머지 5 · 중복 · 누락 0."""
    from app.services.activity_stream import query_activity_stream

    occurred = [T0 + timedelta(minutes=i) for i in range(205)]
    occurred[5] = occurred[4]  # 둘째 쪽 경계 근처에 같은 시각 두 건(seq로만 갈린다)
    occurred[6] = occurred[4]
    engine, Session, org, seqs = await _seed(occurred)
    try:
        async with Session() as s:
            page1, cur1 = await query_activity_stream(s, org, order="desc", limit=200)
            assert [r.activity_seq for r in page1] == sorted(seqs, reverse=True)[:200]
            assert cur1 == page1[-1].activity_seq
            page2, cur2 = await query_activity_stream(s, org, order="desc", before_seq=cur1, limit=200)
            assert [r.activity_seq for r in page2] == sorted(seqs, reverse=True)[200:]
            assert cur2 is None  # 다 왔다
            walked = [r.activity_seq for r in page1 + page2]
            assert len(walked) == len(set(walked)) == len(seqs)  # 중복 · 누락 0
    finally:
        await engine.dispose()


@_db
@pytest.mark.anyio
async def test_desc_cursor_crosses_empty_weeks():
    """AC2 — 빈 주가 끼어 있어도 커서가 이전 활동까지 잇는다(예전 «더 보기»는 7일 창 단위라 빈 창에서 «더 없음»으로 끝났다)."""
    from app.services.activity_stream import query_activity_stream

    old = [T0 + timedelta(minutes=i) for i in range(3)]
    recent = [T0 + timedelta(days=30, minutes=i) for i in range(3)]  # 사이에 네 주가 빈다
    engine, Session, org, _ = await _seed(old + recent)
    try:
        async with Session() as s:
            page1, cur1 = await query_activity_stream(s, org, order="desc", limit=3)
            assert [r.occurred_at for r in page1] == sorted(recent, reverse=True)
            page2, cur2 = await query_activity_stream(s, org, order="desc", before_seq=cur1, limit=3)
            assert [r.occurred_at for r in page2] == sorted(old, reverse=True)
            page3, cur3 = await query_activity_stream(s, org, order="desc", before_seq=cur2, limit=3)
            assert page3 == [] and cur3 is None
    finally:
        await engine.dispose()


@_db
@pytest.mark.anyio
async def test_desc_respects_since_until_bounds():
    """기간은 경계로만 — 경계 밖은 안 오고, 경계 안에서 최신부터."""
    from app.services.activity_stream import query_activity_stream

    occurred = [T0 + timedelta(days=d) for d in range(10)]
    engine, Session, org, _ = await _seed(occurred)
    try:
        async with Session() as s:
            rows, cur = await query_activity_stream(
                s, org, order="desc", since=T0 + timedelta(days=2), until=T0 + timedelta(days=5), limit=50,
            )
            assert [r.occurred_at for r in rows] == [T0 + timedelta(days=d) for d in (5, 4, 3, 2)]
            assert cur is None
    finally:
        await engine.dispose()


@_db
@pytest.mark.anyio
async def test_asc_default_is_unchanged_public_contract():
    """AC3 — 기본(order 생략)은 예전 그대로 오래된 것부터 · after_seq로 다음 페이지(에이전트 team-context 읽기 계약)."""
    from app.services.activity_stream import query_activity_stream

    occurred = [T0 + timedelta(minutes=i) for i in range(7)]
    engine, Session, org, seqs = await _seed(occurred)
    try:
        async with Session() as s:
            page1, cur1 = await query_activity_stream(s, org, limit=5)
            assert [r.activity_seq for r in page1] == sorted(seqs)[:5]
            assert cur1 == page1[-1].activity_seq
            page2, cur2 = await query_activity_stream(s, org, after_seq=cur1, limit=5)
            assert [r.activity_seq for r in page2] == sorted(seqs)[5:]
            assert cur2 is None
    finally:
        await engine.dispose()


# ── 라우터 wiring · 응답 shape · 커서 짝 — mock ───────────────────────────────────────

async def _client(activity_rows):
    from app.dependencies.auth import get_current_user, get_verified_org_id
    from app.main import app
    from tests.conftest import override_db_and_read

    mock_session = AsyncMock()
    result = MagicMock()
    result.scalars.return_value.all.return_value = activity_rows
    mock_session.execute = AsyncMock(return_value=result)

    async def override_db():
        yield mock_session

    async def override_auth():
        return MagicMock(user_id=str(uuid.uuid4()))

    override_db_and_read(app, override_db)
    app.dependency_overrides[get_verified_org_id] = lambda: uuid.uuid4()
    app.dependency_overrides[get_current_user] = override_auth
    return AsyncClient(transport=ASGITransport(app=app), base_url="http://test"), app, mock_session


def _row(seq: int):
    r = MagicMock()
    r.activity_id = uuid.uuid4(); r.project_id = uuid.uuid4(); r.actor_id = None
    r.verb = "memo_created"; r.object_type = "memo"; r.object_id = uuid.uuid4()
    r.occurred_at = T0; r.source_event_ids = []; r.recipient_ids = []
    r.recipient_types = []; r.payload = {}; r.activity_seq = seq
    return r


@pytest.mark.anyio
async def test_endpoint_desc_returns_next_before_seq_only():
    client, app, session = await _client([_row(9)])
    try:
        async with client as c:
            resp = await c.get("/api/v2/activity-stream?order=desc&before_seq=10&limit=1")
        assert resp.status_code == 200
        body = resp.json()
        assert body["next_before_seq"] == 9 and body["next_after_seq"] is None
        sql = str(session.execute.await_args.args[0].compile(compile_kwargs={"literal_binds": True}))
        assert "activity_seq < 10" in sql and "ORDER BY activity_events.activity_seq DESC" in sql
    finally:
        app.dependency_overrides.clear()


@pytest.mark.anyio
async def test_endpoint_default_stays_asc_with_after_cursor_only():
    client, app, session = await _client([_row(7)])
    try:
        async with client as c:
            resp = await c.get("/api/v2/activity-stream?limit=1")
        assert resp.status_code == 200
        body = resp.json()
        assert body["next_after_seq"] == 7 and body["next_before_seq"] is None
        sql = str(session.execute.await_args.args[0].compile(compile_kwargs={"literal_binds": True}))
        assert "ORDER BY activity_events.activity_seq ASC" in sql
    finally:
        app.dependency_overrides.clear()


@pytest.mark.anyio
@pytest.mark.parametrize("query", ["before_seq=5", "order=asc&before_seq=5", "order=desc&after_seq=5", "order=sideways"])
async def test_endpoint_rejects_mismatched_cursor_or_unknown_order(query):
    """커서는 방향마다 하나 — 거꾸로 된 짝을 조용히 무시하면 호출자가 페이지를 건너뛴 줄 모른다."""
    client, app, _ = await _client([])
    try:
        async with client as c:
            resp = await c.get(f"/api/v2/activity-stream?{query}")
        assert resp.status_code == 422
    finally:
        app.dependency_overrides.clear()


@_db
@pytest.mark.anyio
async def test_desc_cursor_query_is_served_by_seq_index_without_sort():
    """까디르 판정(0409) — 최신순 커서 질의가 정렬 없이 activity_seq 인덱스 역순 훑기로 풀린다. 통계에 따라 작은 표는 seq scan을 고를 수
    있어 이 트랜잭션에서만 seq scan · bitmap · sort를 끄고 «쓸 수 있는 인덱스가 있는가 · 정렬 단계가 없는가»를 잰다(인덱스가 없으면 Sort가 나온다)."""
    from sqlalchemy import text
    from sqlalchemy.ext.asyncio import create_async_engine

    engine = create_async_engine(_ASYNC_URL)
    org, proj = uuid.uuid4(), uuid.uuid4()
    try:
        async with engine.begin() as conn:
            # 작은 표에선 다른 인덱스 bitmap + 싼 Sort가 이긴다 — 셋 다 꺼 «이 순서를 주는 인덱스가 있는가»만 남긴다(없으면 Sort를 피할 길이 없다).
            for setting in ("enable_seqscan", "enable_bitmapscan", "enable_sort"):
                await conn.execute(text(f"SET LOCAL {setting} = off"))
            plan_project = "\n".join(r[0] for r in (await conn.execute(text(
                "EXPLAIN SELECT * FROM activity_events WHERE org_id = :o AND project_id = :p AND activity_seq < 1000000 "
                "ORDER BY activity_seq DESC LIMIT 200"
            ), {"o": org, "p": proj})).all())
            plan_org = "\n".join(r[0] for r in (await conn.execute(text(
                "EXPLAIN SELECT * FROM activity_events WHERE org_id = :o ORDER BY activity_seq DESC LIMIT 200"
            ), {"o": org})).all())
        assert "ix_activity_events_project_seq" in plan_project and "Sort" not in plan_project, plan_project
        assert "ix_activity_events_org_seq" in plan_org and "Sort" not in plan_org, plan_org
    finally:
        await engine.dispose()
