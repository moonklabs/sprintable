"""E-DG S17: recall/withdraw pending gate 테스트.

핵심: requester/privileged withdraw→status='withdrawn'+approval withdrawn+event·forbidden(타인)·
idempotent(terminal→not_active)·not_found·entity 미전이·Gate enum 미확장.
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
    url = _REAL_DB_URL
    for prefix in ("postgresql+psycopg2://", "postgresql+asyncpg://", "postgresql://"):
        if url.startswith(prefix):
            url = "postgresql+asyncpg://" + url[len(prefix):]
            break
    engine = create_async_engine(url)
    async with engine.begin() as conn:
        await conn.run_sync(Base.metadata.create_all)
    return engine, async_sessionmaker(engine, expire_on_commit=False)


async def _member(s, org, *, role="member"):
    from app.models.project import Project
    from app.models.team import TeamMember
    mid, proj = uuid.uuid4(), uuid.uuid4()
    s.add(Project(id=proj, org_id=org, name="p"))
    await s.flush()
    s.add(TeamMember(id=mid, org_id=org, project_id=proj, type="human", name="m", role=role))
    await s.flush()
    return mid


async def _run(s, org, *, status="gate_pending", group=None, requested_by=None):
    from app.models.workflow_line import WorkflowLineStepRun, WorkflowLineStepApproval
    sr = WorkflowLineStepRun(
        org_id=org, project_id=uuid.uuid4(), entity_type="story", entity_id=uuid.uuid4(),
        from_status="in-review", to_status="done", status=status, mode="gate_pending",
        approval_group_id=group, correlation_id=uuid.uuid4(), transition_id=uuid.uuid4().hex)
    s.add(sr)
    await s.flush()
    if group is not None:
        s.add(WorkflowLineStepApproval(
            org_id=org, project_id=sr.project_id, step_run_id=sr.id, approval_group_id=group,
            approver_member_id=uuid.uuid4(), approver_member_type="human",
            requested_by_member_id=requested_by, kind="approver", blocking=True, status="pending"))
        await s.flush()
    return sr


@pytest.mark.skipif(not _REAL_DB_URL, reason="real Postgres 필요")
@pytest.mark.anyio
async def test_requester_withdraws_and_closes_approvals():
    from app.services.workflow_recall import withdraw_pending_run
    from app.models.workflow_line import WorkflowLineStepRun, WorkflowLineStepApproval, WorkflowLineStepRunEvent
    from sqlalchemy import select
    engine, Session = await _session()
    async with Session() as s:
        org = uuid.uuid4()
        author = await _member(s, org)
        group = uuid.uuid4()
        sr = await _run(s, org, group=group, requested_by=author)
        await s.commit()
        r = await withdraw_pending_run(s, org, sr.entity_id, sr.id, author, reason="mistake")
        assert r["status"] == "withdrawn"
        row = (await s.execute(select(WorkflowLineStepRun).where(WorkflowLineStepRun.id == sr.id))).scalar_one()
        assert row.status == "withdrawn" and row.withdrawn_by_member_id == author
        assert row.withdraw_reason == "mistake" and row.from_status == "in-review"  # ③ 미전이
        appr = (await s.execute(select(WorkflowLineStepApproval).where(
            WorkflowLineStepApproval.approval_group_id == group))).scalars().all()
        assert all(a.status == "withdrawn" for a in appr)  # gate 해소(approval withdrawn)
        evs = (await s.execute(select(WorkflowLineStepRunEvent).where(
            WorkflowLineStepRunEvent.step_run_id == sr.id,
            WorkflowLineStepRunEvent.event_type == "withdrawn"))).scalars().all()
        assert len(evs) == 1  # ⑥ event
    await engine.dispose()


@pytest.mark.skipif(not _REAL_DB_URL, reason="real Postgres 필요")
@pytest.mark.anyio
async def test_admin_can_withdraw_and_stranger_forbidden():
    from app.services.workflow_recall import withdraw_pending_run
    engine, Session = await _session()
    async with Session() as s:
        org = uuid.uuid4()
        admin = await _member(s, org, role="admin")
        stranger = await _member(s, org, role="member")
        sr1 = await _run(s, org)   # approval 없음(requester 불명)
        sr2 = await _run(s, org)
        await s.commit()
        # ④ admin → 허용
        assert (await withdraw_pending_run(s, org, sr1.entity_id, sr1.id, admin))["status"] == "withdrawn"
        # ④ 타인(non-requester·non-privileged) → forbidden
        assert (await withdraw_pending_run(s, org, sr2.entity_id, sr2.id, stranger))["status"] == "forbidden"
    await engine.dispose()


@pytest.mark.skipif(not _REAL_DB_URL, reason="real Postgres 필요")
@pytest.mark.anyio
async def test_idempotent_not_active_and_not_found():
    from app.services.workflow_recall import withdraw_pending_run
    engine, Session = await _session()
    async with Session() as s:
        org = uuid.uuid4()
        admin = await _member(s, org, role="admin")
        sr = await _run(s, org)
        await s.commit()
        assert (await withdraw_pending_run(s, org, sr.entity_id, sr.id, admin))["status"] == "withdrawn"
        # ⑤ 재시도 → not_active(이미 withdrawn)
        r2 = await withdraw_pending_run(s, org, sr.entity_id, sr.id, admin)
        assert r2["status"] == "not_active" and r2["run_status"] == "withdrawn"
        # 없는 run → not_found
        assert (await withdraw_pending_run(s, org, sr.entity_id, uuid.uuid4(), admin))["status"] == "not_found"
        # active pending 아닌 run(applied) → not_active
        applied = await _run(s, org, status="applied")
        await s.flush()
        assert (await withdraw_pending_run(s, org, applied.entity_id, applied.id, admin))["status"] == "not_active"
    await engine.dispose()
