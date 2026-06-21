"""E-DG S25: epic line overlay (draft→active + active→done).

핵심: epic FSM·matrix flip·⭐SoD(approver≠assignee_id·activation만·assignee None fail-closed)·
active→done(SoD 무관)·default-off agent activation 차단·resolver epic_aggregate(advisory).
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
def test_epic_fsm_valid_transitions():
    from app.schemas.epic import is_valid_epic_transition
    assert is_valid_epic_transition("draft", "active")
    assert is_valid_epic_transition("active", "done")
    assert is_valid_epic_transition("active", "archived")  # native
    assert not is_valid_epic_transition("done", "active")  # 역전이 금지
    assert not is_valid_epic_transition("draft", "done")   # 비합법(직행 금지)


def test_matrix_epic_eligible_two_overlay_transitions():
    from app.services.workflow_readiness_matrix import get_readiness, is_transition_supported
    e = get_readiness("epic")
    assert e.gating_eligible is True
    assert e.valid_transitions == frozenset({("draft", "active"), ("active", "done")})
    assert is_transition_supported("epic", "draft", "active") is True
    assert is_transition_supported("epic", "active", "done") is True
    assert is_transition_supported("epic", "done", "archived") is False  # scope 밖(native)


# ── SoD applier (CI-runnable·mock·skipif 없음) ────────────────────────────────
def _mock_sr(to_status):
    from unittest.mock import MagicMock
    return MagicMock(entity_type="epic", entity_id=uuid.uuid4(), org_id=uuid.uuid4(),
                     from_status="draft", to_status=to_status)


async def _run_apply(epic_mock, sr, resolver_id, owner="__unset__"):
    # RC#2: SoD 가 epic.assignee_id 대신 resolve_project_relay_owner(project owner)를 쓰므로 patch.
    from unittest.mock import AsyncMock, MagicMock, patch
    from app.services.workflow_line_resolution import _apply_epic_transition
    result = MagicMock()
    result.scalar_one_or_none.return_value = epic_mock
    session = AsyncMock()
    session.execute = AsyncMock(return_value=result)
    _owner = epic_mock.assignee_id if owner == "__unset__" else owner
    with patch("app.services.project_auth.resolve_project_relay_owner",
               new=AsyncMock(return_value=_owner)):
        await _apply_epic_transition(session, sr, resolver_id=resolver_id)


@pytest.mark.anyio
async def test_apply_sod_blocks_owner_self_approve():
    """⭐RC#2 SoD(activation): approver == project owner → 차단(skipped). assignee 아닌 owner 기준."""
    from unittest.mock import MagicMock
    owner = uuid.uuid4()
    epic = MagicMock(status="draft", assignee_id=None, id=uuid.uuid4(), title="e", project_id=uuid.uuid4())
    sr = _mock_sr("active")
    await _run_apply(epic, sr, resolver_id=owner, owner=owner)  # self == owner
    assert sr.status == "skipped"


@pytest.mark.anyio
async def test_apply_sod_owner_null_fail_closed():
    """⭐owner 해소 None → activation 차단(fail-closed). assignee null 의존 제거(과차단 근본 해소)."""
    from unittest.mock import MagicMock
    epic = MagicMock(status="draft", assignee_id=None, id=uuid.uuid4(), title="e", project_id=uuid.uuid4())
    sr = _mock_sr("active")
    await _run_apply(epic, sr, resolver_id=uuid.uuid4(), owner=None)
    assert sr.status == "skipped"  # owner None → fail-closed


@pytest.mark.anyio
async def test_apply_sod_allows_non_owner_approver():
    """⭐approver ≠ project owner → SoD 통과(차단 아님). owner-기준 SoD 정상 동작 입증."""
    from unittest.mock import MagicMock
    owner = uuid.uuid4()
    epic = MagicMock(status="draft", assignee_id=None, id=uuid.uuid4(), title="e", project_id=uuid.uuid4())
    sr = _mock_sr("active")
    await _run_apply(epic, sr, resolver_id=uuid.uuid4(), owner=owner)  # approver != owner
    assert sr.status != "skipped"  # SoD 통과(transition_epic 진행)


# ── active→done(SoD 무관)·default-off·aggregate (real-PG) ─────────────────────
async def _session():
    from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine
    from app.core.database import Base
    import app.models  # noqa: F401
    import app.models.participation  # noqa: F401
    import app.models.workflow_line  # noqa: F401
    import app.models.event  # noqa: F401
    url = _REAL_DB_URL
    for prefix in ("postgresql+psycopg2://", "postgresql+asyncpg://", "postgresql://"):
        if url.startswith(prefix):
            url = "postgresql+asyncpg://" + url[len(prefix):]
            break
    engine = create_async_engine(url)
    async with engine.begin() as conn:
        await conn.run_sync(Base.metadata.create_all)
    return engine, async_sessionmaker(engine, expire_on_commit=False)


@pytest.mark.skipif(not _REAL_DB_URL, reason="real Postgres 필요")
@pytest.mark.anyio
async def test_default_off_agent_activation_blocked():
    """default-off: agent draft→active → overlay plain → inline HUMAN_CONFIRM_REQUIRED(byte-동일)."""
    from app.services.epic import transition_epic, EpicTransitionError
    from app.services.member_resolver import ResolvedMember
    from app.models.pm import Epic
    from app.models.project import Project
    engine, Session = await _session()
    async with Session() as s:
        org, proj = uuid.uuid4(), uuid.uuid4()
        s.add(Project(id=proj, org_id=org, name="p"))
        await s.flush()
        epic = Epic(org_id=org, project_id=proj, title="e", status="draft")
        s.add(epic)
        await s.commit()
        agent = ResolvedMember(id=uuid.uuid4(), user_id=None, name="a", type="agent", role="member", org_id=org)
        with pytest.raises(EpicTransitionError) as ei:
            await transition_epic(s, org, agent, epic.id, "active")
        assert ei.value.code == "HUMAN_CONFIRM_REQUIRED"
    await engine.dispose()


@pytest.mark.skipif(not _REAL_DB_URL, reason="real Postgres 필요")
@pytest.mark.anyio
async def test_resolver_epic_aggregate_included():
    """⭐active→done routing material: resolver 가 epic 산하 story aggregate 포함(advisory)."""
    from app.services.workflow_line_resolver import resolve_routing_context
    from app.models.pm import Epic, Story
    from app.models.project import Project
    engine, Session = await _session()
    async with Session() as s:
        org, proj = uuid.uuid4(), uuid.uuid4()
        s.add(Project(id=proj, org_id=org, name="p"))
        await s.flush()
        epic = Epic(org_id=org, project_id=proj, title="e", status="active")
        s.add(epic)
        await s.flush()
        s.add(Story(org_id=org, project_id=proj, epic_id=epic.id, title="s1", status="done"))
        s.add(Story(org_id=org, project_id=proj, epic_id=epic.id, title="s2", status="in-progress"))
        await s.commit()
        ctx = await resolve_routing_context(s, org, entity_type="epic", entity_id=epic.id)
        assert ctx["supported"] is True and ctx["entity_type"] == "epic"
        agg = ctx["epic_aggregate"]
        assert agg["total_stories"] == 2 and agg["done_stories"] == 1 and agg["open_stories"] == 1
    await engine.dispose()
