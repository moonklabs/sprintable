"""E-DG S26: sprint status contract + line overlay.

핵심: sprint FSM(enum+전이)·matrix flip(advisory·dispatch_capable=False)·_apply_sprint_transition(③SoD
없음·repo.activate/close 위임·1-active 제약 보존)·default-off 거동(activate/close 기존 흐름). close-state
=closed(decision① B·de-facto). human-gate=enforcing gate(default-off inline 없음).
"""
from __future__ import annotations

import os
import uuid

import pytest

_REAL_DB_URL = os.getenv("PARITY_TEST_DATABASE_URL") or os.getenv("ALEMBIC_DATABASE_URL")


@pytest.fixture
def anyio_backend():
    return "asyncio"


# ── FSM·matrix (unit·CI-runnable) ─────────────────────────────────────────────
def test_sprint_fsm_valid_transitions():
    from app.schemas.sprint import SPRINT_STATUSES, is_valid_sprint_transition
    assert SPRINT_STATUSES == ("planning", "active", "review", "closed", "archived")
    assert is_valid_sprint_transition("planning", "active")
    assert is_valid_sprint_transition("active", "closed")    # 마감 직행(review 선택)
    assert is_valid_sprint_transition("active", "review")
    assert is_valid_sprint_transition("review", "closed")
    assert is_valid_sprint_transition("closed", "archived")  # native
    assert not is_valid_sprint_transition("planning", "closed")  # 직행 금지
    assert not is_valid_sprint_transition("closed", "active")    # 역전이 금지


def test_matrix_sprint_eligible_dispatch_off():
    from app.services.workflow_readiness_matrix import get_readiness, is_transition_supported
    s = get_readiness("sprint")
    assert s.gating_eligible is True
    assert s.dispatch_capable is False  # ⭐agent-handoff S27까지 금지
    assert s.valid_transitions == frozenset({("planning", "active"), ("active", "closed"), ("review", "closed")})
    assert is_transition_supported("sprint", "planning", "active") is True
    assert is_transition_supported("sprint", "review", "closed") is True
    assert is_transition_supported("sprint", "closed", "archived") is False  # scope 밖(native)


async def _session():
    from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine
    from app.core.database import Base
    import app.models  # noqa: F401
    import app.models.participation  # noqa: F401
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


def _sr(to_status, from_status="planning"):
    from unittest.mock import MagicMock
    return MagicMock(entity_type="sprint", entity_id=uuid.uuid4(), org_id=uuid.uuid4(),
                     id=uuid.uuid4(), from_status=from_status, to_status=to_status)


# ── _apply_sprint_transition (real-PG·③SoD 없음·repo 위임) ────────────────────
@pytest.mark.skipif(not _REAL_DB_URL, reason="real Postgres 필요")
@pytest.mark.anyio
async def test_apply_activates_no_sod():
    """gate 승인 적용: planning→active·SoD 없음(임의 approver)·repo.activate 1-active 제약 보존."""
    from app.services.workflow_line_resolution import _apply_sprint_transition
    from app.models.pm import Sprint
    from app.models.project import Project
    from sqlalchemy import select
    from app.models.workflow_line import WorkflowLineStepRun
    engine, Session = await _session()
    async with Session() as s:
        org, proj = uuid.uuid4(), uuid.uuid4()
        s.add(Project(id=proj, org_id=org, name="p"))
        await s.flush()
        sprint = Sprint(org_id=org, project_id=proj, title="sp", status="planning")
        s.add(sprint)
        await s.flush()
        sr = WorkflowLineStepRun(
            org_id=org, project_id=proj, entity_type="sprint", entity_id=sprint.id,
            from_status="planning", to_status="active", status="gate_pending", mode="enforcing",
            correlation_id=uuid.uuid4(), transition_id=uuid.uuid4().hex)
        s.add(sr)
        await s.flush()
        await _apply_sprint_transition(s, sr, resolver_id=uuid.uuid4())  # SoD 없음
        await s.commit()
        st = (await s.execute(select(Sprint.status).where(Sprint.id == sprint.id))).scalar()
        assert st == "active" and sr.status == "applied"
    await engine.dispose()


@pytest.mark.skipif(not _REAL_DB_URL, reason="real Postgres 필요")
@pytest.mark.anyio
async def test_apply_active_already_idempotent():
    from app.services.workflow_line_resolution import _apply_sprint_transition
    from app.models.pm import Sprint
    from app.models.project import Project
    from app.models.workflow_line import WorkflowLineStepRun
    engine, Session = await _session()
    async with Session() as s:
        org, proj = uuid.uuid4(), uuid.uuid4()
        s.add(Project(id=proj, org_id=org, name="p"))
        await s.flush()
        sprint = Sprint(org_id=org, project_id=proj, title="sp", status="active")
        s.add(sprint)
        await s.flush()
        sr = WorkflowLineStepRun(
            org_id=org, project_id=proj, entity_type="sprint", entity_id=sprint.id,
            from_status="planning", to_status="active", status="gate_pending", mode="enforcing",
            correlation_id=uuid.uuid4(), transition_id=uuid.uuid4().hex)
        s.add(sr)
        await s.flush()
        await _apply_sprint_transition(s, sr, resolver_id=uuid.uuid4())
        await s.commit()
        assert sr.status == "applied"  # 이미 active → no-op
    await engine.dispose()


@pytest.mark.skipif(not _REAL_DB_URL, reason="real Postgres 필요")
@pytest.mark.anyio
async def test_default_off_activate_any_caller():
    """default-off: transition_sprint(active)가 inline human-only 없이 활성(기존 agent activate 흐름 보존)."""
    from app.services.sprint import transition_sprint
    from app.services.member_resolver import ResolvedMember
    from app.models.pm import Sprint
    from app.models.project import Project
    engine, Session = await _session()
    async with Session() as s:
        org, proj = uuid.uuid4(), uuid.uuid4()
        s.add(Project(id=proj, org_id=org, name="p"))
        await s.flush()
        sprint = Sprint(org_id=org, project_id=proj, title="sp", status="planning")
        s.add(sprint)
        await s.commit()
        agent = ResolvedMember(id=uuid.uuid4(), user_id=None, name="a", type="agent", role="member", org_id=org)
        result = await transition_sprint(s, org, agent, sprint.id, "active")  # agent·default-off→활성
        assert result.status == "active"  # human-only inline 없음(enforcing gate가 담당)
    await engine.dispose()
