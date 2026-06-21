"""E-DG S31: admin hold full UX — pending gate 일시 보류(held)·재개(unhold).

핵심: ①pending↔held(held→pending만·held→approve/reject 직접 금지) ②hold→step_run held+held_until→
SLA pause(processor skip) ③unhold→gate_pending 복귀+held_until/resolver/note clear(재개된 pending 깨끗)
④사유 선택·holder=인증 caller·admin-only. gate.held_until(0132 마이그)·step_run.held_until(0126 기존).
"""
from __future__ import annotations

import os
import uuid
from datetime import datetime, timedelta, timezone

import pytest

from app.models.gate import GATE_STATUSES, is_valid_transition

_REAL_DB_URL = os.getenv("PARITY_TEST_DATABASE_URL") or os.getenv("ALEMBIC_DATABASE_URL")


@pytest.fixture
def anyio_backend():
    return "asyncio"


# ── FSM(unit·CI-runnable) ─────────────────────────────────────────────────────
def test_hold_fsm():
    assert "held" in GATE_STATUSES
    assert is_valid_transition("pending", "held") is True
    assert is_valid_transition("held", "pending") is True       # unhold(재개)
    assert is_valid_transition("held", "approved") is False     # 직접 결정 금지(재개 후 pending서)
    assert is_valid_transition("held", "rejected") is False
    assert is_valid_transition("held", "voided") is False


async def _session():
    from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine
    from app.core.database import Base
    import app.models  # noqa: F401
    import app.models.participation  # noqa: F401
    import app.models.workflow_line  # noqa: F401
    url = _REAL_DB_URL
    for prefix in ("postgresql+psycopg2://", "postgresql://"):
        if url.startswith(prefix):
            url = "postgresql+asyncpg://" + url[len(prefix):]
            break
    engine = create_async_engine(url)
    async with engine.begin() as conn:
        await conn.run_sync(Base.metadata.create_all)
    return engine, async_sessionmaker(engine, expire_on_commit=False)


async def _seed_gate(s, org, *, status="pending"):
    from app.models.gate import Gate
    from app.models.workflow_line import WorkflowLineStepRun
    proj = uuid.uuid4()
    wi = uuid.uuid4()
    gate = Gate(id=uuid.uuid4(), org_id=org, work_item_id=wi, work_item_type="story",
                gate_type="merge", status=status)
    s.add(gate)
    await s.flush()
    sr = WorkflowLineStepRun(
        org_id=org, project_id=proj, entity_type="story", entity_id=wi,
        from_status="in-review", to_status="done", status="gate_pending", mode="gate_pending",
        gate_id=gate.id, h1_gate_id=gate.id, correlation_id=uuid.uuid4(),
        transition_id=uuid.uuid4().hex)
    s.add(sr)
    await s.flush()
    return gate, sr


@pytest.mark.skipif(not _REAL_DB_URL, reason="real Postgres 필요")
@pytest.mark.anyio
async def test_hold_then_unhold_roundtrip():
    """⭐hold: gate=held+held_until·step_run=held. unhold: gate=pending+clear·step_run=gate_pending."""
    from app.services.gate_service import hold_gate, unhold_gate
    from app.models.workflow_line import WorkflowLineStepRun
    from sqlalchemy import select
    engine, Session = await _session()
    async with Session() as s:
        org = uuid.uuid4()
        holder = uuid.uuid4()
        until = datetime(2026, 6, 25, tzinfo=timezone.utc)
        gate, sr = await _seed_gate(s, org)
        await s.commit()
        # hold
        g = await hold_gate(s, org, gate.id, holder, "추가 정보 대기", until)
        await s.commit()
        assert g.status == "held" and g.resolver_id == holder
        assert g.resolution_note == "추가 정보 대기" and g.held_until == until
        sr2 = (await s.execute(select(WorkflowLineStepRun).where(WorkflowLineStepRun.id == sr.id))).scalar_one()
        assert sr2.status == "held" and sr2.held_until == until
        # unhold(재개)
        g2 = await unhold_gate(s, org, gate.id, holder)
        await s.commit()
        assert g2.status == "pending"
        assert g2.resolver_id is None and g2.resolution_note is None and g2.held_until is None  # clear
        sr3 = (await s.execute(select(WorkflowLineStepRun).where(WorkflowLineStepRun.id == sr.id))).scalar_one()
        assert sr3.status == "gate_pending" and sr3.held_until is None
    await engine.dispose()


@pytest.mark.skipif(not _REAL_DB_URL, reason="real Postgres 필요")
@pytest.mark.anyio
async def test_hold_indefinite_no_until():
    """무기한 hold(held_until 미지정)도 정상(사유도 선택)."""
    from app.services.gate_service import hold_gate
    engine, Session = await _session()
    async with Session() as s:
        org = uuid.uuid4()
        gate, _ = await _seed_gate(s, org)
        await s.commit()
        g = await hold_gate(s, org, gate.id, uuid.uuid4())  # reason·until 둘 다 None
        await s.commit()
        assert g.status == "held" and g.held_until is None
    await engine.dispose()


@pytest.mark.skipif(not _REAL_DB_URL, reason="real Postgres 필요")
@pytest.mark.anyio
async def test_hold_non_pending_and_unhold_non_held_rejected():
    from app.services.gate_service import hold_gate, unhold_gate
    engine, Session = await _session()
    async with Session() as s:
        org = uuid.uuid4()
        approved, _ = await _seed_gate(s, org, status="approved")
        pending, _ = await _seed_gate(s, org, status="pending")
        await s.commit()
        with pytest.raises(ValueError, match="pending 게이트만"):
            await hold_gate(s, org, approved.id, uuid.uuid4())   # approved 는 hold 불가
        with pytest.raises(ValueError, match="보류"):
            await unhold_gate(s, org, pending.id, uuid.uuid4())  # pending 은 unhold 불가
    await engine.dispose()


@pytest.mark.skipif(not _REAL_DB_URL, reason="real Postgres 필요")
@pytest.mark.anyio
async def test_sla_skips_held_step_run():
    """⭐SLA pause: held step_run 은 processor 가 skip(reminder/escalation 일시정지)."""
    from app.services.workflow_sla_processor import process_sla  # noqa: F401
    from app.models.project import Project
    from app.models.pm import Story
    from app.models.workflow_line import WorkflowLineStepRun
    engine, Session = await _session()
    async with Session() as s:
        org = uuid.uuid4()
        proj = uuid.uuid4()
        s.add(Project(id=proj, org_id=org, name="p"))
        await s.flush()
        story = Story(org_id=org, project_id=proj, title="t", status="in-review", priority="high")
        s.add(story)
        await s.flush()
        # held step_run(started 한참 전 — timeout 넘겨도 held 라 skip 돼야)
        s.add(WorkflowLineStepRun(
            org_id=org, project_id=proj, entity_type="story", entity_id=story.id,
            from_status="in-review", to_status="done", status="held", mode="gate_pending",
            started_at=datetime.now(timezone.utc) - timedelta(days=10),
            correlation_id=uuid.uuid4(), transition_id=uuid.uuid4().hex))
        await s.commit()
        counts = await process_sla(s)
        # held 는 skip(reminded/escalated 0)
        assert counts.get("reminded", 0) == 0 and counts.get("escalated", 0) == 0
        assert counts.get("skipped", 0) >= 1
    await engine.dispose()


# ── 엔드포인트 auth 회귀(CI-runnable) ──────────────────────────────────────────
def _resolved_human():
    from app.services.member_resolver import ResolvedMember
    return ResolvedMember(id=uuid.uuid4(), user_id=uuid.uuid4(), name="a", type="human",
                          role="admin", org_id=uuid.uuid4())


@pytest.mark.anyio
async def test_hold_unhold_endpoints_non_admin_403():
    """hold/unhold 둘 다 non-admin → 403·서비스 호출 0."""
    from types import SimpleNamespace
    from unittest.mock import AsyncMock, patch
    from fastapi import HTTPException
    from app.routers import gates as gates_mod
    from app.routers.gates import GateHoldRequest, hold_gate_endpoint, unhold_gate_endpoint
    holdfn, unholdfn = AsyncMock(), AsyncMock()
    with patch.object(gates_mod, "resolve_member", AsyncMock(return_value=_resolved_human())), \
         patch.object(gates_mod, "is_org_owner_or_admin", AsyncMock(return_value=False)), \
         patch.object(gates_mod, "hold_gate", holdfn), \
         patch.object(gates_mod, "unhold_gate", unholdfn):
        with pytest.raises(HTTPException) as ei1:
            await hold_gate_endpoint(id=uuid.uuid4(), body=GateHoldRequest(), session=AsyncMock(),
                                     org_id=uuid.uuid4(), auth=SimpleNamespace(user_id=str(uuid.uuid4())))
        with pytest.raises(HTTPException) as ei2:
            await unhold_gate_endpoint(id=uuid.uuid4(), session=AsyncMock(),
                                       org_id=uuid.uuid4(), auth=SimpleNamespace(user_id=str(uuid.uuid4())))
    assert ei1.value.status_code == 403 and ei2.value.status_code == 403
    holdfn.assert_not_awaited()
    unholdfn.assert_not_awaited()


@pytest.mark.anyio
async def test_hold_endpoint_forces_holder_from_auth():
    """⭐holder=인증 caller 강제(body엔 holder 필드 부재·spoof 0·S23 RC①)."""
    from types import SimpleNamespace
    from unittest.mock import AsyncMock, patch
    from app.routers import gates as gates_mod
    from app.routers.gates import GateHoldRequest, hold_gate_endpoint
    caller = _resolved_human()
    holdfn = AsyncMock(return_value=SimpleNamespace())
    with patch.object(gates_mod, "resolve_member", AsyncMock(return_value=caller)), \
         patch.object(gates_mod, "is_org_owner_or_admin", AsyncMock(return_value=True)), \
         patch.object(gates_mod, "hold_gate", holdfn), \
         patch.object(gates_mod.GateResponse, "model_validate", lambda g: "OK"):
        await hold_gate_endpoint(id=uuid.uuid4(), body=GateHoldRequest(reason="대기"), session=AsyncMock(),
                                 org_id=uuid.uuid4(), auth=SimpleNamespace(user_id=str(uuid.uuid4())))
    # hold_gate(session, org_id, gate_id, holder_id, reason, held_until) — holder=caller.id
    assert holdfn.call_args.args[3] == caller.id
