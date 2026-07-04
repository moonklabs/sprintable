"""E-DG S32: manual reassign / ad-hoc approver replacement.

핵심: ①parallel gate(approver row 보유)의 pending 결재자 교체(gate.status 불변·pending 유지) ②단일 gate
(approver row 없음)=422(parallel 전용·Q1) ③새 approver 유효성(org 멤버+project_auth 접근·SoD) ④scaffold
컬럼(reassigned_from·original 보존) 활용·마이그0 ⑤audit event+새 approver notify·admin·reassigner 강제.
"""
from __future__ import annotations

import os
import uuid

import pytest

_REAL_DB_URL = os.getenv("PARITY_TEST_DATABASE_URL") or os.getenv("ALEMBIC_DATABASE_URL")

# story 8236bbc3: create_all(+drop_all)로 자체 스키마를 직접 다룸 — 공유 alembic-migrated
# DB 오염 방지 위해 격리 DB 전용(conftest.py 가드가 마커 누락을 자동 검출).
pytestmark = pytest.mark.destructive_schema


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


async def _member_with_access(s, org, proj=None):
    """project 멤버(TeamMember active) — resolve_member_identity(TM.id) + has_project_access(team_member
    active) 둘 다 통과. project 미지정이면 org-only(접근권 검사 실패 케이스용)."""
    from app.models.team import TeamMember
    mid = uuid.uuid4()
    s.add(TeamMember(id=mid, org_id=org, project_id=proj, name="m", type="human",
                     role="member", is_active=True))
    await s.flush()
    return mid


async def _seed_parallel_gate(s, org, *, n_approvers=1):
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
        gate_id=gate.id, correlation_id=uuid.uuid4(), transition_id=uuid.uuid4().hex)
    s.add(sr)
    await s.flush()
    approvers = []
    grp = uuid.uuid4()
    for _ in range(n_approvers):
        aid = uuid.uuid4()
        appr = WorkflowLineStepApproval(
            org_id=org, project_id=proj, step_run_id=sr.id, gate_id=gate.id, approval_group_id=grp,
            approver_member_id=aid, approver_member_type="human", kind="approver", blocking=True,
            status="pending")
        s.add(appr)
        approvers.append((aid, appr))
    await s.flush()
    return gate, proj, approvers


async def _seed_single_gate(s, org):
    """approver row 없는 단일 gate(라인엔진 ASK_HUMAN 류)."""
    from app.models.gate import Gate
    gate = Gate(id=uuid.uuid4(), org_id=org, work_item_id=uuid.uuid4(), work_item_type="doc",
                gate_type="merge", status="pending")
    s.add(gate)
    await s.flush()
    return gate


@pytest.mark.skipif(not _REAL_DB_URL, reason="real Postgres 필요")
@pytest.mark.anyio
async def test_reassign_updates_approver_row_and_event():
    """⭐reassign: approver_member_id=new·reassigned_from=old·original 보존·status pending·event 기록."""
    from app.services.workflow_parallel_approval import reassign_approver
    from app.models.workflow_line import WorkflowLineStepRunEvent
    from sqlalchemy import select
    engine, Session = await _session()
    async with Session() as s:
        org = uuid.uuid4()
        gate, proj, approvers = await _seed_parallel_gate(s, org)
        old_id = approvers[0][0]
        new_id = await _member_with_access(s, org, proj)
        reassigner = uuid.uuid4()
        await s.commit()
        target = await reassign_approver(s, org, gate.id, new_id, reassigner)
        await s.commit()
        assert target.approver_member_id == new_id
        assert target.reassigned_from_member_id == old_id
        assert target.original_approver_member_id == old_id   # 최초 보존
        assert target.status == "pending"                     # gate 재결정 대상
        ev = (await s.execute(select(WorkflowLineStepRunEvent).where(
            WorkflowLineStepRunEvent.event_type == "approver_reassigned"))).scalars().all()
        assert len(ev) == 1 and ev[0].target_member_id == new_id and ev[0].actor_member_id == reassigner
    await engine.dispose()


@pytest.mark.skipif(not _REAL_DB_URL, reason="real Postgres 필요")
@pytest.mark.anyio
async def test_reassign_single_gate_422():
    """단일 gate(approver row 없음)=명시 결재자 없음 → ValueError(Q1·parallel 전용)."""
    from app.services.workflow_parallel_approval import reassign_approver
    engine, Session = await _session()
    async with Session() as s:
        org = uuid.uuid4()
        gate = await _seed_single_gate(s, org)
        await s.commit()
        # 단일 gate 는 approver row 자체가 없어 멤버 유효성 전에 실패(new_id 임의 가능).
        with pytest.raises(ValueError, match="명시적 결재자"):
            await reassign_approver(s, org, gate.id, uuid.uuid4(), uuid.uuid4())
    await engine.dispose()


@pytest.mark.skipif(not _REAL_DB_URL, reason="real Postgres 필요")
@pytest.mark.anyio
async def test_reassign_invalid_new_approver_rejected():
    """새 approver 가 org 멤버 아님 → 거부(유령 결재자 방지)."""
    from app.services.workflow_parallel_approval import reassign_approver
    engine, Session = await _session()
    async with Session() as s:
        org = uuid.uuid4()
        gate, _, _ = await _seed_parallel_gate(s, org)
        await s.commit()
        with pytest.raises(ValueError, match="org 의 멤버"):
            await reassign_approver(s, org, gate.id, uuid.uuid4(), uuid.uuid4())  # 미시드 멤버
    await engine.dispose()


@pytest.mark.skipif(not _REAL_DB_URL, reason="real Postgres 필요")
@pytest.mark.anyio
async def test_reassign_multi_requires_old_approver_id():
    """approver 여러 명이면 old_approver_id 필수."""
    from app.services.workflow_parallel_approval import reassign_approver
    engine, Session = await _session()
    async with Session() as s:
        org = uuid.uuid4()
        gate, proj, approvers = await _seed_parallel_gate(s, org, n_approvers=2)
        new_id = await _member_with_access(s, org, proj)
        await s.commit()
        with pytest.raises(ValueError, match="여러 명"):
            await reassign_approver(s, org, gate.id, new_id, uuid.uuid4())  # old 미지정
        # old 지정하면 성공
        target = await reassign_approver(s, org, gate.id, new_id, uuid.uuid4(),
                                         old_approver_id=approvers[1][0])
        assert target.approver_member_id == new_id
    await engine.dispose()


# ── 엔드포인트 auth(CI-runnable) ─────────────────────────────────────────────
def _resolved_human():
    from app.services.member_resolver import ResolvedMember
    return ResolvedMember(id=uuid.uuid4(), user_id=uuid.uuid4(), name="a", type="human",
                          role="admin", org_id=uuid.uuid4())


@pytest.mark.anyio
async def test_reassign_endpoint_non_admin_403():
    from types import SimpleNamespace
    from unittest.mock import AsyncMock, patch
    from fastapi import HTTPException
    from app.routers import gates as gates_mod
    from app.routers.gates import GateReassignRequest, reassign_gate_approver_endpoint
    with patch.object(gates_mod, "resolve_member", AsyncMock(return_value=_resolved_human())), \
         patch.object(gates_mod, "is_org_owner_or_admin", AsyncMock(return_value=False)):
        with pytest.raises(HTTPException) as ei:
            await reassign_gate_approver_endpoint(
                id=uuid.uuid4(), body=GateReassignRequest(new_approver_id=uuid.uuid4()),
                session=AsyncMock(), org_id=uuid.uuid4(),
                auth=SimpleNamespace(user_id=str(uuid.uuid4())))
    assert ei.value.status_code == 403


@pytest.mark.skipif(not _REAL_DB_URL, reason="real Postgres 필요")
@pytest.mark.anyio
async def test_enrich_approvers_exposes_reassign_meta():
    """⭐FE 데이터소스: reassign 후 GET /approvers enrich 가 reassigned_by/reassigned_at(이벤트서) 노출."""
    from app.services.workflow_parallel_approval import list_gate_approvers, reassign_approver
    from app.routers.gates import _enrich_approvers
    engine, Session = await _session()
    async with Session() as s:
        org = uuid.uuid4()
        gate, proj, approvers = await _seed_parallel_gate(s, org)
        new_id = await _member_with_access(s, org, proj)
        reassigner = uuid.uuid4()
        await s.commit()
        await reassign_approver(s, org, gate.id, new_id, reassigner)
        await s.commit()
        rows = await list_gate_approvers(s, org, gate.id)
        enriched = await _enrich_approvers(s, org, rows)
        r = enriched[0]
        assert r.reassigned_by_member_id == reassigner   # {admin}
        assert r.reassigned_at is not None                # {시각}
        assert r.reassigned_from_member_id == approvers[0][0]  # 이전 결재자
    await engine.dispose()


@pytest.mark.skipif(not _REAL_DB_URL, reason="real Postgres 필요")
@pytest.mark.anyio
async def test_reassign_grant_only_human_new_approver_ok():
    """⭐까심 RC C4 회귀: member_id≠user_id 인 grant-only 휴먼(OrgMember+project_access grant)을 새
    approver 로 재지정 — has_project_access 에 user_id 전달 안 하면 false-reject(422)됐던 버그."""
    from app.services.workflow_parallel_approval import reassign_approver
    from app.models.project import OrgMember
    from app.models.project_access import ProjectAccess
    engine, Session = await _session()
    async with Session() as s:
        org = uuid.uuid4()
        gate, proj, _ = await _seed_parallel_gate(s, org)
        # grant-only 휴먼: OrgMember(id≠user_id) + project_access granted(org_member_id 경유).
        om_id = uuid.uuid4()
        s.add(OrgMember(id=om_id, org_id=org, user_id=uuid.uuid4(), role="member"))
        await s.flush()
        s.add(ProjectAccess(id=uuid.uuid4(), project_id=proj, permission="granted", role="member",
                            org_member_id=om_id))
        await s.commit()
        # new_approver_id = canonical member-id(om_id). fix 없으면 has_project_access(om_id) false→422.
        target = await reassign_approver(s, org, gate.id, om_id, uuid.uuid4())
        await s.commit()
        assert target.approver_member_id == om_id   # grant-only 휴먼 재지정 성공
    await engine.dispose()
