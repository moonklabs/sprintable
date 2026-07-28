"""story #2249 실PG 테스트 — Gate.status_entered_at / evidence_status_entered_at.

AC1에서 실측한 병(merge_verdict_gate.evaluate_merge_gate가 CI/PR 재평가마다 evidence_status를
같은 값으로 재대입해도 updated_at이 발동해, "이 상태가 된 시각"이 아니라 "재평가 횟수"를 재고
있었다)을 새 컬럼이 그대로 물려받지 않는 것을 실 Postgres로 pin한다. 핵심 주장: 값이 «실제로
바뀔 때만» 갱신 — 같은 값 재대입은 진입 시각을 리셋하지 않는다(오르테가군 AC4 지시).
"""
from __future__ import annotations

import asyncio
import os
import uuid
from datetime import timezone

import pytest

_REAL_DB_URL = os.getenv("PARITY_TEST_DATABASE_URL") or os.getenv("ALEMBIC_DATABASE_URL")

pytestmark = [
    pytest.mark.skipif(not _REAL_DB_URL, reason="통합 테스트는 실 PG(PARITY/ALEMBIC_DATABASE_URL) 필요"),
    pytest.mark.destructive_schema,
]


@pytest.fixture
def anyio_backend():
    return "asyncio"


def _async_url() -> str:
    url = _REAL_DB_URL
    for prefix in ("postgresql+psycopg2://", "postgresql+asyncpg://", "postgresql://"):
        if url.startswith(prefix):
            return "postgresql+asyncpg://" + url[len(prefix):]
    return url


async def _session_factory():
    from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine

    import app.models  # noqa: F401 — 전 모델 메타데이터 로드
    from app.core.database import Base

    engine = create_async_engine(_async_url())
    async with engine.begin() as conn:
        await conn.run_sync(Base.metadata.create_all)
    return engine, async_sessionmaker(engine, expire_on_commit=False)


@pytest.mark.anyio
async def test_status_entered_at_set_on_creation():
    """create_gate()가 신규 행에 status_entered_at을 즉시 채운다(생성=최초 진입)."""
    from app.services.gate_resolver import resolve_disposition
    from unittest.mock import AsyncMock, patch

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org_id, member_id, role_id = uuid.uuid4(), uuid.uuid4(), uuid.uuid4()
            from app.services.gate_service import create_gate
            with patch("app.services.gate_service.resolve_disposition", AsyncMock(return_value=("ask", "system_default"))):
                gate = await create_gate(
                    s, org_id, uuid.uuid4(), "story", "merge", member_id, role_id,
                )
                await s.commit()
            assert gate.status == "pending"
            assert gate.status_entered_at is not None
            assert gate.evidence_status is None
            assert gate.evidence_status_entered_at is None
    finally:
        await engine.dispose()


@pytest.mark.anyio
async def test_status_entered_at_updates_on_real_transition():
    """hold_gate/unhold_gate(실 서비스 호출) — 실제 전이마다 status_entered_at이 전진한다."""
    from app.models.gate import Gate
    from app.services.gate_service import hold_gate, unhold_gate

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org_id = uuid.uuid4()
            gate = Gate(
                id=uuid.uuid4(), org_id=org_id, work_item_id=uuid.uuid4(), work_item_type="story",
                gate_type="merge", status="pending",
            )
            s.add(gate)
            await s.commit()
            t0 = gate.status_entered_at  # None(직접 ORM 생성 — create_gate 미경유)
            assert t0 is None

            g1 = await hold_gate(s, org_id, gate.id, uuid.uuid4(), "reason", None)
            await s.commit()
            t1 = g1.status_entered_at
            assert t1 is not None  # pending→held 실 전이 → 세팅됨

            await asyncio.sleep(0.05)
            g2 = await unhold_gate(s, org_id, gate.id, uuid.uuid4())
            await s.commit()
            t2 = g2.status_entered_at
            assert t2 is not None and t2 > t1  # held→pending 실 전이 → 전진
    finally:
        await engine.dispose()


@pytest.mark.anyio
async def test_evidence_status_entered_at_not_reset_by_same_value_reassignment():
    """⭐AC4 핵심 pin — AC1에서 잡은 병(merge_verdict_gate가 재평가마다 evidence_status를 같은
    값으로 재대입)을 새 컬럼이 물려받지 않는 것을 실 DB로 증명. 같은 값 재대입 2회는
    evidence_status_entered_at을 «건드리지 않는다»(재평가 횟수를 재는 병 재발 금지)."""
    from datetime import datetime

    from app.models.gate import Gate, set_gate_evidence_status

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            gate = Gate(
                id=uuid.uuid4(), org_id=uuid.uuid4(), work_item_id=uuid.uuid4(), work_item_type="story",
                gate_type="merge", status="pending",
            )
            s.add(gate)
            await s.commit()
            assert gate.evidence_status_entered_at is None

            t1 = datetime(2026, 7, 28, 3, 0, 0, tzinfo=timezone.utc)
            set_gate_evidence_status(gate, "blocked", now=t1)  # 1차 재평가: CI fail
            await s.commit()
            assert gate.evidence_status == "blocked"
            assert gate.evidence_status_entered_at == t1

            # 2차·3차 재평가(merge_verdict_gate.evaluate_merge_gate의 실제 호출 패턴 재현) —
            # 값은 여전히 "blocked"(같은 값) — decision_basis 등 다른 필드만 바뀌는 CI 재실행 상황.
            t2 = datetime(2026, 7, 28, 3, 5, 0, tzinfo=timezone.utc)
            set_gate_evidence_status(gate, "blocked", now=t2)
            await s.commit()
            assert gate.evidence_status_entered_at == t1, (
                f"같은 값 재대입인데 entered_at이 {gate.evidence_status_entered_at}로 전진했다 — "
                "AC1에서 잡은 병(재평가 횟수를 재는 것)을 그대로 물려받은 것이다."
            )

            t3 = datetime(2026, 7, 28, 3, 10, 0, tzinfo=timezone.utc)
            set_gate_evidence_status(gate, "blocked", now=t3)
            await s.commit()
            assert gate.evidence_status_entered_at == t1  # 3차도 동일 — 최초 진입 시각 그대로.
    finally:
        await engine.dispose()


@pytest.mark.anyio
async def test_evidence_status_entered_at_updates_on_real_value_change():
    """반대 대조군 — evidence_status가 «실제로» 바뀌면(blocked→sufficient) entered_at이
    전진해야 한다(그래야 «시각이 얼어붙은» 반대쪽 버그도 아닌 것을 함께 증명)."""
    from datetime import datetime

    from app.models.gate import Gate, set_gate_evidence_status

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            gate = Gate(
                id=uuid.uuid4(), org_id=uuid.uuid4(), work_item_id=uuid.uuid4(), work_item_type="story",
                gate_type="merge", status="pending",
            )
            s.add(gate)
            await s.commit()

            t1 = datetime(2026, 7, 28, 3, 0, 0, tzinfo=timezone.utc)
            set_gate_evidence_status(gate, "blocked", now=t1)
            await s.commit()
            assert gate.evidence_status_entered_at == t1

            t2 = datetime(2026, 7, 28, 3, 5, 0, tzinfo=timezone.utc)
            set_gate_evidence_status(gate, "sufficient", now=t2)  # 실제 변경 — CI가 통과로 바뀜
            await s.commit()
            assert gate.evidence_status == "sufficient"
            assert gate.evidence_status_entered_at == t2  # 전진해야 한다.
    finally:
        await engine.dispose()
