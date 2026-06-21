"""E-DG S30: admin cancel/void recovery — 잘못 생성된 pending gate 무효화.

핵심: ①pending→voided 전이(Phase-1·resolved→void 금지) ②void≠approval(묶인 step_run skipped 해소→
entity unblock·전이 미적용·re-route 가능) ③voider=인증 caller·사유 필수·audit(gate.status=voided distinct)
④admin-only. 마이그0(gate.status free-string).
"""
from __future__ import annotations

import os
import uuid

import pytest

from app.models.gate import GATE_STATUSES, is_valid_transition

_REAL_DB_URL = os.getenv("PARITY_TEST_DATABASE_URL") or os.getenv("ALEMBIC_DATABASE_URL")


@pytest.fixture
def anyio_backend():
    return "asyncio"


# ── FSM(unit·CI-runnable) ─────────────────────────────────────────────────────
def test_void_fsm():
    assert "voided" in GATE_STATUSES
    assert is_valid_transition("pending", "voided") is True
    assert is_valid_transition("approved", "voided") is False   # resolved→void 금지(Phase-1)
    assert is_valid_transition("rejected", "voided") is False
    assert is_valid_transition("voided", "approved") is False   # voided 종착


async def _session():
    from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine
    from app.core.database import Base
    import app.models  # noqa: F401
    import app.models.participation  # noqa: F401  (org_gate_override FK→participation_role)
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


async def _seed_gate(s, org, *, status="pending", with_step_run=True):
    from app.models.gate import Gate
    from app.models.workflow_line import WorkflowLineStepRun
    proj = uuid.uuid4()
    wi = uuid.uuid4()
    gate = Gate(id=uuid.uuid4(), org_id=org, work_item_id=wi, work_item_type="story",
                gate_type="merge", status=status)
    s.add(gate)
    await s.flush()
    sr = None
    if with_step_run:
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
async def test_void_pending_gate_resolves_step_run_no_advance():
    """⭐void: gate=voided + 묶인 step_run=skipped(해소·entity unblock)·전이 미적용(applied 아님)."""
    from app.services.gate_service import void_gate
    from app.models.workflow_line import WorkflowLineStepRun
    from sqlalchemy import select
    engine, Session = await _session()
    async with Session() as s:
        org = uuid.uuid4()
        voider = uuid.uuid4()
        gate, sr = await _seed_gate(s, org)
        await s.commit()
        result = await void_gate(s, org, gate.id, voider, "오발행 gate")
        await s.commit()
        assert result.status == "voided"
        assert result.resolver_id == voider
        assert result.resolution_note == "오발행 gate"
        # step_run skipped 로 해소(applied 아님=entity 미전진·re-route 가능)
        sr2 = (await s.execute(
            select(WorkflowLineStepRun).where(WorkflowLineStepRun.id == sr.id)
        )).scalar_one()
        assert sr2.status == "skipped"
        assert "voided by admin" in (sr2.routing_reason or "")
    await engine.dispose()


@pytest.mark.skipif(not _REAL_DB_URL, reason="real Postgres 필요")
@pytest.mark.anyio
async def test_void_non_pending_rejected():
    """resolved(approved) gate 는 void 불가(Phase-1·pending만)."""
    from app.services.gate_service import void_gate
    engine, Session = await _session()
    async with Session() as s:
        org = uuid.uuid4()
        gate, _ = await _seed_gate(s, org, status="approved", with_step_run=False)
        await s.commit()
        with pytest.raises(ValueError, match="pending"):
            await void_gate(s, org, gate.id, uuid.uuid4(), "x")
    await engine.dispose()


@pytest.mark.skipif(not _REAL_DB_URL, reason="real Postgres 필요")
@pytest.mark.anyio
async def test_void_empty_reason_rejected():
    """사유 필수(audit·파괴적 액션)."""
    from app.services.gate_service import void_gate
    engine, Session = await _session()
    async with Session() as s:
        org = uuid.uuid4()
        gate, _ = await _seed_gate(s, org, with_step_run=False)
        await s.commit()
        with pytest.raises(ValueError, match="사유"):
            await void_gate(s, org, gate.id, uuid.uuid4(), "   ")
    await engine.dispose()


@pytest.mark.skipif(not _REAL_DB_URL, reason="real Postgres 필요")
@pytest.mark.anyio
async def test_void_no_step_run_ok():
    """step_run 없는 gate(legacy/비-라인)도 void 정상(no-op recovery)."""
    from app.services.gate_service import void_gate
    engine, Session = await _session()
    async with Session() as s:
        org = uuid.uuid4()
        gate, _ = await _seed_gate(s, org, with_step_run=False)
        await s.commit()
        result = await void_gate(s, org, gate.id, uuid.uuid4(), "막힌 라인 복구")
        await s.commit()
        assert result.status == "voided"
    await engine.dispose()


# ── 엔드포인트 auth 회귀(CI-runnable·파괴적 admin 액션 가드·S28 IDOR 교훈·까심 nit) ──────────
def _resolved_human():
    from app.services.member_resolver import ResolvedMember
    return ResolvedMember(id=uuid.uuid4(), user_id=uuid.uuid4(), name="a", type="human",
                          role="admin", org_id=uuid.uuid4())


@pytest.mark.anyio
async def test_void_endpoint_non_admin_403():
    """비-admin → 403(void_gate 호출 前 차단·상태 변경 0)."""
    from types import SimpleNamespace
    from unittest.mock import AsyncMock, patch
    from fastapi import HTTPException
    from app.routers import gates as gates_mod
    from app.routers.gates import GateVoidRequest, void_gate_endpoint
    voidfn = AsyncMock()
    with patch.object(gates_mod, "resolve_member", AsyncMock(return_value=_resolved_human())), \
         patch.object(gates_mod, "is_org_owner_or_admin", AsyncMock(return_value=False)), \
         patch.object(gates_mod, "void_gate", voidfn):
        with pytest.raises(HTTPException) as ei:
            await void_gate_endpoint(
                id=uuid.uuid4(), body=GateVoidRequest(reason="x"), session=AsyncMock(),
                org_id=uuid.uuid4(), auth=SimpleNamespace(user_id=str(uuid.uuid4())))
    assert ei.value.status_code == 403
    voidfn.assert_not_awaited()


@pytest.mark.anyio
async def test_void_endpoint_forces_voider_from_auth():
    """⭐voider=인증 caller(resolve_member.id) 강제 — body엔 voider 필드 부재라 spoof 벡터 0(S23 RC①)."""
    from types import SimpleNamespace
    from unittest.mock import AsyncMock, patch
    from app.routers import gates as gates_mod
    from app.routers.gates import GateVoidRequest, void_gate_endpoint
    caller = _resolved_human()
    voidfn = AsyncMock(return_value=SimpleNamespace())
    with patch.object(gates_mod, "resolve_member", AsyncMock(return_value=caller)), \
         patch.object(gates_mod, "is_org_owner_or_admin", AsyncMock(return_value=True)), \
         patch.object(gates_mod, "void_gate", voidfn), \
         patch.object(gates_mod.GateResponse, "model_validate", lambda g: "OK"):
        await void_gate_endpoint(
            id=uuid.uuid4(), body=GateVoidRequest(reason="오발행"), session=AsyncMock(),
            org_id=uuid.uuid4(), auth=SimpleNamespace(user_id=str(uuid.uuid4())))
    # void_gate(session, org_id, gate_id, voider_id, reason) — 위치인자 voider=caller.id·reason 전달.
    assert voidfn.call_args.args[3] == caller.id
    assert voidfn.call_args.args[4] == "오발행"
