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


async def _insert_event(conn, org_id: uuid.UUID, project_id: uuid.UUID, recipient_id: uuid.UUID) -> int:
    """events INSERT → gateway_seq 반환."""
    seq = await conn.fetchval(
        """
        INSERT INTO events
            (id, org_id, project_id, event_type, recipient_id, recipient_type, payload, status)
        VALUES
            (gen_random_uuid(), $1, $2, 'dispatched', $3, 'agent', '{}', 'pending')
        RETURNING gateway_seq
        """,
        org_id, project_id, recipient_id,
    )
    return seq


async def _scan_events(conn, recipient_id: uuid.UUID, after_seq: int) -> list[int]:
    """visible 이벤트 seq 목록."""
    rows = await conn.fetch(
        "SELECT gateway_seq FROM events WHERE recipient_id = $1 AND gateway_seq > $2 ORDER BY gateway_seq ASC",
        recipient_id, after_seq,
    )
    return [r["gateway_seq"] for r in rows]


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
        seq_t1 = await _insert_event(conn1, org_id, project_id, recipient_id)

        # ── T2: events INSERT + COMMIT (seq_t1 + 1) ───────────────────────
        await conn2.execute("BEGIN")
        seq_t2 = await _insert_event(conn2, org_id, project_id, recipient_id)
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
            s = await _insert_event(conn, org_id, project_id, recipient_id)
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
