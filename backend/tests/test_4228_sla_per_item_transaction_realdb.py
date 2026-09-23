"""story #4228 — `process_sla`의 항목별 트랜잭션.

배경: `process_sla`는 한 세션에서 배치 행을 `FOR UPDATE SKIP LOCKED`로 잡고 끝에 한 번 커밋했다. 항목 안 훅이 `commit()`을
부르는 경로(스토리 게이트 자동 승인 → 라인 해소 → 상태변경 프리셋 → send_message → commit)가 있어, 그 커밋이 앞 항목까지
확정하고 **배치 행 잠금을 풀어** 겹친 cron이 남은 행을 잡았다 — 같은 step_run을 두 cron이 각자 처리한다.

세팅은 SLA 하네스(test_edg_s13_sla_processor) 재사용. 이 파일은 시드를 **커밋**한다(항목마다 자기 세션이라 미커밋 시드는 안
보인다 — 운영 cron도 커밋된 행만 본다).
"""
from __future__ import annotations

import asyncio
import os
import uuid
from datetime import timedelta
from unittest.mock import AsyncMock, patch

import pytest

from tests.test_edg_s13_sla_processor import _NOTIFY, _NOW, _seed_line, _seed_run, _session

_REAL_DB_URL = os.getenv("PARITY_TEST_DATABASE_URL") or os.getenv("ALEMBIC_DATABASE_URL")

pytestmark = [
    pytest.mark.destructive_schema,
    pytest.mark.skipif(not _REAL_DB_URL, reason="real Postgres 필요"),
    pytest.mark.anyio,
]


@pytest.fixture
def anyio_backend():
    return "asyncio"


async def _seed_auto_approve_batch(Session, n: int, *, escalate_to: uuid.UUID | None = None):
    """자동 승인 대상 step_run n개(각자 스토리·게이트) — 커밋까지. 반환 [(sr_id, gate_id)] started_at 오름차순."""
    from app.models.gate import Gate
    from app.models.pm import Story
    from app.models.project import Project

    policy = {"timeout_hours": 4, "on_timeout": "auto_approve"}
    if escalate_to is not None:
        policy["escalate_to"] = str(escalate_to)
    async with Session() as s:
        org, proj = uuid.uuid4(), uuid.uuid4()
        s.add(Project(id=proj, org_id=org, name="p"))
        await s.flush()
        defn = await _seed_line(s, org, policy)
        out = []
        for i in range(n):
            story_id = uuid.uuid4()
            s.add(Story(id=story_id, org_id=org, project_id=proj, title=f"t{i}", status="in-review", story_points=3))
            gate = Gate(id=uuid.uuid4(), org_id=org, work_item_id=story_id, work_item_type="story",
                        gate_type="merge", status="pending")
            s.add(gate)
            await s.flush()
            sr = await _seed_run(s, org, defn, age_h=12 - i, entity_id=story_id, gate_id=gate.id,
                                 risk_snapshot={}, trust_snapshot={})
            out.append((sr.id, gate.id))
        await s.commit()
    return out


async def _events(Session, sr_id, event_type):
    from sqlalchemy import func, select

    from app.models.workflow_line import WorkflowLineStepRunEvent

    async with Session() as s:
        return (await s.execute(select(func.count()).select_from(WorkflowLineStepRunEvent).where(
            WorkflowLineStepRunEvent.step_run_id == sr_id, WorkflowLineStepRunEvent.event_type == event_type,
        ))).scalar_one()


async def test_overlapping_crons_handle_each_step_run_once_even_when_an_item_hook_commits():
    """AC3 — 겹친 cron 둘이 같은 배치를 돌아도 같은 step_run의 자동 승인·escalation은 **한 번만**.
    항목 안 훅의 중간 커밋을 재현한다: cron A의 첫 자동 승인이 실제 전이 뒤 `commit()`(스토리 상태변경 프리셋 → send_message
    경로와 같은 효과)하고 멈춘 사이 cron B가 전부 돈다. 예전 구조(배치 행을 한 세션에서 잠금)는 그 커밋이 잠금을 풀어 B가 A의
    남은 행을 처리하고, A는 이미 B가 승인한 행을 옛 상태로 이어 처리해 escalation을 한 번 더 남긴다 — RED.
    항목마다 자기 세션에서 행을 다시 잠그고(상태 필터) 처리하면, 이미 해소된 행은 건너뛴다."""
    import app.services.gate_service as gate_service
    from sqlalchemy import select

    from app.models.gate import Gate
    from app.services.workflow_sla_processor import process_sla

    engine, Session = await _session()
    try:
        batch = await _seed_auto_approve_batch(Session, 3, escalate_to=uuid.uuid4())
        real_transition = gate_service.transition_gate
        paused, resume = asyncio.Event(), asyncio.Event()
        state = {"first": True}

        async def _transition_then_hook_commit(session, *a, **kw):
            gate = await real_transition(session, *a, **kw)
            await session.commit()  # 항목 안 훅의 중간 커밋(send_message → db.commit()과 같은 효과)
            if state["first"]:
                state["first"] = False
                paused.set()
                await resume.wait()
            return gate

        with patch.object(gate_service, "transition_gate", _transition_then_hook_commit), patch(_NOTIFY, new=AsyncMock()):
            async def cron(now):
                async with Session() as s:
                    return await process_sla(s, now=now)

            task_a = asyncio.create_task(cron(_NOW))
            await asyncio.wait_for(paused.wait(), timeout=20)
            await cron(_NOW + timedelta(seconds=1))
            resume.set()
            await asyncio.wait_for(task_a, timeout=30)

        for sr_id, gate_id in batch:
            assert await _events(Session, sr_id, "auto_approved") == 1, sr_id
            assert await _events(Session, sr_id, "escalated") == 0, sr_id
            async with Session() as fresh:
                assert (await fresh.execute(select(Gate.status).where(Gate.id == gate_id))).scalar_one() == "approved"
    finally:
        await engine.dispose()
