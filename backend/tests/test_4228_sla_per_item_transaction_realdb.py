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

from tests.test_edg_s13_sla_processor import _NOTIFY, _NOW, _seed_line, _seed_run
from tests.test_edg_s13_sla_processor import _session as _sla_session

_REAL_DB_URL = os.getenv("PARITY_TEST_DATABASE_URL") or os.getenv("ALEMBIC_DATABASE_URL")

pytestmark = [
    pytest.mark.destructive_schema,
    pytest.mark.skipif(not _REAL_DB_URL, reason="real Postgres 필요"),
    pytest.mark.anyio,
]


@pytest.fixture
def anyio_backend():
    return "asyncio"


async def _session():
    """SLA 하네스(create_all + 워크플로 테이블 TRUNCATE) + 실 훅 경로(시스템 발행자·이벤트 발행)가 쓰는 raw-SQL 부분 유니크
    인덱스 둘(0258 · entity_references) — create_all이 못 세우는 것을 test_4090 하네스와 같이 보정(제품 결함 아님)."""
    from sqlalchemy import text

    engine, Session = await _sla_session()
    async with engine.begin() as conn:
        await conn.execute(text(
            "CREATE UNIQUE INDEX IF NOT EXISTS uq_members_org_system_publisher "
            "ON members (org_id) WHERE runtime_type = 'system-publisher' AND type = 'agent'"
        ))
        await conn.execute(text(
            "CREATE UNIQUE INDEX IF NOT EXISTS uq_entity_references_non_proof "
            "ON entity_references (source_type, source_field, source_id, target_type, target_id, form, relation) "
            "WHERE form <> 'proof'"
        ))
    return engine, Session


async def _seed_auto_approve_batch(Session, n: int, *, escalate_to: uuid.UUID | None = None):
    """자동 승인 대상 step_run n개(각자 스토리·게이트) — 커밋까지. 반환 [(sr_id, gate_id)] started_at 오름차순."""
    from app.models.gate import Gate
    from app.models.organization import Organization
    from app.models.pm import Story
    from app.models.project import Project

    policy = {"timeout_hours": 4, "on_timeout": "auto_approve"}
    if escalate_to is not None:
        policy["escalate_to"] = str(escalate_to)

    async with Session() as s:
        org, proj = uuid.uuid4(), uuid.uuid4()
        s.add(Organization(id=org, name="Org4228", slug=f"org4228-{org.hex[:8]}"))
        await s.flush()
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


async def _seed_status_changed_preset(s) -> None:
    """실 시드(0245)의 `preset.work.status_changed` 정의를 그대로 넣는다(destructive 스키마라 마이그레이션 행이 없다)."""
    import importlib.util
    from pathlib import Path

    from app.models.event_definition import EventDefinition

    path = Path(__file__).resolve().parents[1] / "alembic/versions/0245_event_definitions.py"
    spec = importlib.util.spec_from_file_location("_mig_0245", path)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    key, payload_schema, routing = next(row for row in mod._SEED if row[0] == "preset.work.status_changed")
    s.add(EventDefinition(key=key, org_id=None, name=key, payload_schema=payload_schema, routing=routing))
    await s.flush()


async def _seed_mixed_batch(Session):
    """started_at 오름차순 A(리마인더) · B(스토리 게이트 자동 승인 + on_approve.apply_transition — 실 중간 커밋 경로) ·
    C(리마인더 — 테스트가 실패시킴). 전부 커밋. 반환 dict."""
    from app.models.gate import Gate
    from app.models.organization import Organization
    from app.models.pm import Story
    from app.models.project import Project
    from app.models.workflow_line import WorkflowLineDefinition, WorkflowLineDefinitionVersion, WorkflowLineStepRun
    from tests.test_4090_ac2_recipe_auto_publish_realdb import _seed_system_publisher_teammember_shim

    async with Session() as s:
        org, proj = uuid.uuid4(), uuid.uuid4()
        s.add(Organization(id=org, name="Org4228", slug=f"org4228-{org.hex[:8]}"))
        await s.flush()
        s.add(Project(id=proj, org_id=org, name="p"))
        await s.flush()
        await _seed_status_changed_preset(s)
        await _seed_system_publisher_teammember_shim(s, org, proj)
        reminder_defn = await _seed_line(s, org, {"timeout_hours": 24, "reminder_after_hours": 2,
                                                 "reminder_every_hours": 2, "max_reminders": 3})
        approve_defn = WorkflowLineDefinition(org_id=org, project_id=None, entity_type="story", name="L-approve",
                                              is_active=True, version=1)
        s.add(approve_defn)
        await s.flush()
        s.add(WorkflowLineDefinitionVersion(
            line_definition_id=approve_defn.id, org_id=org, project_id=None, entity_type="story", version=1,
            status="published", config_hash="h2", created_by_member_id=uuid.uuid4(),
            config={"steps": [{"from_status": "in-review", "to_status": "done", "step_type": "human-gate",
                               "sla_policy": {"timeout_hours": 4, "on_timeout": "auto_approve"},
                               "on_approve": {"apply_transition": True}}]}))
        story_b = uuid.uuid4()
        s.add(Story(id=story_b, org_id=org, project_id=proj, title="B", status="in-review", story_points=3))
        gate_b = Gate(id=uuid.uuid4(), org_id=org, work_item_id=story_b, work_item_type="story",
                      gate_type="merge", status="pending")
        s.add(gate_b)
        await s.flush()
        sr_a = await _seed_run(s, org, reminder_defn, age_h=6, resolved_member_id=uuid.uuid4())
        sr_b = WorkflowLineStepRun(
            org_id=org, project_id=proj, line_definition_id=approve_defn.id, entity_type="story",
            entity_id=story_b, from_status="in-review", to_status="done", status="gate_pending", mode="gate_pending",
            correlation_id=uuid.uuid4(), transition_id=uuid.uuid4().hex, started_at=_NOW - timedelta(hours=5),
            gate_id=gate_b.id)
        s.add(sr_b)
        await s.flush()
        sr_c = await _seed_run(s, org, reminder_defn, age_h=4, resolved_member_id=uuid.uuid4())
        await s.commit()
        return {"org": org, "a": sr_a.id, "b": sr_b.id, "c": sr_c.id, "gate_b": gate_b.id, "story_b": story_b}


def _fail_after_processing(monkeypatch, failing_sr_id):
    """C 항목: 실제 처리(카운트까지 올림)를 마친 **뒤** 같은 세션에서 실 PG 오류 → 그 항목 트랜잭션 aborted · 커밋 전 예외."""
    import app.services.workflow_sla_processor as sla

    real_one = sla._process_one_step_run

    async def _one(session, sr, now, counts):
        await real_one(session, sr, now, counts)
        if sr.id == failing_sr_id:
            from sqlalchemy import text

            await session.execute(text("SELECT * FROM no_such_table_4228"))

    monkeypatch.setattr(sla, "_process_one_step_run", _one)


async def test_real_hook_commit_item_counts_as_success_and_a_failing_item_is_isolated(monkeypatch):
    """AC1·AC2·AC4 — 한 배치에 A(리마인더) · B(스토리 게이트 자동 승인 + `on_approve.apply_transition` — 스토리 전이 →
    `preset.work.status_changed` → send_message → **실제 중간 `commit()`**) · C(처리 뒤 실 PG 오류).
    - B는 중간 커밋이 있어도 성공으로 센다(auto_approved 1) · 게이트 approved · 스토리 done · 상태변경 메시지가 실제로 남음.
    - C는 그 항목만 되돌아간다: 리마인더 이벤트 0 · 상태 그대로 · 카운트는 error 1뿐(처리 중 올린 reminded는 안 더함 — AC4).
    - A는 C와 섞이지 않고 커밋(리마인더 1). 전부 **새 세션**으로 재조회.
    뮤테이션: 항목별 트랜잭션을 빼면(한 세션·끝에 한 번 커밋) C의 오류가 배치를 끊어 RED."""
    from sqlalchemy import select, text

    from app.models.gate import Gate
    from app.models.pm import Story
    from app.models.workflow_line import WorkflowLineStepRun
    from app.services.workflow_sla_processor import process_sla

    engine, Session = await _session()
    try:
        w = await _seed_mixed_batch(Session)
        _fail_after_processing(monkeypatch, w["c"])
        with patch(_NOTIFY, new=AsyncMock()):
            async with Session() as s:
                counts = await process_sla(s, now=_NOW)
        assert counts["reminded"] == 1 and counts["auto_approved"] == 1 and counts["error"] == 1, counts

        assert await _events(Session, w["a"], "reminded") == 1
        assert await _events(Session, w["b"], "auto_approved") == 1
        assert await _events(Session, w["c"], "reminded") == 0
        async with Session() as fresh:
            assert (await fresh.execute(select(Gate.status).where(Gate.id == w["gate_b"]))).scalar_one() == "approved"
            assert (await fresh.execute(select(Story.status).where(Story.id == w["story_b"]))).scalar_one() == "done"
            c_row = (await fresh.execute(select(WorkflowLineStepRun).where(WorkflowLineStepRun.id == w["c"]))).scalar_one()
            assert c_row.status == "gate_pending" and c_row.reminder_count == 0
            status_msgs = (await fresh.execute(text(
                "SELECT count(*) FROM conversation_messages "
                "WHERE metadata->'event'->>'event_key' = 'preset.work.status_changed' "
                "AND metadata->'event'->'payload'->>'work_item_id' = :sid"
            ), {"sid": str(w["story_b"])})).scalar_one()
            assert status_msgs == 1  # 실 중간 커밋 경로(send_message)가 정말로 돌았다
    finally:
        await engine.dispose()


async def test_a_wake_scheduled_by_one_item_survives_another_items_rollback(monkeypatch):
    """AC5 — 대기 중 에이전트 wake 목록(event_seq, 세션 info에 쌓였다 커밋 뒤 발사 · 롤백 때 비움)이 다른 항목의 롤백으로
    사라지지 않는다. A의 알림 자리에서 wake를 예약 → C가 실 PG 오류로 롤백 → A의 wake는 발사됐다. 예전 구조(한 세션)에선 C의
    오류가 배치를 끊고 세션 롤백이 A의 예약까지 비웠다."""
    import app.routers.agent_gateway as agent_gateway
    import app.services.workflow_sla_processor as sla
    from app.services.event_seq import _schedule_wake_after_commit
    from app.services.workflow_sla_processor import process_sla

    engine, Session = await _session()
    try:
        w = await _seed_mixed_batch(Session)
        _fail_after_processing(monkeypatch, w["c"])
        fired = []
        monkeypatch.setattr(agent_gateway, "wake_agent", lambda rid, seq: fired.append((rid, seq)))
        real_notify = sla._notify

        async def _notify(session, sr, target_id, event_type, title):
            if sr.id == w["a"]:
                _schedule_wake_after_commit(session, "agent-A", 7)
            return await real_notify(session, sr, target_id, event_type, title)

        monkeypatch.setattr(sla, "_notify", _notify)
        with patch(_NOTIFY, new=AsyncMock()):
            async with Session() as s:
                counts = await process_sla(s, now=_NOW)
        assert counts["error"] == 1, counts
        assert ("agent-A", 7) in fired, fired
    finally:
        await engine.dispose()


async def test_caller_session_returns_its_connection_before_items_so_a_two_connection_pool_suffices(monkeypatch):
    """호출자 세션은 id 조회 직후 트랜잭션을 끝내 커넥션을 풀에 돌려준다. 워커 풀은 기본 2+1=3이고 다른 cron과 나눠 쓴다 —
    호출자 세션이 트랜잭션을 연 채(커넥션 보유) 항목 세션 + 항목 안 격리 세션(`run_side_effect_in_own_session`류)까지 겹치면
    항목 하나에 3개다. 여기서는 **커넥션 2개짜리 풀**(pool_size=1 · max_overflow=1 · pool_timeout=2s)로 cron을 돌리고,
    항목마다 격리 세션을 하나 더 열어 쿼리한다: 막힘 없이 전부 처리 · 항목 처리 중 호출자 세션은 트랜잭션 밖.
    뮤테이션: 조회 뒤 반환을 빼면 항목마다 세 번째 커넥션을 기다리다 `pool_timeout` → 전부 error — RED."""
    from sqlalchemy import text
    from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker, create_async_engine

    import app.services.workflow_sla_processor as sla

    engine, Session = await _session()
    small = create_async_engine(engine.url, pool_size=1, max_overflow=1, pool_timeout=2)
    try:
        batch = await _seed_auto_approve_batch(Session, 2)
        real_one = sla._process_one_step_run
        caller_in_tx: list[bool] = []
        caller: dict[str, AsyncSession] = {}

        async def _one(session, sr, now, counts):
            caller_in_tx.append(caller["s"].in_transaction())
            async with AsyncSession(bind=small) as side:  # 항목 안 격리 세션(훅의 run_side_effect_in_own_session 자리)
                await side.execute(text("SELECT 1"))
            await real_one(session, sr, now, counts)

        monkeypatch.setattr(sla, "_process_one_step_run", _one)
        with patch(_NOTIFY, new=AsyncMock()):
            async with async_sessionmaker(small, expire_on_commit=False)() as s:
                caller["s"] = s
                counts = await sla.process_sla(s, now=_NOW)
        assert counts["auto_approved"] == 2 and counts["error"] == 0, counts
        assert caller_in_tx == [False, False], caller_in_tx
        for sr_id, _gate_id in batch:
            assert await _events(Session, sr_id, "auto_approved") == 1
    finally:
        await small.dispose()
        await engine.dispose()
