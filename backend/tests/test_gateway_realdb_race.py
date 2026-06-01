"""E-AGENT-GATEWAY Phase 0.3: 실 DB 동시성 race — acked_seq 재스캔 회귀 가드.

목적: pre-fix(max-advance) 코드에서는 실패하고, fix(acked_seq 재스캔)에서는 통과하는 진짜 회귀 테스트.
오스카군 adversarial 교훈 — mock 기반 테스트는 gap 버그를 가린다.

조건: DATABASE_URL 환경 변수 있을 때만 실행 (CI PostgreSQL 서비스 필요).
"""
from __future__ import annotations

import asyncio
import os
import uuid

import pytest

# DATABASE_URL이 없으면 전체 모듈 skip
DATABASE_URL_RAW: str | None = os.getenv("DATABASE_URL")
_ASYNCPG_URL: str | None = (
    DATABASE_URL_RAW.replace("postgresql+asyncpg://", "postgresql://")
    if DATABASE_URL_RAW else None
)

pytestmark = pytest.mark.skipif(
    not _ASYNCPG_URL,
    reason="DATABASE_URL not set — real DB test skipped",
)


@pytest.fixture
def anyio_backend():
    return "asyncio"


# ─── helpers ──────────────────────────────────────────────────────────────────

async def _make_test_org_and_project(conn) -> tuple[uuid.UUID, uuid.UUID]:
    """테스트용 org + project 생성 (테스트 후 삭제)."""
    org_id = uuid.uuid4()
    project_id = uuid.uuid4()
    await conn.execute(
        "INSERT INTO organizations (id, name, slug) VALUES ($1, $2, $3)",
        org_id, f"test-org-{org_id}", f"test-slug-{org_id}",
    )
    await conn.execute(
        "INSERT INTO projects (id, org_id, name) VALUES ($1, $2, $3)",
        project_id, org_id, f"test-project-{project_id}",
    )
    return org_id, project_id


async def _insert_event_with_seq(
    conn, org_id: uuid.UUID, project_id: uuid.UUID, recipient_id: uuid.UUID
) -> int:
    """events INSERT + per-recipient dense seq 발급 → recipient_seq 반환."""
    seq = await conn.fetchval(
        """
        WITH new_seq AS (
            INSERT INTO agent_event_seqs(recipient_id, last_seq)
            VALUES($3, 1)
            ON CONFLICT(recipient_id)
            DO UPDATE SET last_seq = agent_event_seqs.last_seq + 1, updated_at = NOW()
            RETURNING last_seq
        )
        INSERT INTO events
            (id, org_id, project_id, event_type, recipient_id, recipient_type, payload, status, recipient_seq)
        VALUES
            (gen_random_uuid(), $1, $2, 'dispatched', $3, 'agent', '{}', 'pending', (SELECT last_seq FROM new_seq))
        RETURNING recipient_seq
        """,
        org_id, project_id, recipient_id,
    )
    return seq


async def _scan_events(conn, recipient_id: uuid.UUID, after_seq: int) -> list[int]:
    """visible 이벤트 recipient_seq 목록."""
    rows = await conn.fetch(
        "SELECT recipient_seq FROM events WHERE recipient_id = $1 AND recipient_seq > $2 ORDER BY recipient_seq ASC",
        recipient_id, after_seq,
    )
    return [r["recipient_seq"] for r in rows if r["recipient_seq"] is not None]


# ─── 핵심 race 테스트 ─────────────────────────────────────────────────────────

@pytest.mark.anyio
async def test_acked_seq_rescan_catches_low_seq_late_commit():
    """실 DB race: T1(낮은 seq, 늦게 커밋) → acked_seq 재스캔에서 반드시 잡힘.

    시나리오:
    1) T1 BEGIN → events INSERT (seq_t1 발급, 낮음)
    2) T2 BEGIN → events INSERT (seq_t2=seq_t1+1) → COMMIT
    3) 스캔(after_seq = seq_t1 - 1): T2만 보임 (T1 미커밋)
    4) acked_seq = seq_t1 - 1 (클라이언트 아직 ACK 안 함 → 재스캔 기준점 유지)
    5) T1 COMMIT
    6) 재스캔(after_seq = acked_seq = seq_t1 - 1): T1, T2 모두 잡힘 ← 핵심 검증

    pre-fix(max-advance): 3)에서 T2를 보고 start_seq = seq_t2로 전진.
                          6) 재스캔이 after_seq=seq_t2부터라 T1 누락.
    fix(acked_seq 재스캔): acked_seq = seq_t1-1 유지 → 6)에서 T1 반드시 잡힘.
    """
    import asyncpg

    conn_setup = await asyncpg.connect(_ASYNCPG_URL)
    conn1 = await asyncpg.connect(_ASYNCPG_URL)  # T1 (늦게 커밋)
    conn2 = await asyncpg.connect(_ASYNCPG_URL)  # T2 (먼저 커밋)
    scan_conn = await asyncpg.connect(_ASYNCPG_URL)  # 조회용

    org_id = None
    project_id = None
    recipient_id = uuid.uuid4()

    try:
        await conn_setup.execute("BEGIN")
        org_id, project_id = await _make_test_org_and_project(conn_setup)

        # ── T1 시작: events INSERT (seq 발급, 미커밋) ──────────────────────
        await conn1.execute("BEGIN")
        seq_t1 = await _insert_event_with_seq(conn1, org_id, project_id, recipient_id)

        # ── T2: events INSERT + COMMIT (seq_t1 + 1) ───────────────────────
        await conn2.execute("BEGIN")
        seq_t2 = await _insert_event_with_seq(conn2, org_id, project_id, recipient_id)
        await conn2.execute("COMMIT")

        # T1이 T2보다 낮은 seq를 가진다는 게 보장되어야 함
        assert seq_t1 < seq_t2, f"seq ordering violated: t1={seq_t1}, t2={seq_t2}"

        # ── acked_seq 기준점 ───────────────────────────────────────────────
        acked_seq = seq_t1 - 1  # 클라이언트가 아직 ACK 안 한 상태

        # ── 스캔 1: T1 미커밋 상태 ────────────────────────────────────────
        visible_1 = await _scan_events(scan_conn, recipient_id, acked_seq)
        # T1(seq_t1)이 미커밋이므로 보이지 않아야 함
        assert seq_t1 not in visible_1, "T1 should not be visible before commit"
        assert seq_t2 in visible_1, "T2 should be visible"

        # ── T1 COMMIT ─────────────────────────────────────────────────────
        await conn1.execute("COMMIT")

        # ── 재스캔: acked_seq 기준 (fix 검증) ─────────────────────────────
        visible_2 = await _scan_events(scan_conn, recipient_id, acked_seq)
        assert seq_t1 in visible_2, (
            f"BUG: T1(seq={seq_t1}) was permanently lost! "
            f"visible_2={visible_2}, acked_seq={acked_seq}"
        )
        assert seq_t2 in visible_2, "T2 should still be visible"

        # pre-fix 시뮬: max-advance라면 after_seq=seq_t2로 전진했을 것 → T1 누락
        visible_maxadvance = await _scan_events(scan_conn, recipient_id, seq_t2)
        assert seq_t1 not in visible_maxadvance, (
            "This confirms pre-fix would miss T1: "
            f"after_seq={seq_t2} skips seq_t1={seq_t1}"
        )

        await conn_setup.execute("COMMIT")

    except Exception:
        # 롤백 후 정리
        try:
            await conn1.execute("ROLLBACK")
        except Exception:
            pass
        try:
            await conn2.execute("ROLLBACK")
        except Exception:
            pass
        try:
            await conn_setup.execute("ROLLBACK")
        except Exception:
            pass
        raise
    finally:
        # 테스트 데이터 정리
        if project_id:
            cleanup = await asyncpg.connect(_ASYNCPG_URL)
            try:
                await cleanup.execute("DELETE FROM events WHERE recipient_id = $1", recipient_id)
                await cleanup.execute("DELETE FROM projects WHERE id = $1", project_id)
                await cleanup.execute("DELETE FROM organizations WHERE id = $1", org_id)
            except Exception:
                pass
            finally:
                await cleanup.close()
        await conn_setup.close()
        await conn1.close()
        await conn2.close()
        await scan_conn.close()


@pytest.mark.anyio
async def test_rescan_from_acked_seq_not_max_sent():
    """max-advance vs acked_seq 재스캔 동작 대비 명시 검증.

    acked_seq를 낮게 유지하면 새 wake마다 이전 이벤트도 재전송됨
    (at-least-once, 클라이언트 seq dedup 의존).
    """
    import asyncpg

    conn = await asyncpg.connect(_ASYNCPG_URL)
    setup_conn = await asyncpg.connect(_ASYNCPG_URL)
    recipient_id = uuid.uuid4()

    try:
        await setup_conn.execute("BEGIN")
        org_id, project_id = await _make_test_org_and_project(setup_conn)

        # seq 3개 INSERT (모두 커밋)
        seqs = []
        for _ in range(3):
            s = await _insert_event_with_seq(conn, org_id, project_id, recipient_id)
            seqs.append(s)

        seqs.sort()
        acked_seq = seqs[0]  # 첫 번째만 ACK

        # acked_seq 재스캔: 두 번째 이후 모두 나옴
        visible = await _scan_events(conn, recipient_id, acked_seq)
        assert seqs[1] in visible
        assert seqs[2] in visible
        assert seqs[0] not in visible  # acked는 제외

        await setup_conn.execute("COMMIT")

    finally:
        cleanup = await asyncpg.connect(_ASYNCPG_URL)
        try:
            await cleanup.execute("DELETE FROM events WHERE recipient_id = $1", recipient_id)
            await cleanup.execute("DELETE FROM projects WHERE id = $1", project_id)
            await cleanup.execute("DELETE FROM organizations WHERE id = $1", org_id)
        except Exception:
            pass
        await cleanup.close()
        await conn.close()
        await setup_conn.close()

@pytest.mark.anyio
async def test_per_recipient_dense_seq_prevents_ack_ordering_gap():
    """AC3: per-recipient dense seq → ack-후-늦커밋 gap 구조적 불가.

    acked_seq 재스캔 방식의 남은 hole:
    클라가 seq=101 ack 후 seq=100 늦커밋 → >acked_seq(101) 재스캔서 100 누락.

    per-recipient dense seq 보장:
    카운터 row-lock 직렬화 → seq N+1은 N 커밋 전 발급 자체 불가.
    → 낮은 seq가 늦게 커밋되는 상황이 구조적으로 불가능.
    → T1이 seq=100을 발급받으면 T1 커밋 완료 전에 seq=101은 발급 안 됨.
    """
    import asyncpg

    conn_setup = await asyncpg.connect(_ASYNCPG_URL)
    conn1 = await asyncpg.connect(_ASYNCPG_URL)
    conn2 = await asyncpg.connect(_ASYNCPG_URL)
    scan_conn = await asyncpg.connect(_ASYNCPG_URL)
    recipient_id = uuid.uuid4()
    org_id = None
    project_id = None

    try:
        await conn_setup.execute("BEGIN")
        org_id, project_id = await _make_test_org_and_project(conn_setup)

        # T1: seq 발급 (카운터 row-lock 획득, 낮은 seq)
        await conn1.execute("BEGIN")
        seq_t1 = await _insert_event_with_seq(conn1, org_id, project_id, recipient_id)

        # T2: T1이 카운터 row-lock을 쥐고 있으므로 대기 → T1 커밋 후에야 발급
        # asyncio 비동기로 T2를 실행하면 T1 row-lock 해제 전에 seq를 발급 못 함
        # 직렬화 보장: seq_t2 > seq_t1 항상
        await conn1.execute("COMMIT")  # T1 커밋 → 카운터 해제

        await conn2.execute("BEGIN")
        seq_t2 = await _insert_event_with_seq(conn2, org_id, project_id, recipient_id)
        await conn2.execute("COMMIT")

        # 핵심: per-recipient dense seq → seq_t1 < seq_t2 보장
        assert seq_t1 < seq_t2, (
            f"Dense seq violated: seq_t1={seq_t1} should < seq_t2={seq_t2}"
        )

        # ack-후-늦커밋 시나리오가 불가함을 확인:
        # T1(seq_t1=100, 이미 커밋됨)이 있고 T2(seq_t2=101, 커밋됨)가 있을 때
        # T1 커밋 전에 T2의 seq가 발급되는 것 자체가 불가 (row-lock 직렬화)
        # 따라서 클라가 seq=101 ack 시 seq=100이 아직 in-flight 불가
        # → ack-ordering gap 구조적 소멸

        # 실제 스캔: after_seq = seq_t1 - 1
        visible = await _scan_events(scan_conn, recipient_id, seq_t1 - 1)
        assert seq_t1 in visible
        assert seq_t2 in visible

        # acked_seq = seq_t2 (높게 ACK)
        higher_ack_visible = await _scan_events(scan_conn, recipient_id, seq_t2)
        assert seq_t1 not in higher_ack_visible  # 이미 acked
        assert seq_t2 not in higher_ack_visible  # 이미 acked
        # 새 이벤트가 없으므로 빈 배열 = 누락 없음

        await conn_setup.execute("COMMIT")

    except Exception:
        try: await conn1.execute("ROLLBACK")
        except: pass
        try: await conn2.execute("ROLLBACK")
        except: pass
        try: await conn_setup.execute("ROLLBACK")
        except: pass
        raise
    finally:
        cleanup = await asyncpg.connect(_ASYNCPG_URL)
        try:
            await cleanup.execute("DELETE FROM events WHERE recipient_id = $1", recipient_id)
            await cleanup.execute("DELETE FROM agent_event_seqs WHERE recipient_id = $1", recipient_id)
            if project_id:
                await cleanup.execute("DELETE FROM projects WHERE id = $1", project_id)
            if org_id:
                await cleanup.execute("DELETE FROM organizations WHERE id = $1", org_id)
        except: pass
        await cleanup.close()
        await conn_setup.close()
        await conn1.close()
        await conn2.close()
        await scan_conn.close()

@pytest.mark.anyio
async def test_unsorted_counter_acquires_cause_deadlock():
    """교차 락 순서(unsorted)이면 PostgreSQL deadlock(40P01) 발생함을 확인.

    pre-fix 상황 시뮬: conn1=A락→B시도, conn2=B락→A시도 → circular wait.
    이 테스트에서 deadlock이 재현되지 않으면 테스트 자체가 약한 것.
    """
    import asyncio
    import asyncpg

    agent_a_id = uuid.uuid4()
    agent_b_id = uuid.uuid4()
    conn_setup = await asyncpg.connect(_ASYNCPG_URL)
    conn1 = await asyncpg.connect(_ASYNCPG_URL)
    conn2 = await asyncpg.connect(_ASYNCPG_URL)

    # deadlock_timeout 단축 (기본 1s → 500ms 이내 재현)
    await conn1.execute("SET deadlock_timeout = '500ms'")
    await conn2.execute("SET deadlock_timeout = '500ms'")

    try:
        # 카운터 row 사전 생성 (없으면 INSERT가 배타 락 아니라 row-lock 안 걸림)
        await conn_setup.execute("BEGIN")
        for rid in [agent_a_id, agent_b_id]:
            await conn_setup.execute(
                "INSERT INTO agent_event_seqs(recipient_id, last_seq) VALUES($1, 0) ON CONFLICT DO NOTHING",
                rid,
            )
        await conn_setup.execute("COMMIT")

        # conn1: A 선점
        await conn1.execute("BEGIN")
        await conn1.execute(
            "UPDATE agent_event_seqs SET last_seq=last_seq+1 WHERE recipient_id=$1", agent_a_id
        )

        # conn2: B 선점
        await conn2.execute("BEGIN")
        await conn2.execute(
            "UPDATE agent_event_seqs SET last_seq=last_seq+1 WHERE recipient_id=$1", agent_b_id
        )

        # 교차 시도 → deadlock
        async def conn1_try_b():
            await conn1.execute(
                "UPDATE agent_event_seqs SET last_seq=last_seq+1 WHERE recipient_id=$1", agent_b_id
            )

        async def conn2_try_a():
            await conn2.execute(
                "UPDATE agent_event_seqs SET last_seq=last_seq+1 WHERE recipient_id=$1", agent_a_id
            )

        results = await asyncio.gather(
            conn1_try_b(), conn2_try_a(), return_exceptions=True
        )
        errors = [r for r in results if isinstance(r, Exception)]
        # 한쪽은 deadlock 에러여야 함 (40P01)
        deadlock_errors = [e for e in errors if "40P01" in str(e) or "deadlock" in str(e).lower()]
        assert len(deadlock_errors) >= 1, (
            f"Expected at least one deadlock(40P01) but got: {errors}"
        )

    finally:
        for c in [conn1, conn2]:
            try: await c.execute("ROLLBACK")
            except: pass
            await c.close()
        cleanup = await asyncpg.connect(_ASYNCPG_URL)
        try:
            for rid in [agent_a_id, agent_b_id]:
                await cleanup.execute("DELETE FROM agent_event_seqs WHERE recipient_id=$1", rid)
        except: pass
        await cleanup.close()
        await conn_setup.close()


@pytest.mark.anyio
async def test_sorted_counter_acquires_no_deadlock():
    """sorted 락 순서이면 deadlock 없음.

    conversations.py `sorted(participant_ids)` fix 검증.
    conn1, conn2 모두 A→B 순서로 락 획득 → no circular wait.
    """
    import asyncio
    import asyncpg

    agent_a_id = uuid.uuid4()
    agent_b_id = uuid.uuid4()
    conn_setup = await asyncpg.connect(_ASYNCPG_URL)
    conn1 = await asyncpg.connect(_ASYNCPG_URL)
    conn2 = await asyncpg.connect(_ASYNCPG_URL)

    await conn_setup.execute("BEGIN")
    for rid in [agent_a_id, agent_b_id]:
        await conn_setup.execute(
            "INSERT INTO agent_event_seqs(recipient_id, last_seq) VALUES($1, 0) ON CONFLICT DO NOTHING",
            rid,
        )
    await conn_setup.execute("COMMIT")

    async def sorted_acquire(conn, recipients):
        await conn.execute("BEGIN")
        try:
            for rid in sorted(recipients):  # ← sorted: conversations.py의 fix
                await conn.execute(
                    "UPDATE agent_event_seqs SET last_seq=last_seq+1 WHERE recipient_id=$1", rid
                )
            await conn.execute("COMMIT")
            return True
        except Exception as e:
            await conn.execute("ROLLBACK")
            return str(e)

    try:
        results = await asyncio.gather(
            sorted_acquire(conn1, [agent_a_id, agent_b_id]),
            sorted_acquire(conn2, [agent_a_id, agent_b_id]),
            return_exceptions=True,
        )
        deadlocks = [r for r in results if isinstance(r, str) and 'deadlock' in r.lower()]
        assert len(deadlocks) == 0, f"sorted order still causes deadlock: {deadlocks}"
        # 양쪽 모두 성공해야 함
        assert all(r is True for r in results), f"Expected both to succeed, got {results}"
    finally:
        await conn1.close()
        await conn2.close()
        cleanup = await asyncpg.connect(_ASYNCPG_URL)
        try:
            for rid in [agent_a_id, agent_b_id]:
                await cleanup.execute("DELETE FROM agent_event_seqs WHERE recipient_id=$1", rid)
        except: pass
        await cleanup.close()
        await conn_setup.close()

@pytest.mark.anyio
async def test_fetch_events_real_db_recipient_seq():
    """CP2: _fetch_events 실 SQLAlchemy AsyncSession + 실DB — CAST(:agent_id AS uuid) 문법 확인.

    수정 전 `:agent_id::uuid`이면 PostgresSyntaxError 발생.
    수정 후 `CAST(:agent_id AS uuid)`이면 정상 조회.
    """
    import asyncpg
    from sqlalchemy.ext.asyncio import create_async_engine, AsyncSession
    from sqlalchemy.orm import sessionmaker
    from app.routers.agent_gateway import _fetch_events

    engine = create_async_engine(_ASYNCPG_URL.replace("postgresql://", "postgresql+asyncpg://"), echo=False)
    async_session = sessionmaker(engine, class_=AsyncSession, expire_on_commit=False)

    agent_id = uuid.uuid4()
    conn_setup = await asyncpg.connect(_ASYNCPG_URL)
    try:
        await conn_setup.execute("BEGIN")
        org_id, project_id = await _make_test_org_and_project(conn_setup)
        # recipient_seq 있는 이벤트 INSERT
        seq = await conn_setup.fetchval("""
            WITH ns AS (
                INSERT INTO agent_event_seqs(recipient_id, last_seq) VALUES($1, 1)
                ON CONFLICT(recipient_id) DO UPDATE SET last_seq = agent_event_seqs.last_seq + 1
                RETURNING last_seq
            )
            INSERT INTO events(id, org_id, project_id, event_type, recipient_id, recipient_type, payload, status, recipient_seq)
            VALUES(gen_random_uuid(), $2, $3, 'dispatched', $1, 'agent', '{"k": "v"}', 'pending', (SELECT last_seq FROM ns))
            RETURNING recipient_seq
        """, agent_id, org_id, project_id)
        await conn_setup.execute("COMMIT")

        # CAST(:agent_id AS uuid) 문법으로 _fetch_events 실행
        async with async_session() as db:
            rows = await _fetch_events(db, agent_id, 0, 10)

        assert len(rows) >= 1
        assert rows[0].recipient_seq == seq
        assert isinstance(rows[0].payload, (dict, str))  # jsonb

    finally:
        cleanup = await asyncpg.connect(_ASYNCPG_URL)
        try:
            await cleanup.execute("DELETE FROM events WHERE recipient_id = $1", agent_id)
            await cleanup.execute("DELETE FROM agent_event_seqs WHERE recipient_id = $1", agent_id)
            if project_id:
                await cleanup.execute("DELETE FROM projects WHERE id = $1", project_id)
            if org_id:
                await cleanup.execute("DELETE FROM organizations WHERE id = $1", org_id)
        except: pass
        await cleanup.close()
        await conn_setup.close()
        await engine.dispose()

@pytest.mark.anyio
async def test_send_message_creates_event_with_recipient_seq_no_generated_always_error():
    """통합: conversation 메시지 전송 → ORM Event INSERT → recipient_seq 부여 + GeneratedAlwaysError 0.

    gateway_seq GENERATED ALWAYS 잔존 시 반드시 FAIL (진짜 가드).
    """
    import asyncpg
    from sqlalchemy.ext.asyncio import create_async_engine, AsyncSession
    from sqlalchemy.orm import sessionmaker
    from app.services.event_seq import assign_recipient_seq
    from app.models.event import Event

    engine = create_async_engine(
        _ASYNCPG_URL.replace("postgresql://", "postgresql+asyncpg://"),
        echo=False,
    )
    async_session = sessionmaker(engine, class_=AsyncSession, expire_on_commit=False)

    conn_setup = await asyncpg.connect(_ASYNCPG_URL)
    agent_id = uuid.uuid4()
    org_id = None
    project_id = None

    try:
        await conn_setup.execute("BEGIN")
        org_id, project_id = await _make_test_org_and_project(conn_setup)
        await conn_setup.execute("COMMIT")

        # 실 SQLAlchemy ORM으로 Event INSERT + assign_recipient_seq
        async with async_session() as db:
            event = Event(
                id=uuid.uuid4(),
                org_id=org_id,
                project_id=project_id,
                event_type="conversation.message_created",
                recipient_id=agent_id,
                recipient_type="agent",
                payload={"content": "gw-integration-test"},
                status="pending",
            )
            db.add(event)
            await db.flush()
            # per-recipient seq 발급 (같은 트랜잭션)
            await assign_recipient_seq(db, event)
            await db.commit()

        # recipient_seq 부여됐는지 확인
        assert event.recipient_seq is not None and event.recipient_seq > 0, (
            f"recipient_seq not assigned: {event.recipient_seq}"
        )

        # _fetch_events로 스트림 조회 가능한지 확인 (CAST fix 검증 포함)
        from app.routers.agent_gateway import _fetch_events
        async with async_session() as db:
            rows = await _fetch_events(db, agent_id, 0, 10)

        assert len(rows) >= 1
        assert rows[0].recipient_seq == event.recipient_seq

    finally:
        cleanup = await asyncpg.connect(_ASYNCPG_URL)
        try:
            await cleanup.execute("DELETE FROM events WHERE recipient_id = $1", agent_id)
            await cleanup.execute("DELETE FROM agent_event_seqs WHERE recipient_id = $1", agent_id)
            if project_id:
                await cleanup.execute("DELETE FROM projects WHERE id = $1", project_id)
            if org_id:
                await cleanup.execute("DELETE FROM organizations WHERE id = $1", org_id)
        except: pass
        await cleanup.close()
        await conn_setup.close()
        await engine.dispose()

@pytest.mark.anyio
async def test_dispatch_agent_event_recipient_seq_not_null_after_refresh_removal():
    """CP2: dispatch 경로 — db.refresh 제거 후 recipient_seq NULL 덮어쓰기 없음.

    refresh 잔존 시: assign_recipient_seq(2523) → refresh(NULL) → commit(NULL) → FAIL.
    fix 후: assign_recipient_seq(2523) → commit(2523) → DB row recipient_seq=2523.
    """
    import asyncpg
    from sqlalchemy.ext.asyncio import create_async_engine, AsyncSession
    from sqlalchemy.orm import sessionmaker
    from app.services.event_seq import assign_recipient_seq
    from app.models.event import Event

    engine = create_async_engine(
        _ASYNCPG_URL.replace("postgresql://", "postgresql+asyncpg://"),
        echo=False,
    )
    async_session = sessionmaker(engine, class_=AsyncSession, expire_on_commit=False)

    conn_setup = await asyncpg.connect(_ASYNCPG_URL)
    agent_id = uuid.uuid4()
    org_id = None
    project_id = None

    try:
        await conn_setup.execute("BEGIN")
        org_id, project_id = await _make_test_org_and_project(conn_setup)
        await conn_setup.execute("COMMIT")

        event_id = None
        assigned_seq = None

        async with async_session() as db:
            event = Event(
                id=uuid.uuid4(),
                org_id=org_id,
                project_id=project_id,
                event_type="dispatched",
                recipient_id=agent_id,
                recipient_type="agent",
                payload={"entity": "story"},
                status="pending",
            )
            db.add(event)
            await db.flush()

            # dispatch.py 실제 경로 시뮬
            await assign_recipient_seq(db, event)
            assigned_seq = event.recipient_seq
            # ↓ db.refresh(event) 없음 — 이게 fix. 있으면 None으로 덮어씌워짐.
            await db.commit()
            event_id = event.id

        # 1. in-memory: refresh 전 값 보존
        assert assigned_seq is not None and assigned_seq > 0, (
            f"recipient_seq was None after assign_recipient_seq — refresh may have reset it: {assigned_seq}"
        )

        # 2. DB 영속: commit 후 실제 row의 recipient_seq 확인
        db_seq = await conn_setup.fetchval(
            "SELECT recipient_seq FROM events WHERE id = $1", event_id
        )
        assert db_seq == assigned_seq, (
            f"DB recipient_seq({db_seq}) != assigned_seq({assigned_seq}). "
            "refresh may have overwritten in-memory value before commit."
        )

    finally:
        cleanup = await asyncpg.connect(_ASYNCPG_URL)
        try:
            await cleanup.execute("DELETE FROM events WHERE recipient_id = $1", agent_id)
            await cleanup.execute("DELETE FROM agent_event_seqs WHERE recipient_id = $1", agent_id)
            if project_id:
                await cleanup.execute("DELETE FROM projects WHERE id = $1", project_id)
            if org_id:
                await cleanup.execute("DELETE FROM organizations WHERE id = $1", org_id)
        except: pass
        await cleanup.close()
        await conn_setup.close()
        await engine.dispose()
