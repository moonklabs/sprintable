"""E-DG S9: parallel/quorum approval MVP 테스트.

핵심: 대표 Gate 1개 + approver row N개(orphan 0)·quorum all/any/count·any_reject_blocks·
consult/non-blocking quorum 제외·SoD self-approval guard(생성 시 + 해소 시)·transition_gate 단일 rail.
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
    import app.models.workflow_line  # noqa: F401
    import app.models.participation  # noqa: F401 — gate_resolver FK(participation_role) 등록
    import app.models.gate  # noqa: F401
    import app.models.hitl_config  # noqa: F401
    url = _REAL_DB_URL
    for prefix in ("postgresql+psycopg2://", "postgresql+asyncpg://", "postgresql://"):
        if url.startswith(prefix):
            url = "postgresql+asyncpg://" + url[len(prefix):]
            break
    engine = create_async_engine(url)
    async with engine.begin() as conn:
        await conn.run_sync(Base.metadata.create_all)
    return engine, async_sessionmaker(engine, expire_on_commit=False)


async def _seed_step_run(s, org):
    from app.models.project import Project
    from app.models.workflow_line import WorkflowLineStepRun
    proj = uuid.uuid4()
    s.add(Project(id=proj, org_id=org, name="p"))
    sr = WorkflowLineStepRun(
        org_id=org, project_id=proj, entity_type="story", entity_id=uuid.uuid4(),
        from_status="in-review", to_status="done", status="gate_pending", mode="gate_pending",
        correlation_id=uuid.uuid4(), transition_id=uuid.uuid4().hex)
    s.add(sr)
    await s.flush()
    return sr


def _approver(member_id=None, kind="approver", blocking=None, **kw):
    return {"member_id": member_id or uuid.uuid4(), "member_type": "human", "kind": kind,
            **({"blocking": blocking} if blocking is not None else {}), **kw}


# ── 생성: orphan 0 ──────────────────────────────────────────────────────────
@pytest.mark.skipif(not _REAL_DB_URL, reason="real Postgres 필요")
@pytest.mark.anyio
async def test_create_parallel_gate_single_gate_n_rows_orphan_zero():
    from app.services.workflow_parallel_approval import create_parallel_gate
    from app.models.workflow_line import WorkflowLineStepApproval
    from sqlalchemy import select
    engine, Session = await _session()
    async with Session() as s:
        org = uuid.uuid4()
        sr = await _seed_step_run(s, org)
        a1, a2 = _approver(), _approver()
        gate, group = await create_parallel_gate(
            s, sr, approvers=[a1, a2], quorum={"type": "all"},
            member_id=uuid.uuid4(), role_id=uuid.uuid4())
        assert gate.status == "pending"  # 대표 Gate 1개·pending
        rows = (await s.execute(select(WorkflowLineStepApproval).where(
            WorkflowLineStepApproval.approval_group_id == group))).scalars().all()
        assert len(rows) == 2
        # ⭐orphan 0: 전 row 가 대표 Gate 와 step_run 에 정합·step_run.gate_id 연결
        assert all(r.gate_id == gate.id and r.step_run_id == sr.id for r in rows)
        assert sr.gate_id == gate.id and sr.approval_group_id == group
    await engine.dispose()


# ── quorum all/any/count ────────────────────────────────────────────────────
@pytest.mark.skipif(not _REAL_DB_URL, reason="real Postgres 필요")
@pytest.mark.anyio
async def test_quorum_all_requires_every_blocking_approval():
    from app.services.workflow_parallel_approval import create_parallel_gate, record_parallel_decision
    from app.models.gate import Gate
    from sqlalchemy import select
    from app.models.workflow_line import WorkflowLineStepApproval
    engine, Session = await _session()
    async with Session() as s:
        org = uuid.uuid4()
        sr = await _seed_step_run(s, org)
        a1, a2 = _approver(), _approver()
        gate, group = await create_parallel_gate(
            s, sr, approvers=[a1, a2], quorum={"type": "all"},
            member_id=uuid.uuid4(), role_id=uuid.uuid4())
        ids = {r.approver_member_id: r.id for r in (await s.execute(select(WorkflowLineStepApproval).where(
            WorkflowLineStepApproval.approval_group_id == group))).scalars().all()}
        # 1명만 approve → 아직 pending
        r1 = await record_parallel_decision(s, ids[a1["member_id"]], "approved", a1["member_id"])
        assert r1["outcome"] == "pending"
        g = (await s.execute(select(Gate).where(Gate.id == gate.id))).scalar_one()
        assert g.status == "pending"
        # 나머지 approve → quorum all 충족 → approved
        r2 = await record_parallel_decision(s, ids[a2["member_id"]], "approved", a2["member_id"])
        assert r2["outcome"] == "approved" and r2["approved"] == 2
        g = (await s.execute(select(Gate).where(Gate.id == gate.id))).scalar_one()
        assert g.status == "approved"
    await engine.dispose()


@pytest.mark.skipif(not _REAL_DB_URL, reason="real Postgres 필요")
@pytest.mark.anyio
async def test_quorum_any_one_approval_suffices():
    from app.services.workflow_parallel_approval import create_parallel_gate, record_parallel_decision
    from app.models.gate import Gate
    from sqlalchemy import select
    from app.models.workflow_line import WorkflowLineStepApproval
    engine, Session = await _session()
    async with Session() as s:
        org = uuid.uuid4()
        sr = await _seed_step_run(s, org)
        a1, a2 = _approver(), _approver()
        gate, group = await create_parallel_gate(
            s, sr, approvers=[a1, a2], quorum={"type": "any"},
            member_id=uuid.uuid4(), role_id=uuid.uuid4())
        rid = (await s.execute(select(WorkflowLineStepApproval.id).where(
            WorkflowLineStepApproval.approver_member_id == a1["member_id"]))).scalar_one()
        r = await record_parallel_decision(s, rid, "approved", a1["member_id"])
        assert r["outcome"] == "approved"
        g = (await s.execute(select(Gate).where(Gate.id == gate.id))).scalar_one()
        assert g.status == "approved"
    await engine.dispose()


@pytest.mark.skipif(not _REAL_DB_URL, reason="real Postgres 필요")
@pytest.mark.anyio
async def test_quorum_count_threshold():
    from app.services.workflow_parallel_approval import create_parallel_gate, record_parallel_decision
    from app.models.gate import Gate
    from sqlalchemy import select
    from app.models.workflow_line import WorkflowLineStepApproval
    engine, Session = await _session()
    async with Session() as s:
        org = uuid.uuid4()
        sr = await _seed_step_run(s, org)
        a1, a2, a3 = _approver(), _approver(), _approver()
        gate, group = await create_parallel_gate(
            s, sr, approvers=[a1, a2, a3], quorum={"type": "count", "count": 2},
            member_id=uuid.uuid4(), role_id=uuid.uuid4())
        ids = {r.approver_member_id: r.id for r in (await s.execute(select(WorkflowLineStepApproval).where(
            WorkflowLineStepApproval.approval_group_id == group))).scalars().all()}
        assert (await record_parallel_decision(s, ids[a1["member_id"]], "approved", a1["member_id"]))["outcome"] == "pending"
        r = await record_parallel_decision(s, ids[a2["member_id"]], "approved", a2["member_id"])
        assert r["outcome"] == "approved" and r["approved"] == 2  # count=2 도달
        g = (await s.execute(select(Gate).where(Gate.id == gate.id))).scalar_one()
        assert g.status == "approved"
    await engine.dispose()


# ── terminal 멱등: late decision skip(row 불변) ─────────────────────────────
@pytest.mark.skipif(not _REAL_DB_URL, reason="real Postgres 필요")
@pytest.mark.anyio
async def test_late_decision_after_terminal_skipped_row_unchanged():
    from app.services.workflow_parallel_approval import create_parallel_gate, record_parallel_decision
    from app.models.gate import Gate
    from sqlalchemy import select
    from app.models.workflow_line import WorkflowLineStepApproval
    engine, Session = await _session()
    async with Session() as s:
        org = uuid.uuid4()
        sr = await _seed_step_run(s, org)
        a1, a2 = _approver(), _approver()
        gate, group = await create_parallel_gate(
            s, sr, approvers=[a1, a2], quorum={"type": "any"},
            member_id=uuid.uuid4(), role_id=uuid.uuid4())
        ids = {r.approver_member_id: r.id for r in (await s.execute(select(WorkflowLineStepApproval).where(
            WorkflowLineStepApproval.approval_group_id == group))).scalars().all()}
        # a1 approve → quorum any 충족 → gate approved
        assert (await record_parallel_decision(s, ids[a1["member_id"]], "approved", a1["member_id"]))["outcome"] == "approved"
        # ⭐a2 의 late reject → gate terminal 이라 skip·row 불변(rejected 로 안 바뀜)·gate 유지
        late = await record_parallel_decision(s, ids[a2["member_id"]], "rejected", a2["member_id"])
        assert late["skipped"] is True and late["outcome"] == "approved"
        a2_row = (await s.execute(select(WorkflowLineStepApproval).where(
            WorkflowLineStepApproval.id == ids[a2["member_id"]]))).scalar_one()
        assert a2_row.status == "pending" and a2_row.resolved_at is None  # mutate 안 됨
        g = (await s.execute(select(Gate).where(Gate.id == gate.id))).scalar_one()
        assert g.status == "approved"  # 그대로
    await engine.dispose()


# ── any_reject_blocks ───────────────────────────────────────────────────────
@pytest.mark.skipif(not _REAL_DB_URL, reason="real Postgres 필요")
@pytest.mark.anyio
async def test_any_reject_blocks_rejects_gate():
    from app.services.workflow_parallel_approval import create_parallel_gate, record_parallel_decision
    from app.models.gate import Gate
    from sqlalchemy import select
    from app.models.workflow_line import WorkflowLineStepApproval
    engine, Session = await _session()
    async with Session() as s:
        org = uuid.uuid4()
        sr = await _seed_step_run(s, org)
        a1, a2 = _approver(), _approver()
        gate, group = await create_parallel_gate(
            s, sr, approvers=[a1, a2], quorum={"type": "all"},
            member_id=uuid.uuid4(), role_id=uuid.uuid4())
        rid = (await s.execute(select(WorkflowLineStepApproval.id).where(
            WorkflowLineStepApproval.approver_member_id == a1["member_id"]))).scalar_one()
        # 1명 reject → any_reject_blocks → 즉시 rejected(나머지 대기 안 함)
        r = await record_parallel_decision(s, rid, "rejected", a1["member_id"])
        assert r["outcome"] == "rejected" and r["rejected"] == 1
        g = (await s.execute(select(Gate).where(Gate.id == gate.id))).scalar_one()
        assert g.status == "rejected"
    await engine.dispose()


# ── consult/non-blocking quorum 제외 ────────────────────────────────────────
@pytest.mark.skipif(not _REAL_DB_URL, reason="real Postgres 필요")
@pytest.mark.anyio
async def test_consult_excluded_from_quorum():
    from app.services.workflow_parallel_approval import create_parallel_gate, record_parallel_decision
    from app.models.gate import Gate
    from sqlalchemy import select
    from app.models.workflow_line import WorkflowLineStepApproval
    engine, Session = await _session()
    async with Session() as s:
        org = uuid.uuid4()
        sr = await _seed_step_run(s, org)
        a_block = _approver(kind="approver")
        a_consult = _approver(kind="consult")  # non-blocking·quorum 제외
        gate, group = await create_parallel_gate(
            s, sr, approvers=[a_block, a_consult], quorum={"type": "all"},
            member_id=uuid.uuid4(), role_id=uuid.uuid4())
        rid = (await s.execute(select(WorkflowLineStepApproval.id).where(
            WorkflowLineStepApproval.approver_member_id == a_block["member_id"]))).scalar_one()
        # blocking approver 1명만 approve → consult 무관하게 quorum all 충족(blocking 총 1)
        r = await record_parallel_decision(s, rid, "approved", a_block["member_id"])
        assert r["outcome"] == "approved" and r["total_blocking"] == 1  # consult 미집계
        g = (await s.execute(select(Gate).where(Gate.id == gate.id))).scalar_one()
        assert g.status == "approved"
        # consult row 는 여전히 pending(audit 에 남음)
        consult = (await s.execute(select(WorkflowLineStepApproval).where(
            WorkflowLineStepApproval.approver_member_id == a_consult["member_id"]))).scalar_one()
        assert consult.status == "pending" and consult.kind == "consult"
    await engine.dispose()


# ── SoD self-approval guard ─────────────────────────────────────────────────
@pytest.mark.skipif(not _REAL_DB_URL, reason="real Postgres 필요")
@pytest.mark.anyio
async def test_sod_guard_at_creation_blocks_self_approver():
    from app.services.workflow_parallel_approval import create_parallel_gate, SelfApprovalError
    engine, Session = await _session()
    async with Session() as s:
        org = uuid.uuid4()
        sr = await _seed_step_run(s, org)
        requester = uuid.uuid4()
        # blocking approver == requested_by → SoD 위반(생성 시 거부)
        with pytest.raises(SelfApprovalError):
            await create_parallel_gate(
                s, sr, approvers=[_approver(member_id=requester)], quorum={"type": "all"},
                member_id=uuid.uuid4(), role_id=uuid.uuid4(), requested_by_member_id=requester)
    await engine.dispose()


@pytest.mark.skipif(not _REAL_DB_URL, reason="real Postgres 필요")
@pytest.mark.anyio
async def test_sod_guard_at_resolution_and_foreign_resolver():
    from app.services.workflow_parallel_approval import record_parallel_decision, SelfApprovalError
    from app.models.workflow_line import WorkflowLineStepApproval
    engine, Session = await _session()
    async with Session() as s:
        org = uuid.uuid4()
        sr = await _seed_step_run(s, org)
        requester = uuid.uuid4()
        # 직접 삽입: approver==requested_by 인 row(생성 가드 우회·해소 가드 검증용)
        appr = WorkflowLineStepApproval(
            org_id=org, project_id=sr.project_id, step_run_id=sr.id, gate_id=uuid.uuid4(),
            approval_group_id=uuid.uuid4(), approver_member_id=requester, approver_member_type="human",
            requested_by_member_id=requester, kind="approver", blocking=True, status="pending")
        s.add(appr)
        await s.flush()
        # ⭐해소 시 SoD: resolver(=approver=requester) == requested_by → 거부
        with pytest.raises(SelfApprovalError):
            await record_parallel_decision(s, appr.id, "approved", requester)
        # 남의 row 해소 시도(resolver != approver) → 거부
        appr2 = WorkflowLineStepApproval(
            org_id=org, project_id=sr.project_id, step_run_id=sr.id, gate_id=uuid.uuid4(),
            approval_group_id=uuid.uuid4(), approver_member_id=uuid.uuid4(), approver_member_type="human",
            kind="approver", blocking=True, status="pending")
        s.add(appr2)
        await s.flush()
        with pytest.raises(SelfApprovalError):
            await record_parallel_decision(s, appr2.id, "approved", uuid.uuid4())
    await engine.dispose()
