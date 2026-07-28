"""story #2201 실PG 통합 테스트 — SSE 백필 강등 신호(event: sync_status).

갭: last_event_id가 무효(만료·GC됨)하거나 300초를 넘겨도 클라이언트에게 "못 따라잡았다"는
신호가 전혀 없었다(events.py 조용한 강등). 처방: heartbeat 다음, backfill 이벤트 스트리밍
시작 前에 전용 이벤트 타입(event: sync_status)으로 이유(reason)를 싣는다.

⛔동작(50/100/5 캡)은 이 스토리에서 안 바꾼다 — _compute_backfill_mode의 유닛 테스트
(test_s6_1_sse_backfill.py)가 그대로 통과하는 것으로 무회귀를 확認한다. 이 파일은 신호
자체(sync_status 프레임 · reason 값 · 로그)만 검증한다.

⛔읽기 방식(HTTP 계층 우회, 2026-07-28 CI red 조사 후 확定): `httpx.AsyncClient(transport=
ASGITransport(...))`(같은 이벤트루프) 로 읽으면 서버는 즉시(<10ms) heartbeat·sync_status를
전부 yield하는데도(계측 실증) 클라이언트가 status조차 못 받고 영구 대기했다 — PR과 무관한
test-harness 비호환(PR 코드를 pass로 치환해도 동일 hang, 원인은 events.py가 아니라 read
방식). 대안으로 시도한 `starlette.testclient.TestClient`(스레드+anyio portal, 이 코드베이스의
기존 검증 패턴 test_s20.py)도 이 파일처럼 **실 asyncpg I/O가 섞인** 스트림에서는
`AttributeError: 'ByteStream' object has no attribute 'write'`(starlette 1.0.0 + httpx
0.28.1 조합 비호환)를 냈다. 최종 처방: ASGI/HTTP 트랜스포트 전부 우회 — 라우터 함수
`agent_event_stream`을 직접 호출해 반환된 StreamingResponse의 `body_iterator`를 테스트
자신의 이벤트루프에서 직접 순회한다. 스레드·소켓·트랜스포트 계층이 없어 이 비호환 클래스를
전부 피하면서 실제 프로덕션과 동일한 제너레이터 로직을 그대로 검증한다.
"""
from __future__ import annotations

import json
import os
import uuid
from datetime import datetime, timedelta, timezone

import pytest

_REAL_DB_URL = os.getenv("PARITY_TEST_DATABASE_URL") or os.getenv("ALEMBIC_DATABASE_URL")

pytestmark = [
    pytest.mark.skipif(not _REAL_DB_URL, reason="통합 테스트는 실 PG(PARITY/ALEMBIC_DATABASE_URL) 필요"),
    pytest.mark.destructive_schema,
]


@pytest.fixture
def anyio_backend():
    return "asyncio"


@pytest.fixture(autouse=True)
async def _dispose_global_engine_after_test():
    """`agent_event_stream`이 이 파일의 `get_db` 오버라이드가 안 닿는 앱 전역
    `async_session_factory`(모듈 싱글턴)를 직접 쓴다. 다음 테스트 파일이 다른 destructive_schema
    스키마로 재사용할 때 이 풀의 커넥션이 이전 스키마를 들고 있지 않도록 매 테스트 뒤에 폐기한다."""
    from app.core.database import engine as _global_engine
    yield
    await _global_engine.dispose()


def _async_url() -> str:
    url = _REAL_DB_URL
    for prefix in ("postgresql+psycopg2://", "postgresql+asyncpg://", "postgresql://"):
        if url.startswith(prefix):
            return "postgresql+asyncpg://" + url[len(prefix):]
    return url


async def _session_factory():
    from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine

    import app.models  # noqa: F401 — 전 모델 메타데이터 로드(⚠️아래 참조 — 이것만으론 부족)
    # ⛔`app.models`(__init__.py)는 `app.models.event`(Event/"events" 테이블)를 안 끌어온다
    # (agent_event_seq·event_outbox·activity_event만 임포트 — grep 확認). 이 프로세스에서
    # `Event`가 아직 어디서도 임포트 안 된 시점에 create_all이 먼저 돌면 "events" 테이블이
    # 통째로 안 만들어진다 — 그 뒤 `agent_event_stream`(app.routers.events, 모듈 레벨에서
    # `from app.models.event import Event`)이 처음 임포트되며 뒤늦게 Base.metadata에 등록
    # 되지만 이미 create_all은 끝난 후라 DB엔 없다(`UndefinedTableError: relation "events"
    # does not exist`, 이 프로세스의 첫 realdb 테스트에서만 재현 — 그 다음 테스트부터는
    # Event가 이미 등록돼 있어 무재현. 실측 2026-07-28). create_all **前** 명시 임포트로 봉인.
    from app.models.event import Event  # noqa: F401
    from app.core.database import Base

    engine = create_async_engine(_async_url())
    async with engine.begin() as conn:
        await conn.run_sync(Base.metadata.create_all)
    return engine, async_sessionmaker(engine, expire_on_commit=False)


async def _seed(Session, *, with_stale_event: bool = False, with_fresh_event: bool = False):
    from app.models.event import Event
    from app.models.project import Project
    from app.models.team import TeamMember

    org_id, project_id, member_id = uuid.uuid4(), uuid.uuid4(), uuid.uuid4()
    async with Session() as s:
        s.add(Project(id=project_id, org_id=org_id, name="test-project"))
        await s.commit()
        s.add(TeamMember(id=member_id, org_id=org_id, project_id=project_id, type="agent", name="test-agent"))
        await s.commit()

        event_id = None
        if with_stale_event or with_fresh_event:
            now = datetime.now(timezone.utc)
            created_at = now - timedelta(seconds=(600 if with_stale_event else 5))
            event_id = uuid.uuid4()
            s.add(Event(
                id=event_id, project_id=project_id, org_id=org_id, event_type="test.event",
                recipient_id=member_id, recipient_type="agent", payload={}, status="pending",
                created_at=created_at,
            ))
            await s.commit()

    return {"org_id": org_id, "project_id": project_id, "member_id": member_id, "event_id": event_id}


async def _read_sync_status_frame(
    *, org_id: uuid.UUID, member_id: uuid.UUID, last_event_id: uuid.UUID | None = None,
) -> dict:
    """`agent_event_stream`을 직접 호출해 heartbeat 다음 sync_status 프레임까지만 읽는다
    (그 뒤는 신규 이벤트 대기 큐라 무한정 블록됨 — 안 읽는다). 모듈 docstring 참조 — HTTP/ASGI
    트랜스포트를 전부 우회하는 이유."""
    from app.dependencies.auth import AuthContext
    from app.routers.events import agent_event_stream
    from starlette.requests import Request

    auth = AuthContext(
        user_id=str(member_id), email="agent@test",
        claims={"app_metadata": {"api_key_id": str(uuid.uuid4()), "org_id": str(org_id)}},
    )
    request = Request(scope={"type": "http", "headers": [], "method": "GET", "path": "/api/v2/events/stream"})

    resp = await agent_event_stream(
        request=request, member_id=None, auth=auth, org_id=org_id,
        since_timestamp=None, last_event_id=last_event_id,
    )
    assert resp.status_code == 200

    lines: list[str] = []
    seen_event_types: list[str] = []
    try:
        async for chunk in resp.body_iterator:
            for line in chunk.splitlines():
                lines.append(line)
                if line.startswith("event: "):
                    seen_event_types.append(line[len("event: "):])
                if line.startswith("data: ") and seen_event_types[-1:] == ["sync_status"]:
                    return json.loads(line[len("data: "):])
    finally:
        await resp.body_iterator.aclose()
    raise AssertionError(f"sync_status frame not found in stream: {lines}")


@pytest.mark.anyio
async def test_initial_connection_no_cursor():
    """진짜 최초접속(커서 자체 없음) → reason=no_cursor, complete=False."""
    engine, Session = await _session_factory()
    try:
        seeded = await _seed(Session)
        frame = await _read_sync_status_frame(org_id=seeded["org_id"], member_id=seeded["member_id"])
        assert frame == {"complete": False, "reason": "no_cursor", "returned": 0}
    finally:
        await engine.dispose()


@pytest.mark.anyio
async def test_cursor_not_found_reconnect():
    """커서는 보냈는데 DB에 없음(만료·GC됨) → reason=cursor_not_found(5건 아니라 50건 캡 경로)."""
    engine, Session = await _session_factory()
    try:
        seeded = await _seed(Session)
        missing_cursor = uuid.uuid4()
        frame = await _read_sync_status_frame(
            org_id=seeded["org_id"], member_id=seeded["member_id"], last_event_id=missing_cursor,
        )
        assert frame["reason"] == "cursor_not_found"
        assert frame["complete"] is False
    finally:
        await engine.dispose()


@pytest.mark.anyio
async def test_cursor_stale_over_threshold():
    """커서는 유효한데 300초 초과 → reason=cursor_stale."""
    engine, Session = await _session_factory()
    try:
        seeded = await _seed(Session, with_stale_event=True)
        frame = await _read_sync_status_frame(
            org_id=seeded["org_id"], member_id=seeded["member_id"], last_event_id=seeded["event_id"],
        )
        assert frame["reason"] == "cursor_stale"
        assert frame["complete"] is False
    finally:
        await engine.dispose()


@pytest.mark.anyio
async def test_cursor_fresh_within_threshold_complete_true():
    """회귀 0: 커서 유효·300초 이내 → complete=True, reason=None(정상 캐치업)."""
    engine, Session = await _session_factory()
    try:
        seeded = await _seed(Session, with_fresh_event=True)
        frame = await _read_sync_status_frame(
            org_id=seeded["org_id"], member_id=seeded["member_id"], last_event_id=seeded["event_id"],
        )
        assert frame == {"complete": True, "reason": None, "returned": 0}
    finally:
        await engine.dispose()


@pytest.mark.anyio
async def test_returned_reflects_actual_count_not_the_cap():
    """PO 리뷰(2026-07-28) — `returned`가 이름 그대로인지 실증한다: 그 모드의 상한(cursor_
    not_found → 50건 캡)이 아니라 **실제 쿼리 결과 건수**여야 한다. 오늘 하루 「이름이 실제와
    다른 것」에 세 번 걸렸다(X-Total-Count=len(items)·next_after_seq가 실은 커서·
    lastTransitionTime이 나이 아님) — 이번엔 실측으로 미리 가른다.

    시나리오: cursor_not_found(50건 캡 경로)인데 실제 pending 이벤트는 **2건뿐**. `returned`가
    50이 아니라 2로 나오면 실제 건수를 담고 있다는 뜻 — 왜냐하면 `sync_status`가 heartbeat
    다음·**개별 백필 이벤트 스트리밍 시작 前**에 나가는 건 맞지만, 그 시점은 이미 DB 쿼리가
    끝나 `pending_events` 리스트가 메모리에 있는 시점이다(라우터 코드: 쿼리 실행 → `sync_status`
    yield → 그 리스트를 배치로 스트리밍하는 순서). "스트리밍 시작 前"이지 "쿼리 前"이 아니다."""
    engine, Session = await _session_factory()
    try:
        seeded = await _seed(Session)
        # cursor_not_found 유도(존재하지 않는 last_event_id) + 실제 pending 이벤트 2건만 시드
        # (50건 캡보다 훨씬 작게 — 캡값이 그대로 찍히면 바로 드러나도록).
        async with Session() as s:
            from app.models.event import Event
            for _ in range(2):
                s.add(Event(
                    id=uuid.uuid4(), project_id=seeded["project_id"], org_id=seeded["org_id"],
                    event_type="test.event", recipient_id=seeded["member_id"],
                    recipient_type="agent", payload={}, status="pending",
                ))
            await s.commit()

        missing_cursor = uuid.uuid4()
        frame = await _read_sync_status_frame(
            org_id=seeded["org_id"], member_id=seeded["member_id"], last_event_id=missing_cursor,
        )
        assert frame["reason"] == "cursor_not_found"
        assert frame["returned"] == 2, (
            f"returned={frame['returned']} — 50(캡)이 찍혔으면 «상한»을 담고 있는 것이라 "
            "이름이 거짓말인 버그. 실제 시드한 2건이 나와야 한다."
        )
    finally:
        await engine.dispose()


@pytest.mark.anyio
async def test_degraded_reason_logged(caplog):
    """done-gate: 강등 시(cursor_not_found) 서버 로그가 실제로 찍힌다(gcloud logging read 로
    셀 수 있게 되는 핵심 산출) — "코드 넣었다"가 아니라 로그가 실제로 나가는 것까지 확認."""
    import logging

    engine, Session = await _session_factory()
    try:
        seeded = await _seed(Session)
        with caplog.at_level(logging.INFO, logger="app.routers.events"):
            missing_cursor = uuid.uuid4()
            await _read_sync_status_frame(
                org_id=seeded["org_id"], member_id=seeded["member_id"], last_event_id=missing_cursor,
            )
        assert any(
            "sse.backfill_degraded" in r.message and "cursor_not_found" in r.message
            for r in caplog.records
        ), [r.message for r in caplog.records]
    finally:
        await engine.dispose()
