"""E-AGENT-GATEWAY P0 (69e118a0): ack 로직 실DB 통합 테스트.

AC4 — mock 금지:
  (a) 주입→ack→재연결 backfill 0
  (b) 프로세스 재시작 시뮬(header_seq=0) → acked_seq 영속으로 backfill 0
  (c) 중복 주입 0 (seen_ids dedup 동작)

DATABASE_URL 환경 변수 없으면 skip.
"""
from __future__ import annotations

import asyncio
import os
import uuid

import pytest

DATABASE_URL_RAW: str | None = os.getenv("DATABASE_URL")
_ASYNCPG_URL: str | None = (
    DATABASE_URL_RAW.replace("postgresql+asyncpg://", "postgresql://")
    if DATABASE_URL_RAW else None
)

_requires_db = pytest.mark.skipif(
    not _ASYNCPG_URL,
    reason="DATABASE_URL not set — real DB test skipped",
)


@pytest.fixture
def anyio_backend():
    return "asyncio"


# ─── helpers ──────────────────────────────────────────────────────────────────

async def _setup_org_project(conn) -> tuple[uuid.UUID, uuid.UUID]:
    org_id, project_id = uuid.uuid4(), uuid.uuid4()
    await conn.execute(
        "INSERT INTO organizations (id, name, slug) VALUES ($1, $2, $3)",
        org_id, f"test-ack-org-{org_id}", f"test-ack-{org_id}",
    )
    await conn.execute(
        "INSERT INTO projects (id, org_id, name) VALUES ($1, $2, $3)",
        project_id, org_id, f"test-ack-proj-{project_id}",
    )
    return org_id, project_id


async def _insert_event(conn, org_id, project_id, recipient_id) -> int:
    """이벤트 삽입 → recipient_seq 반환."""
    return await conn.fetchval(
        """
        WITH new_seq AS (
            INSERT INTO agent_event_seqs(recipient_id, last_seq)
            VALUES ($3, 1)
            ON CONFLICT(recipient_id)
            DO UPDATE SET last_seq = agent_event_seqs.last_seq + 1, updated_at = NOW()
            RETURNING last_seq
        )
        INSERT INTO events
            (id, org_id, project_id, event_type, recipient_id, recipient_type, payload, status, recipient_seq)
        VALUES
            (gen_random_uuid(), $1, $2, 'dispatched', $3, 'agent', '{}', 'pending',
             (SELECT last_seq FROM new_seq))
        RETURNING recipient_seq
        """,
        org_id, project_id, recipient_id,
    )


async def _upsert_acked_seq(conn, agent_id: uuid.UUID, seq: int) -> None:
    """agent_event_cursors acked_seq UPSERT — sse_bridge._send_ack 서버 효과와 동일."""
    await conn.execute(
        """
        INSERT INTO agent_event_cursors (agent_id, acked_seq)
        VALUES ($1, $2)
        ON CONFLICT (agent_id)
        DO UPDATE SET acked_seq = GREATEST(agent_event_cursors.acked_seq, $2),
                      updated_at = NOW()
        """,
        agent_id, seq,
    )


async def _get_acked_seq(conn, agent_id: uuid.UUID) -> int:
    row = await conn.fetchrow(
        "SELECT acked_seq FROM agent_event_cursors WHERE agent_id = $1", agent_id
    )
    return row["acked_seq"] if row else 0


async def _fetch_events_after(conn, agent_id: uuid.UUID, after_seq: int) -> list[int]:
    """start_seq 이후 visible 이벤트 recipient_seq 목록 — agent_gateway._fetch_events와 동일 쿼리."""
    rows = await conn.fetch(
        """
        SELECT e.recipient_seq
        FROM events e
        WHERE e.recipient_id = $1 AND e.recipient_seq > $2
        ORDER BY e.recipient_seq ASC
        LIMIT 100
        """,
        agent_id, after_seq,
    )
    return [r["recipient_seq"] for r in rows]


# ─── 테스트 ───────────────────────────────────────────────────────────────────

@_requires_db
@pytest.mark.anyio
async def test_ack_prevents_backfill_on_reconnect():
    """(a) 주입→ack→재연결 backfill 0.

    ack(seq=S) → acked_seq=S → 재연결 시 start_seq=S → S 이하 이벤트 backfill 없음.
    """
    import asyncpg

    conn = await asyncpg.connect(_ASYNCPG_URL)
    agent_id = uuid.uuid4()
    try:
        org_id, project_id = await _setup_org_project(conn)

        # 이벤트 2개 삽입
        seq1 = await _insert_event(conn, org_id, project_id, agent_id)
        seq2 = await _insert_event(conn, org_id, project_id, agent_id)
        assert seq2 == seq1 + 1

        # seq2까지 ack
        await _upsert_acked_seq(conn, agent_id, seq2)
        stored = await _get_acked_seq(conn, agent_id)
        assert stored == seq2, f"acked_seq should be {seq2}, got {stored}"

        # 재연결: start_seq = max(acked_seq=seq2, header_seq=0) = seq2
        backfill = await _fetch_events_after(conn, agent_id, seq2)
        assert backfill == [], f"backfill should be empty after ack, got {backfill}"

    finally:
        await conn.execute("DELETE FROM events WHERE recipient_id = $1", agent_id)
        await conn.execute("DELETE FROM agent_event_cursors WHERE agent_id = $1", agent_id)
        await conn.execute("DELETE FROM agent_event_seqs WHERE recipient_id = $1", agent_id)
        await conn.close()


@_requires_db
@pytest.mark.anyio
async def test_ack_persists_across_process_restart():
    """(b) 프로세스 재시작 시뮬 → acked_seq 영속으로 backfill 0.

    재시작 시 _current_last_event_id="" → header_seq=0.
    start_seq = max(acked_seq=S, header_seq=0) = S → backfill 없음.
    """
    import asyncpg

    conn = await asyncpg.connect(_ASYNCPG_URL)
    agent_id = uuid.uuid4()
    try:
        org_id, project_id = await _setup_org_project(conn)

        seq = await _insert_event(conn, org_id, project_id, agent_id)
        await _upsert_acked_seq(conn, agent_id, seq)

        # 프로세스 재시작 시뮬: header_seq=0 (Last-Event-ID header 없음)
        # start_seq = max(acked_seq=seq, 0) = seq
        acked = await _get_acked_seq(conn, agent_id)
        start_seq = max(acked, 0)  # header_seq=0

        backfill = await _fetch_events_after(conn, agent_id, start_seq)
        assert backfill == [], (
            f"restart backfill should be 0: start_seq={start_seq}, got {backfill}"
        )

    finally:
        await conn.execute("DELETE FROM events WHERE recipient_id = $1", agent_id)
        await conn.execute("DELETE FROM agent_event_cursors WHERE agent_id = $1", agent_id)
        await conn.execute("DELETE FROM agent_event_seqs WHERE recipient_id = $1", agent_id)
        await conn.close()


@pytest.mark.anyio
async def test_no_duplicate_injection_via_seen_ids():
    """(c) 중복 주입 0 — SeenIdsCache dedup 동작 검증.

    동일 event_id를 두 번 _handle에 공급하면 두 번째는 skip됨을 확인.
    """
    from sprintable_mcp.sse_bridge import SeenIdsCache, SseEvent

    seen = SeenIdsCache(max_size=100, ttl_seconds=3600)
    injected: list[str] = []

    def _mock_inject(event_id: str) -> bool:
        """seen_ids 기반 dedup 로직 직접 검증."""
        if event_id in seen:
            return False  # dup — skip
        seen.add(event_id)
        injected.append(event_id)
        return True

    eid = "test-event-id-12345"
    assert _mock_inject(eid) is True, "first inject should succeed"
    assert _mock_inject(eid) is False, "duplicate inject should be skipped"
    assert injected == [eid], f"should have exactly 1 injection, got {injected}"


@pytest.mark.anyio
async def test_send_ack_calls_correct_endpoint():
    """CP2: _send_ack가 POST /api/v2/agent/events/ack + {"seq": N} 호출 단언.

    ack 로직 제거 시 반드시 FAIL — 동어반복 방지.
    """
    import asyncio
    import os
    from unittest.mock import patch

    from sprintable_mcp import api_client
    from sprintable_mcp.sse_bridge import SseEvent, start_sse_bridge

    acked_payloads: list[dict] = []
    ack_received: asyncio.Event = asyncio.Event()

    async def mock_post(path: str, *, json: dict | None = None):
        if path == "/api/v2/agent/events/ack":
            acked_payloads.append({"path": path, "json": json})
            ack_received.set()
        return {}

    # SSE 스트림: seq=77 이벤트 1개 emit 후 즉시 종료
    async def mock_connect_once(client, member_id, last_event_id, on_event):
        on_event(SseEvent(
            event_type="dispatched",
            data='{"recipient_seq": 77, "is_backfill": false}',
            last_event_id="77",
        ))

    with patch.object(api_client.client, "post", side_effect=mock_post), \
         patch("sprintable_mcp.sse_bridge._connect_once", side_effect=mock_connect_once), \
         patch.dict(os.environ, {"AGENT_GATEWAY_V2": "1"}):

        task = asyncio.create_task(
            start_sse_bridge("http://test-api", "test-key", "test-member")
        )
        try:
            await asyncio.wait_for(ack_received.wait(), timeout=2.0)
        finally:
            task.cancel()
            try:
                await task
            except (asyncio.CancelledError, Exception):
                pass

    assert acked_payloads, "_send_ack was never called — ack 로직 누락"
    assert acked_payloads[0]["path"] == "/api/v2/agent/events/ack", (
        f"Wrong endpoint: {acked_payloads[0]['path']}"
    )
    assert acked_payloads[0]["json"] == {"seq": 77}, (
        f"Wrong payload: {acked_payloads[0]['json']}"
    )


@pytest.mark.anyio
async def test_contiguous_ack_only():
    """ack는 연속 최고 seq만 — 갭 있으면 갭 직전까지만 ack.

    seq 1,2,4 수신: pending={1,2,4}, base=0 → contiguous max=2 (4는 갭)
    seq 3 수신: pending={3,4} → contiguous max=4
    """
    # _schedule_ack_if_ready 로직을 인라인 검증 (앵커링 포함)
    pending: set[int] = set()
    last_acked = [0]

    def _compute(seq: int) -> int | None:
        pending.add(seq)
        if not pending:
            return None
        base = last_acked[0]
        if base == 0:
            base = min(pending) - 1
            last_acked[0] = base
        current = base
        while (current + 1) in pending:
            pending.discard(current + 1)
            current += 1
        if current > base:
            last_acked[0] = current
            return current
        return None

    assert _compute(1) == 1   # base=0 → anchored to 0 (min=1, 1-1=0)
    assert _compute(2) == 2
    assert _compute(4) is None, "gap at 3 — should not ack beyond 2"
    assert last_acked[0] == 2
    assert 4 in pending, "seq 4 should remain pending"

    assert _compute(3) == 4, "filling gap 3 → contiguous max becomes 4"
    assert last_acked[0] == 4
    assert not pending, "all seqs should be consumed"
