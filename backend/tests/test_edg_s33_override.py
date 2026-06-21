"""E-DG S33: owner explicit override / force-resolve.

핵심: ①owner 가 pending gate 를 강제 결정(approved|rejected·정상 quorum/SoD 우회) ②parallel approver row
→ status="overridden"(distinct·dangling 방지) ③audit=gate_overridden 이벤트(bypassed_sod=True)+neutral_facts
마커 ④reason 필수·decision 검증·non-pending 거부 ⑤owner-only(엔드포인트)·owner_id=인증 caller 강제.

entity_type="task"(non-gating-eligible)로 시드해 라인-advance(story 전용)는 graceful no-op·override 로직만 격리.
"""
from __future__ import annotations

import os
import uuid

import pytest

_REAL_DB_URL = os.getenv("PARITY_TEST_DATABASE_URL") or os.getenv("ALEMBIC_DATABASE_URL")


@pytest.fixture
def anyio_backend():
    return "asyncio"


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


async def _seed_gate(s, org, *, n_approvers=1, status="pending"):
    from app.models.gate import Gate
    from app.models.project import Project
    from app.models.workflow_line import WorkflowLineStepApproval, WorkflowLineStepRun
    proj = uuid.uuid4()
    s.add(Project(id=proj, org_id=org, name="p"))
    await s.flush()
    wi = uuid.uuid4()
    gate = Gate(id=uuid.uuid4(), org_id=org, work_item_id=wi, work_item_type="task",
                gate_type="merge", status=status)
    s.add(gate)
    await s.flush()
    sr = None
    approvers = []
    if n_approvers > 0:
        sr = WorkflowLineStepRun(
            org_id=org, project_id=proj, entity_type="task", entity_id=wi,
            from_status="in-review", to_status="done", status="gate_pending", mode="gate_pending",
            gate_id=gate.id, correlation_id=uuid.uuid4(), transition_id=uuid.uuid4().hex)
        s.add(sr)
        await s.flush()
        grp = uuid.uuid4()
        for _ in range(n_approvers):
            aid = uuid.uuid4()
            appr = WorkflowLineStepApproval(
                org_id=org, project_id=proj, step_run_id=sr.id, gate_id=gate.id, approval_group_id=grp,
                approver_member_id=aid, approver_member_type="human", kind="approver", blocking=True,
                status="pending", requested_by_member_id=uuid.uuid4())
            s.add(appr)
            approvers.append(aid)
        await s.flush()
    return gate, proj, approvers


@pytest.mark.skipif(not _REAL_DB_URL, reason="real Postgres 필요")
@pytest.mark.anyio
async def test_override_approved_parallel_closes_approvers_and_audits():
    """⭐override(approved): gate.status=approved·approver row overridden·gate_overridden 이벤트
    (bypassed_sod=True)·neutral_facts 마커."""
    from app.services.gate_service import override_gate
    from app.models.workflow_line import WorkflowLineStepApproval, WorkflowLineStepRunEvent
    from sqlalchemy import select
    engine, Session = await _session()
    async with Session() as s:
        org = uuid.uuid4()
        gate, proj, approvers = await _seed_gate(s, org, n_approvers=2)
        owner = uuid.uuid4()
        await s.commit()
        result = await override_gate(s, org, gate.id, owner, "approved", "긴급 배포·결재자 부재")
        await s.commit()
        assert result.status == "approved"
        assert result.neutral_facts["overridden"] is True
        assert result.neutral_facts["override_decision"] == "approved"
        assert result.neutral_facts["overridden_by_member_id"] == str(owner)
        rows = (await s.execute(select(WorkflowLineStepApproval).where(
            WorkflowLineStepApproval.gate_id == gate.id))).scalars().all()
        assert all(r.status == "overridden" for r in rows)   # 강제 닫힘(승인 아님)
        ev = (await s.execute(select(WorkflowLineStepRunEvent).where(
            WorkflowLineStepRunEvent.event_type == "gate_overridden"))).scalars().all()
        assert len(ev) == 1
        assert ev[0].actor_member_id == owner
        assert ev[0].payload["bypassed_sod"] is True
        assert ev[0].payload["decision"] == "approved"
        assert len(ev[0].payload["bypassed_approver_ids"]) == 2
    await engine.dispose()


@pytest.mark.skipif(not _REAL_DB_URL, reason="real Postgres 필요")
@pytest.mark.anyio
async def test_override_rejected():
    """override(rejected): gate.status=rejected·force reject."""
    from app.services.gate_service import override_gate
    engine, Session = await _session()
    async with Session() as s:
        org = uuid.uuid4()
        gate, _, _ = await _seed_gate(s, org, n_approvers=1)
        await s.commit()
        result = await override_gate(s, org, gate.id, uuid.uuid4(), "rejected", "정책 위반·강제 반려")
        await s.commit()
        assert result.status == "rejected"
        assert result.neutral_facts["override_decision"] == "rejected"
    await engine.dispose()


@pytest.mark.skipif(not _REAL_DB_URL, reason="real Postgres 필요")
@pytest.mark.anyio
async def test_override_single_gate_no_approvers():
    """단일 gate(approver row 없음)도 override 가능(force-resolve)·닫을 approver 0."""
    from app.services.gate_service import override_gate
    engine, Session = await _session()
    async with Session() as s:
        org = uuid.uuid4()
        gate, _, _ = await _seed_gate(s, org, n_approvers=0)
        await s.commit()
        result = await override_gate(s, org, gate.id, uuid.uuid4(), "approved", "단일 gate 강제 통과")
        await s.commit()
        assert result.status == "approved"
        assert result.neutral_facts["overridden"] is True
    await engine.dispose()


@pytest.mark.skipif(not _REAL_DB_URL, reason="real Postgres 필요")
@pytest.mark.anyio
async def test_override_invalid_decision_and_reason():
    """decision은 approved|rejected만·reason 필수·non-pending 거부."""
    from app.services.gate_service import override_gate
    engine, Session = await _session()
    async with Session() as s:
        org = uuid.uuid4()
        gate, _, _ = await _seed_gate(s, org, n_approvers=1)
        await s.commit()
        with pytest.raises(ValueError, match="approved|rejected"):
            await override_gate(s, org, gate.id, uuid.uuid4(), "voided", "x")
        with pytest.raises(ValueError, match="reason"):
            await override_gate(s, org, gate.id, uuid.uuid4(), "approved", "  ")
        # non-pending: 먼저 approve 후 재-override 시도
        await override_gate(s, org, gate.id, uuid.uuid4(), "approved", "first")
        await s.commit()
        with pytest.raises(ValueError, match="pending"):
            await override_gate(s, org, gate.id, uuid.uuid4(), "approved", "again")
    await engine.dispose()


# ── 엔드포인트 owner-only(CI-runnable) ────────────────────────────────────────
def _resolved_owner():
    from app.services.member_resolver import ResolvedMember
    return ResolvedMember(id=uuid.uuid4(), user_id=uuid.uuid4(), name="o", type="human",
                          role="owner", org_id=uuid.uuid4())


@pytest.mark.anyio
async def test_override_endpoint_non_owner_403():
    """admin이어도 owner 아니면 403(override는 owner-only·admin보다 좁음)."""
    from types import SimpleNamespace
    from unittest.mock import AsyncMock, patch
    from fastapi import HTTPException
    from app.routers import gates as gates_mod
    from app.routers.gates import GateOverrideRequest, override_gate_endpoint
    with patch.object(gates_mod, "resolve_member", AsyncMock(return_value=_resolved_owner())), \
         patch.object(gates_mod, "is_org_owner", AsyncMock(return_value=False)):  # admin이지만 owner 아님
        with pytest.raises(HTTPException) as ei:
            await override_gate_endpoint(
                id=uuid.uuid4(), body=GateOverrideRequest(decision="approved", reason="x"),
                session=AsyncMock(), org_id=uuid.uuid4(),
                auth=SimpleNamespace(user_id=str(uuid.uuid4())))
    assert ei.value.status_code == 403
