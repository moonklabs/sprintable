"""story #3965 — 「오늘」 needs_me workflow_step 소스(today_service.py::_needs_me_from_workflow_steps)가
이미 노출 중인 actions=["approve","request_changes","hold"] 가운데 approve/request_changes(reject)를
실제로 처리하는 첫 HTTP 엔드포인트: POST /gates/{id}/approvers/{approval_id}/decision.

story #3334가 미리 심어둔 record_parallel_decision(app/services/workflow_parallel_approval.py)을
처음 배선한다 — 그 함수 자체의 quorum/SoD 로직은 test_edg_s9_parallel_quorum.py가 이미 고정,
이 파일은 라우트 계층(org/gate 스코프 404·SelfApprovalError→403·pydantic note-required 검증·
정상경로 e2e)만 새로 검증한다."""
from __future__ import annotations

import os
import uuid

import pytest

_REAL_DB_URL = os.getenv("PARITY_TEST_DATABASE_URL") or os.getenv("ALEMBIC_DATABASE_URL")

# story 8236bbc3 관례 — create_all(+drop_all)로 자체 스키마를 직접 다뤄 공유 alembic-migrated
# DB 오염을 방지(격리 DB 전용, conftest.py 가드가 마커 누락을 자동 검출).
pytestmark = pytest.mark.destructive_schema


@pytest.fixture
def anyio_backend():
    return "asyncio"


async def _session():
    from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine
    from app.core.database import Base
    import app.models  # noqa: F401
    import app.models.activity_log  # noqa: F401 — transition_gate()가 ActivityLog를 씀.
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


async def _seed_parallel_gate(
    s, org, *, n_approvers=1, quorum_type="all", quorum_count=None,
    requested_by=None,
):
    from app.models.gate import Gate
    from app.models.project import Project
    from app.models.workflow_line import WorkflowLineStepApproval, WorkflowLineStepRun
    proj = uuid.uuid4()
    s.add(Project(id=proj, org_id=org, name="p"))
    await s.flush()
    wi = uuid.uuid4()
    gate = Gate(id=uuid.uuid4(), org_id=org, work_item_id=wi, work_item_type="story",
                gate_type="merge", status="pending")
    s.add(gate)
    await s.flush()
    sr = WorkflowLineStepRun(
        org_id=org, project_id=proj, entity_type="story", entity_id=wi,
        from_status="in-review", to_status="done", status="gate_pending", mode="gate_pending",
        gate_id=gate.id, correlation_id=uuid.uuid4(), transition_id=uuid.uuid4().hex,
        quorum_policy={"type": quorum_type, "count": quorum_count, "reject_policy": "any_reject_blocks"},
    )
    s.add(sr)
    await s.flush()
    approvers = []
    grp = uuid.uuid4()
    for _ in range(n_approvers):
        aid = uuid.uuid4()
        appr = WorkflowLineStepApproval(
            org_id=org, project_id=proj, step_run_id=sr.id, gate_id=gate.id, approval_group_id=grp,
            approver_member_id=aid, approver_member_type="human", kind="approver", blocking=True,
            status="pending", requested_by_member_id=requested_by)
        s.add(appr)
        approvers.append((aid, appr))
    await s.flush()
    return gate, proj, sr, approvers


def _resolved(member_id):
    from app.services.member_resolver import ResolvedMember
    return ResolvedMember(id=member_id, user_id=uuid.uuid4(), name="a", type="human",
                          role="member", org_id=uuid.uuid4())


@pytest.mark.skipif(not _REAL_DB_URL, reason="real Postgres 필요")
@pytest.mark.anyio
async def test_decide_endpoint_normal_approve_transitions_gate():
    """정상경로: 단독 approver(all quorum)가 approve → gate.status=approved, outcome=approved."""
    from unittest.mock import AsyncMock, patch
    from app.models.gate import Gate
    from app.routers import gates as gates_mod
    from app.routers.gates import WorkflowStepApprovalDecisionRequest, _decide_gate_approval_endpoint
    from sqlalchemy import select
    engine, Session = await _session()
    async with Session() as s:
        org = uuid.uuid4()
        gate, proj, sr, approvers = await _seed_parallel_gate(s, org)
        aid, appr = approvers[0]
        await s.commit()
        with patch.object(gates_mod, "resolve_member", AsyncMock(return_value=_resolved(aid))):
            result = await _decide_gate_approval_endpoint(
                gate.id, appr.id, WorkflowStepApprovalDecisionRequest(decision="approved"),
                session=s, org_id=org, auth=None, resolved_locale="ko",
            )
        assert result.outcome == "approved"
        assert result.skipped is False
        assert result.approver.status == "approved"
        refreshed = (await s.execute(select(Gate).where(Gate.id == gate.id))).scalar_one()
        assert refreshed.status == "approved"
    await engine.dispose()


@pytest.mark.skipif(not _REAL_DB_URL, reason="real Postgres 필요")
@pytest.mark.anyio
async def test_decide_endpoint_quorum_count_not_yet_met_stays_pending():
    """quorum: count=2인데 2명 중 1명만 approve → outcome=pending, gate 그대로 pending."""
    from unittest.mock import AsyncMock, patch
    from app.models.gate import Gate
    from app.routers import gates as gates_mod
    from app.routers.gates import WorkflowStepApprovalDecisionRequest, _decide_gate_approval_endpoint
    from sqlalchemy import select
    engine, Session = await _session()
    async with Session() as s:
        org = uuid.uuid4()
        gate, proj, sr, approvers = await _seed_parallel_gate(
            s, org, n_approvers=2, quorum_type="count", quorum_count=2,
        )
        aid, appr = approvers[0]
        await s.commit()
        with patch.object(gates_mod, "resolve_member", AsyncMock(return_value=_resolved(aid))):
            result = await _decide_gate_approval_endpoint(
                gate.id, appr.id, WorkflowStepApprovalDecisionRequest(decision="approved"),
                session=s, org_id=org, auth=None, resolved_locale="ko",
            )
        assert result.outcome == "pending"
        assert result.approved == 1
        assert result.total_blocking == 2
        refreshed = (await s.execute(select(Gate).where(Gate.id == gate.id))).scalar_one()
        assert refreshed.status == "pending"
    await engine.dispose()


@pytest.mark.anyio
async def test_decide_endpoint_reject_without_note_rejected_by_pydantic():
    """request_changes(reject)엔 사유가 필수 — note 없으면 요청 자체가 pydantic ValidationError."""
    from pydantic import ValidationError
    from app.routers.gates import WorkflowStepApprovalDecisionRequest
    with pytest.raises(ValidationError):
        WorkflowStepApprovalDecisionRequest(decision="rejected")
    # 사유가 있으면 통과.
    body = WorkflowStepApprovalDecisionRequest(decision="rejected", note="설계 근거 부족")
    assert body.note == "설계 근거 부족"


@pytest.mark.skipif(not _REAL_DB_URL, reason="real Postgres 필요")
@pytest.mark.anyio
async def test_decide_endpoint_wrong_resolver_403():
    """permission: 본인에게 배정 안 된 approver row를 decide 시도 → SelfApprovalError→403."""
    from unittest.mock import AsyncMock, patch
    from fastapi import HTTPException
    from app.routers import gates as gates_mod
    from app.routers.gates import WorkflowStepApprovalDecisionRequest, _decide_gate_approval_endpoint
    engine, Session = await _session()
    async with Session() as s:
        org = uuid.uuid4()
        gate, proj, sr, approvers = await _seed_parallel_gate(s, org)
        _aid, appr = approvers[0]
        stranger = uuid.uuid4()
        await s.commit()
        with patch.object(gates_mod, "resolve_member", AsyncMock(return_value=_resolved(stranger))):
            with pytest.raises(HTTPException) as ei:
                await _decide_gate_approval_endpoint(
                    gate.id, appr.id, WorkflowStepApprovalDecisionRequest(decision="approved"),
                    session=s, org_id=org, auth=None, resolved_locale="ko",
                )
        assert ei.value.status_code == 403
    await engine.dispose()


@pytest.mark.skipif(not _REAL_DB_URL, reason="real Postgres 필요")
@pytest.mark.anyio
async def test_decide_endpoint_sod_conflict_403():
    """SoD: approver 본인이 requested_by(상신자)와 동일 인물 → SelfApprovalError→403(2중 SoD 해소 시 검사)."""
    from unittest.mock import AsyncMock, patch
    from fastapi import HTTPException
    from app.routers import gates as gates_mod
    from app.routers.gates import WorkflowStepApprovalDecisionRequest, _decide_gate_approval_endpoint
    engine, Session = await _session()
    async with Session() as s:
        org = uuid.uuid4()
        requester_and_approver = uuid.uuid4()
        gate, proj, sr, approvers = await _seed_parallel_gate(
            s, org, requested_by=requester_and_approver,
        )
        appr = approvers[0][1]
        appr.approver_member_id = requester_and_approver  # 본인이 상신+결재 동일 인물
        await s.commit()
        with patch.object(gates_mod, "resolve_member",
                          AsyncMock(return_value=_resolved(requester_and_approver))):
            with pytest.raises(HTTPException) as ei:
                await _decide_gate_approval_endpoint(
                    gate.id, appr.id, WorkflowStepApprovalDecisionRequest(decision="approved"),
                    session=s, org_id=org, auth=None, resolved_locale="ko",
                )
        assert ei.value.status_code == 403
    await engine.dispose()


@pytest.mark.skipif(not _REAL_DB_URL, reason="real Postgres 필요")
@pytest.mark.anyio
async def test_decide_endpoint_cross_org_404():
    """org/gate 스코프 가드: 다른 org의 approval_id로 요청 → cross-org IDOR 차단(404, not-found 비노출)."""
    from unittest.mock import AsyncMock, patch
    from fastapi import HTTPException
    from app.routers import gates as gates_mod
    from app.routers.gates import WorkflowStepApprovalDecisionRequest, _decide_gate_approval_endpoint
    engine, Session = await _session()
    async with Session() as s:
        org_a = uuid.uuid4()
        org_b = uuid.uuid4()
        gate, proj, sr, approvers = await _seed_parallel_gate(s, org_a)
        aid, appr = approvers[0]
        await s.commit()
        with patch.object(gates_mod, "resolve_member", AsyncMock(return_value=_resolved(aid))):
            with pytest.raises(HTTPException) as ei:
                await _decide_gate_approval_endpoint(
                    gate.id, appr.id, WorkflowStepApprovalDecisionRequest(decision="approved"),
                    session=s, org_id=org_b, auth=None, resolved_locale="ko",
                )
        assert ei.value.status_code == 404
    await engine.dispose()
