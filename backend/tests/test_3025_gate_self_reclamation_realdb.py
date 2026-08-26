"""story #f2b66f32(3025, BE·상태 자가회수) — merge-type pending 게이트 자가회수.

핵심: ①target story.status=='done'인데 pending인 merge gate만 voided로 회수 ②resolver_id는
항상 None(사람 승인 위조 금지, AC3) ③묶인 step_run이 있으면 skipped로 해소(void_gate와 동형 —
entity unblock) ④doc_approval·다른 story의 게이트·이미 non-pending인 게이트는 절대 안 건드림
(음성대조, 페드루 PO 요청 2026-08-24) ⑤emit_story_status_changed 배선 — done 전이에서만 호출,
실패해도 격리(status 전이 비차단).
"""
from __future__ import annotations

import os
import uuid

import pytest

_REAL_DB_URL = os.getenv("PARITY_TEST_DATABASE_URL") or os.getenv("ALEMBIC_DATABASE_URL")

# story 8236bbc3 관례 — create_all(+drop_all)로 자체 스키마를 직접 다뤄 공유 alembic-migrated
# DB 오염 방지 위해 격리 DB 전용.
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
    import app.models.activity_log  # noqa: F401
    url = _REAL_DB_URL
    for prefix in ("postgresql+psycopg2://", "postgresql://"):
        if url.startswith(prefix):
            url = "postgresql+asyncpg://" + url[len(prefix):]
            break
    engine = create_async_engine(url)
    async with engine.begin() as conn:
        await conn.run_sync(Base.metadata.create_all)
    return engine, async_sessionmaker(engine, expire_on_commit=False)


async def _seed_gate(s, org, work_item_id, *, gate_type="merge", work_item_type="story",
                      status="pending", with_step_run=True):
    from app.models.gate import Gate
    from app.models.workflow_line import WorkflowLineStepRun
    proj = uuid.uuid4()
    gate = Gate(id=uuid.uuid4(), org_id=org, work_item_id=work_item_id,
                work_item_type=work_item_type, gate_type=gate_type, status=status)
    s.add(gate)
    await s.flush()
    sr = None
    if with_step_run:
        sr = WorkflowLineStepRun(
            org_id=org, project_id=proj, entity_type="story", entity_id=work_item_id,
            from_status="in-review", to_status="done", status="gate_pending", mode="gate_pending",
            gate_id=gate.id, h1_gate_id=gate.id, correlation_id=uuid.uuid4(),
            transition_id=uuid.uuid4().hex)
        s.add(sr)
        await s.flush()
    return gate, sr


@pytest.mark.skipif(not _REAL_DB_URL, reason="real Postgres 필요")
@pytest.mark.anyio
async def test_reclaims_pending_merge_gate_and_resolves_step_run():
    """핵심 케이스: pending merge gate → voided, resolver_id=None, step_run=skipped."""
    from app.services.gate_self_reclamation import reclaim_stale_merge_gates_for_story
    from app.models.workflow_line import WorkflowLineStepRun
    from sqlalchemy import select
    engine, Session = await _session()
    async with Session() as s:
        org = uuid.uuid4()
        story_id = uuid.uuid4()
        gate, sr = await _seed_gate(s, org, story_id)
        await s.commit()

        reclaimed = await reclaim_stale_merge_gates_for_story(s, org, story_id)
        await s.commit()

        assert len(reclaimed) == 1
        assert reclaimed[0].status == "voided"
        assert reclaimed[0].resolver_id is None  # AC3: 사람 승인 위조 금지 — 아무도 안 눌렀다.
        assert "system_auto_reclaim" in (reclaimed[0].resolution_note or "")
        assert reclaimed[0].resolved_at is not None

        sr2 = (await s.execute(
            select(WorkflowLineStepRun).where(WorkflowLineStepRun.id == sr.id)
        )).scalar_one()
        assert sr2.status == "skipped"
        assert "gate auto-voided" in (sr2.routing_reason or "")
    await engine.dispose()


@pytest.mark.skipif(not _REAL_DB_URL, reason="real Postgres 필요")
@pytest.mark.anyio
async def test_negative_control_doc_approval_untouched():
    """음성대조(페드루 PO 요청) — doc_approval 게이트는 gate_type이 merge가 아니므로 절대 안 건드림."""
    from app.services.gate_self_reclamation import reclaim_stale_merge_gates_for_story
    engine, Session = await _session()
    async with Session() as s:
        org = uuid.uuid4()
        doc_id = uuid.uuid4()
        gate, _ = await _seed_gate(
            s, org, doc_id, gate_type="doc_approval", work_item_type="doc", with_step_run=False,
        )
        await s.commit()

        reclaimed = await reclaim_stale_merge_gates_for_story(s, org, doc_id)
        await s.commit()

        assert reclaimed == []
        await s.refresh(gate)
        assert gate.status == "pending"  # 완전 무변경.
    await engine.dispose()


@pytest.mark.skipif(not _REAL_DB_URL, reason="real Postgres 필요")
@pytest.mark.anyio
async def test_negative_control_qa_gate_on_story_untouched():
    """음성대조(story #d2dad0d2, 카디르 QA(#3454) 부수 발견) — doc_approval 음성대조는
    gate_type·work_item_type 두 축을 동시에 바꿔 시딩돼, gate_type=="merge" 필터만 mutation
    으로 제거해도 work_item_type 축이 여전히 걸러 vacuous(그 mutation을 못 잡음). 진짜 인접
    위험은 gate_type="qa"+work_item_type="story"(라이브 실재 조합, work_item_type은 대상
    story와 동일) — 이 축만 다르게 시딩해 gate_type 필터 단독 mutation을 정확히 잡는다."""
    from app.services.gate_self_reclamation import reclaim_stale_merge_gates_for_story
    engine, Session = await _session()
    async with Session() as s:
        org = uuid.uuid4()
        story_id = uuid.uuid4()
        qa_gate, _ = await _seed_gate(
            s, org, story_id, gate_type="qa", work_item_type="story", with_step_run=False,
        )
        await s.commit()

        reclaimed = await reclaim_stale_merge_gates_for_story(s, org, story_id)
        await s.commit()

        assert reclaimed == []
        await s.refresh(qa_gate)
        assert qa_gate.status == "pending"  # 완전 무변경 — merge가 아닌 qa 게이트는 안 건드림.
    await engine.dispose()


@pytest.mark.skipif(not _REAL_DB_URL, reason="real Postgres 필요")
@pytest.mark.anyio
async def test_negative_control_other_story_untouched():
    """음성대조 — 다른 story_id의 게이트는 안 건드림(work_item_id 정확 매치만)."""
    from app.services.gate_self_reclamation import reclaim_stale_merge_gates_for_story
    engine, Session = await _session()
    async with Session() as s:
        org = uuid.uuid4()
        target_story = uuid.uuid4()
        other_story = uuid.uuid4()
        gate_other, _ = await _seed_gate(s, org, other_story, with_step_run=False)
        await s.commit()

        reclaimed = await reclaim_stale_merge_gates_for_story(s, org, target_story)
        await s.commit()

        assert reclaimed == []
        await s.refresh(gate_other)
        assert gate_other.status == "pending"
    await engine.dispose()


@pytest.mark.skipif(not _REAL_DB_URL, reason="real Postgres 필요")
@pytest.mark.anyio
async def test_negative_control_non_pending_untouched():
    """음성대조 — 이미 approved/rejected/voided/held인 게이트는 idempotent 재실행에도 건드리지 않음."""
    from app.services.gate_self_reclamation import reclaim_stale_merge_gates_for_story
    engine, Session = await _session()
    async with Session() as s:
        org = uuid.uuid4()
        story_id = uuid.uuid4()
        approved, _ = await _seed_gate(s, org, story_id, status="approved", with_step_run=False)
        await s.commit()

        reclaimed = await reclaim_stale_merge_gates_for_story(s, org, story_id)
        await s.commit()

        assert reclaimed == []
        await s.refresh(approved)
        assert approved.status == "approved"
    await engine.dispose()


@pytest.mark.skipif(not _REAL_DB_URL, reason="real Postgres 필요")
@pytest.mark.anyio
async def test_idempotent_rerun_no_double_processing():
    """재실행 멱등 — 이미 voided인 게이트를 다시 돌려도 재처리 0건(백필 재실행 안전)."""
    from app.services.gate_self_reclamation import reclaim_stale_merge_gates_for_story
    engine, Session = await _session()
    async with Session() as s:
        org = uuid.uuid4()
        story_id = uuid.uuid4()
        gate, _ = await _seed_gate(s, org, story_id, with_step_run=False)
        await s.commit()

        first = await reclaim_stale_merge_gates_for_story(s, org, story_id)
        await s.commit()
        second = await reclaim_stale_merge_gates_for_story(s, org, story_id)
        await s.commit()

        assert len(first) == 1
        assert second == []
    await engine.dispose()


@pytest.mark.skipif(not _REAL_DB_URL, reason="real Postgres 필요")
@pytest.mark.anyio
async def test_no_step_run_ok():
    """step_run 없는 게이트(legacy/비-라인)도 정상 회수(void_gate와 동형 no-op recovery)."""
    from app.services.gate_self_reclamation import reclaim_stale_merge_gates_for_story
    engine, Session = await _session()
    async with Session() as s:
        org = uuid.uuid4()
        story_id = uuid.uuid4()
        gate, _ = await _seed_gate(s, org, story_id, with_step_run=False)
        await s.commit()

        reclaimed = await reclaim_stale_merge_gates_for_story(s, org, story_id)
        await s.commit()

        assert len(reclaimed) == 1
        assert reclaimed[0].status == "voided"
    await engine.dispose()
