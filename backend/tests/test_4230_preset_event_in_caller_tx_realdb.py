"""story #4230 — 게이트 전이 훅의 프리셋 이벤트 발행이 **호출자 트랜잭션에 참여**한다.

결함(까디르 4586 QA P2): `transition_gate` 안의 두 훅 — 판정 알림(`preset.gate.verdict`)과 라인 해소 → 스토리 상태변경
(`preset.work.status_changed`) — 이 `publish_preset_event → send_message`를 거쳐 **전이 트랜잭션을 중간에 커밋**했다. 그 뒤
같은 전이 뒷부분(예 `create_gate_approval_evidence_if_applicable`)이 DB 오류로 실패하면 승인·step·상태변경은 영구로 남고
나머지는 사라졌다(SLA 자동 승인이면 그 행이 해소돼 다음 cron이 보지 않아 복구도 안 됨).

처방: `send_message_core(after_commit=[...])`는 flush만 하고 커밋 뒤 배달(SSE·ws)을 목록으로 돌려준다 · `publish_preset_event`는
그걸 SAVEPOINT 안에서 부르고, 성공하면 배달(+background task)을 세션 `after_commit`에 예약한다(`app.services.after_commit`).
커밋은 전이를 연 쪽이 한 번.

세팅은 SLA 하네스(create_all · destructive) + 4228 파일의 보정(부분 유니크 인덱스 · 0245 프리셋 정의 시드).
"""
from __future__ import annotations

import os
import uuid
from datetime import timedelta
from unittest.mock import AsyncMock, patch

import pytest

from tests.test_4228_sla_per_item_transaction_realdb import _session
from tests.test_edg_s13_sla_processor import _NOTIFY, _NOW

_REAL_DB_URL = os.getenv("PARITY_TEST_DATABASE_URL") or os.getenv("ALEMBIC_DATABASE_URL")

pytestmark = [
    pytest.mark.destructive_schema,
    pytest.mark.skipif(not _REAL_DB_URL, reason="real Postgres 필요"),
    pytest.mark.anyio,
]

_STATUS_KEY = "preset.work.status_changed"
_VERDICT_KEY = "preset.gate.verdict"


@pytest.fixture
def anyio_backend():
    return "asyncio"


def _load_migration(filename: str):
    import importlib.util
    from pathlib import Path

    path = Path(__file__).resolve().parents[1] / "alembic" / "versions" / filename
    spec = importlib.util.spec_from_file_location(f"_mig_{filename[:4]}", path)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


async def _seed_presets(s, keys: tuple[str, ...]) -> None:
    """실 시드(0245)의 프리셋 정의를 넣는다(destructive 스키마라 마이그레이션 행이 없다). `preset.gate.verdict`의
    payload_schema는 0245 뒤 0330이 마지막으로 바꿨다(`gate_id` 등 — 0245 원본이면 실제 판정 payload가 스키마 위반으로
    발행 자체가 안 된다) → 0330의 `_NEW_PAYLOAD_SCHEMA`를 그대로 쓴다(그 뒤 이 키의 스키마를 바꾼 마이그레이션 없음)."""
    from app.models.event_definition import EventDefinition

    seed = _load_migration("0245_event_definitions.py")._SEED
    latest = {_VERDICT_KEY: _load_migration("0330_preset_gate_verdict_gate_id_field.py")._NEW_PAYLOAD_SCHEMA}
    for key, payload_schema, routing in (row for row in seed if row[0] in keys):
        s.add(EventDefinition(key=key, org_id=None, name=key, payload_schema=latest.get(key, payload_schema), routing=routing))
    await s.flush()


async def _seed_story_gate_with_line(Session) -> dict:
    """스토리 게이트 1개 + 그 게이트에 묶인 라인 step_run(사람 게이트 · SLA 자동 승인 4h · `on_approve.apply_transition`) +
    두 프리셋 정의 + 시스템 발행자. step_run은 5시간 전 시작(SLA 자동 승인 대상). 전부 커밋."""
    from app.models.gate import Gate
    from app.models.organization import Organization
    from app.models.pm import Story
    from app.models.project import Project
    from app.models.workflow_line import WorkflowLineDefinition, WorkflowLineDefinitionVersion, WorkflowLineStepRun
    from tests.test_4090_ac2_recipe_auto_publish_realdb import _seed_system_publisher_teammember_shim

    async with Session() as s:
        org, proj = uuid.uuid4(), uuid.uuid4()
        s.add(Organization(id=org, name="Org4230", slug=f"org4230-{org.hex[:8]}"))
        await s.flush()
        s.add(Project(id=proj, org_id=org, name="p"))
        await s.flush()
        await _seed_presets(s, (_STATUS_KEY, _VERDICT_KEY))
        await _seed_system_publisher_teammember_shim(s, org, proj)
        line = WorkflowLineDefinition(org_id=org, project_id=None, entity_type="story", name="L", is_active=True, version=1)
        s.add(line)
        await s.flush()
        s.add(WorkflowLineDefinitionVersion(
            line_definition_id=line.id, org_id=org, project_id=None, entity_type="story", version=1,
            status="published", config_hash="h", created_by_member_id=uuid.uuid4(),
            config={"steps": [{"from_status": "in-review", "to_status": "done", "step_type": "human-gate",
                               "sla_policy": {"timeout_hours": 4, "on_timeout": "auto_approve"},
                               "on_approve": {"apply_transition": True}}]}))
        # 수신자가 있어야 SSE·ws 배달이 실제로 생긴다(까디르 4597 QA P2 — 예전 픽스처는 수신자 0이라 배달 지연 테스트가
        # 공허했다). 두 프리셋의 broadcast = work_item_stakeholders → 스토리 담당 에이전트.
        from app.models.team import TeamMember

        agent = uuid.uuid4()
        s.add(TeamMember(id=agent, org_id=org, project_id=proj, type="agent", name="담당 에이전트", is_active=True))
        await s.flush()
        story = uuid.uuid4()
        s.add(Story(id=story, org_id=org, project_id=proj, title="S", status="in-review", story_points=3, assignee_id=agent))
        gate = Gate(id=uuid.uuid4(), org_id=org, work_item_id=story, work_item_type="story",
                    gate_type="merge", status="pending")
        s.add(gate)
        await s.flush()
        sr = WorkflowLineStepRun(
            org_id=org, project_id=proj, line_definition_id=line.id, entity_type="story", entity_id=story,
            from_status="in-review", to_status="done", status="gate_pending", mode="gate_pending",
            correlation_id=uuid.uuid4(), transition_id=uuid.uuid4().hex, started_at=_NOW - timedelta(hours=5),
            gate_id=gate.id)
        s.add(sr)
        await s.commit()
        return {"org": org, "story": story, "gate": gate.id, "sr": sr.id, "agent": agent}


async def _state(Session, w) -> dict:
    """새 세션 재조회 — 게이트 · 스토리 · step · 두 프리셋 메시지 수."""
    from sqlalchemy import select, text

    from app.models.gate import Gate
    from app.models.pm import Story
    from app.models.workflow_line import WorkflowLineStepRun

    async with Session() as fresh:
        gate = (await fresh.execute(select(Gate.status).where(Gate.id == w["gate"]))).scalar_one()
        story = (await fresh.execute(select(Story.status).where(Story.id == w["story"]))).scalar_one()
        step = (await fresh.execute(select(WorkflowLineStepRun.status).where(WorkflowLineStepRun.id == w["sr"]))).scalar_one()
        messages = {}
        for key in (_STATUS_KEY, _VERDICT_KEY):
            messages[key] = (await fresh.execute(text(
                "SELECT count(*) FROM conversation_messages "
                "WHERE metadata->'event'->>'event_key' = :k "
                "AND metadata->'event'->'payload'->>'work_item_id' = :w"
            ), {"k": key, "w": str(w["story"])})).scalar_one()
    return {"gate": gate, "story": story, "step": step, "messages": messages}


class _Deliveries:
    """커밋 뒤 배달 기록 — 웹훅 background task(메시지마다 등록) · SSE push · ws 브로드캐스트."""

    def __init__(self, agent_id: uuid.UUID | None = None):
        self.webhooks: list[uuid.UUID] = []
        self.sse: list[str] = []
        self.ws: list[str] = []
        self.agent_id = agent_id

    def patches(self):
        async def _webhook(**kw):
            self.webhooks.append(kw["message_id"])

        async def _broadcast(aid, payload):
            self.ws.append(aid)

        rooms = {str(self.agent_id): object()} if self.agent_id else {}
        return (
            patch("app.services.conversation_webhook.deliver_conversation_message_webhook", _webhook),
            patch("app.routers.conversations._push_to_agent", lambda pid, payload: self.sse.append(pid)),
            patch("app.routers.ws_chat._rooms", rooms),
            patch("app.routers.ws_chat._broadcast", _broadcast),
        )

    def none(self) -> bool:
        return self.webhooks == [] and self.sse == [] and self.ws == []


def _fail_late_in_transition(monkeypatch) -> None:
    """두 훅 발행 **뒤** 같은 전이의 뒷부분(`create_gate_approval_evidence_if_applicable`, gate_service.transition_gate)에서
    실 PG 오류 — 전이 트랜잭션 aborted."""
    import app.services.evidence_service as evidence_service

    async def _broken(session, *a, **kw):
        from sqlalchemy import text

        await session.execute(text("SELECT * FROM no_such_table_4230"))

    monkeypatch.setattr(evidence_service, "create_gate_approval_evidence_if_applicable", _broken)


async def _drain():
    """커밋 뒤 배달은 `pg_pubsub.fire_and_forget`으로 뜬다 — 그 한 원천의 drain으로 기다린다. 배달이 또 태스크를 띄울 수
    있어(pg_notify 등) 빌 때까지 몇 번 돈다."""
    from app.services import pg_pubsub

    for _ in range(5):
        if not pg_pubsub._background_tasks:
            return
        await pg_pubsub.drain_background_tasks()


# ─── AC2 · AC3 — 전이 뒷부분 실패면 승인 · step · 이벤트 메시지 · 배달이 함께 사라진다 ───────────────────────────

async def test_sla_auto_approve_late_pg_error_rolls_back_approval_step_and_event_messages_together(monkeypatch):
    """SLA 자동 승인: 훅 발행 뒤 전이 뒷부분 실 PG 오류 → 항목 error 1 · 새 세션 재조회로 게이트 pending · 스토리
    in-review · step gate_pending · 프리셋 메시지 0 · 배달 0(다음 cron이 다시 처리할 수 있는 상태).
    뮤테이션: 훅 경로에 중간 커밋을 되살리면(`send_message_core`가 커밋) 승인·메시지가 남아 RED."""
    from app.services.workflow_sla_processor import process_sla

    engine, Session = await _session()
    try:
        w = await _seed_story_gate_with_line(Session)
        _fail_late_in_transition(monkeypatch)
        deliveries = _Deliveries(w["agent"])
        p1, p2, p3, p4 = deliveries.patches()
        with p1, p2, p3, p4, patch(_NOTIFY, new=AsyncMock()):
            async with Session() as s:
                counts = await process_sla(s, now=_NOW)
            await _drain()
        assert counts["error"] == 1 and counts["auto_approved"] == 0, counts
        assert await _state(Session, w) == {
            "gate": "pending", "story": "in-review", "step": "gate_pending",
            "messages": {_STATUS_KEY: 0, _VERDICT_KEY: 0},
        }
        assert deliveries.none(), (deliveries.webhooks, deliveries.sse, deliveries.ws)
    finally:
        await engine.dispose()


async def test_human_transition_late_pg_error_rolls_back_approval_step_and_event_messages_together(monkeypatch):
    """사람 전이(`gates.py` 전이 엔드포인트 본체): 같은 주입 → 엔드포인트가 실패하고, 새 세션 재조회로 게이트 pending ·
    스토리 in-review · step gate_pending · 프리셋 메시지 0 · 배달 0."""
    from fastapi import BackgroundTasks

    from app.routers import gates as gates_mod
    from app.routers.gates import GateTransitionRequest, _transition_gate_endpoint
    from app.services.member_resolver import ResolvedMember

    engine, Session = await _session()
    try:
        w = await _seed_story_gate_with_line(Session)
        _fail_late_in_transition(monkeypatch)
        deliveries = _Deliveries(w["agent"])
        approver = ResolvedMember(id=uuid.uuid4(), user_id=uuid.uuid4(), name="h", type="human", role="member", org_id=w["org"])
        p1, p2, p3, p4 = deliveries.patches()
        with p1, p2, p3, p4, patch.object(gates_mod, "resolve_member", AsyncMock(return_value=approver)), \
                patch.object(gates_mod, "_non_doc_gate_approvable", AsyncMock(return_value=True)):
            async with Session() as s:
                bg = BackgroundTasks()
                with pytest.raises(Exception):
                    await _transition_gate_endpoint(
                        resolved_locale="ko", id=w["gate"],
                        body=GateTransitionRequest(status="approved", note="승인", evidence_viewed=True),
                        background_tasks=bg, session=s, org_id=w["org"],
                        auth=type("A", (), {"user_id": str(uuid.uuid4())})(),
                    )
                await s.rollback()
            await _drain()
        assert await _state(Session, w) == {
            "gate": "pending", "story": "in-review", "step": "gate_pending",
            "messages": {_STATUS_KEY: 0, _VERDICT_KEY: 0},
        }
        assert deliveries.none(), (deliveries.webhooks, deliveries.sse, deliveries.ws)
    finally:
        await engine.dispose()


async def test_success_path_commits_once_and_delivers_only_after_the_commit():
    """성공 경로: 전이를 연 쪽의 커밋 한 번으로 승인 · step · 스토리 done · 두 프리셋 메시지가 전부 남고, 웹훅 배달은 그
    커밋 **뒤에** 메시지마다 한 번. 전이 도중(커밋 전)에는 배달 0."""
    from app.services.gate_service import transition_gate

    engine, Session = await _session()
    try:
        w = await _seed_story_gate_with_line(Session)
        deliveries = _Deliveries(w["agent"])
        p1, p2, p3, p4 = deliveries.patches()
        with p1, p2, p3, p4:
            async with Session() as s:
                await transition_gate(s, w["org"], w["gate"], "approved", resolver_id=uuid.uuid4())
                await _drain()
                assert deliveries.none(), f"커밋 전에 배달이 나갔다: {deliveries.webhooks, deliveries.sse, deliveries.ws}"
                await s.commit()
            await _drain()
        state = await _state(Session, w)
        assert state["gate"] == "approved" and state["story"] == "done"
        assert state["messages"] == {_STATUS_KEY: 1, _VERDICT_KEY: 1}, state
        assert len(deliveries.webhooks) == 2, deliveries.webhooks
        # 수신자(담당 에이전트)가 있으니 SSE·ws도 커밋 뒤에 실제로 나간다(P2 — 공허하지 않은 단언)
        assert str(w["agent"]) in deliveries.sse, deliveries.sse
        assert str(w["agent"]) in deliveries.ws, deliveries.ws
    finally:
        await engine.dispose()


async def test_failed_preset_publish_rolls_back_only_its_savepoint(monkeypatch):
    """조건 3 — 발행 자체가 실 PG 오류로 실패하면(SAVEPOINT 안): 그 메시지만 0 · 전이는 커밋(승인 · 스토리 done) · 배달 0.
    (발행은 best-effort — 실패가 전이를 깨지 않는다.)"""
    import app.routers.events as events
    from app.services.gate_service import transition_gate

    real_core = events._publish_registry_event_core

    async def _broken_core(db, *a, **kw):
        from sqlalchemy import text

        await db.execute(text("SELECT * FROM no_such_table_4230_publish"))
        return await real_core(db, *a, **kw)

    monkeypatch.setattr(events, "_publish_registry_event_core", _broken_core)
    engine, Session = await _session()
    try:
        w = await _seed_story_gate_with_line(Session)
        deliveries = _Deliveries(w["agent"])
        p1, p2, p3, p4 = deliveries.patches()
        with p1, p2, p3, p4:
            async with Session() as s:
                await transition_gate(s, w["org"], w["gate"], "approved", resolver_id=uuid.uuid4())
                await s.commit()
            await _drain()
        state = await _state(Session, w)
        assert state["gate"] == "approved" and state["story"] == "done", state
        assert state["messages"] == {_STATUS_KEY: 0, _VERDICT_KEY: 0}, state
        assert deliveries.none(), (deliveries.webhooks, deliveries.sse, deliveries.ws)
    finally:
        await engine.dispose()


# ─── app.services.after_commit ────────────────────────────────────────────────────────────────────────────────

async def test_after_commit_actions_run_only_after_the_outer_commit_and_are_dropped_on_rollback():
    from sqlalchemy import text

    from app.services.after_commit import schedule_after_commit

    engine, Session = await _session()
    try:
        ran: list[str] = []

        async def _async_action():
            ran.append("async")

        async with Session() as s:
            await s.execute(text("SELECT 1"))
            async with s.begin_nested():
                schedule_after_commit(s, [lambda: ran.append("sync"), _async_action])
            assert ran == [], "SAVEPOINT release에서 실행됐다"
            await s.commit()
        await _drain()
        assert sorted(ran) == ["async", "sync"]

        ran.clear()
        async with Session() as s:
            await s.execute(text("SELECT 1"))
            schedule_after_commit(s, [lambda: ran.append("rolled-back")])
            await s.rollback()
            await s.execute(text("SELECT 1"))
            await s.commit()
        await _drain()
        assert ran == []
    finally:
        await engine.dispose()


async def test_after_commit_action_errors_are_only_logged(caplog):
    from sqlalchemy import text

    from app.services.after_commit import schedule_after_commit

    engine, Session = await _session()
    try:
        ran: list[str] = []

        def _boom():
            raise RuntimeError("boom")

        async with Session() as s:
            await s.execute(text("SELECT 1"))
            schedule_after_commit(s, [_boom, lambda: ran.append("next")])
            await s.commit()
        await _drain()
        assert ran == ["next"]
        assert "after-commit action failed" in caplog.text
    finally:
        await engine.dispose()


# ─── 까디르 4597 QA P1 — 형제 SAVEPOINT 롤백이 성공한 쪽 배달을 지우지 않는다 ─────────────────────────────────────

async def test_a_failed_sibling_publish_does_not_erase_the_successful_publishs_deliveries(monkeypatch):
    """한 전이 안에서 판정 알림 발행(성공) → 상태변경 발행(자기 SAVEPOINT에서 실 PG 오류 → 롤백). 전이는 커밋되고, 판정 메시지와
    그 배달(웹훅 · SSE · ws)은 **나간다** · 상태변경 메시지와 배달은 0. 예전엔 SQLAlchemy 2.0이 SAVEPOINT 롤백에도 발화하는
    `after_rollback`에서 예약을 통째로 비워 판정 배달까지 사라졌다(까디르 재현: committed rows=[(1,)] deliveries=[]).
    뮤테이션: `after_rollback` 통째 비우기를 되살리면 RED."""
    import app.routers.events as events
    from app.services.gate_service import transition_gate

    real_core = events._publish_registry_event_core

    async def _status_publish_breaks(db, org_id, auth, definition_key, *a, **kw):
        if definition_key == _STATUS_KEY:
            from sqlalchemy import text

            await db.execute(text("SELECT * FROM no_such_table_4230_sibling"))
        return await real_core(db, org_id, auth, definition_key, *a, **kw)

    monkeypatch.setattr(events, "_publish_registry_event_core", _status_publish_breaks)
    engine, Session = await _session()
    try:
        w = await _seed_story_gate_with_line(Session)
        deliveries = _Deliveries(w["agent"])
        p1, p2, p3, p4 = deliveries.patches()
        with p1, p2, p3, p4:
            async with Session() as s:
                await transition_gate(s, w["org"], w["gate"], "approved", resolver_id=uuid.uuid4())
                await s.commit()
            await _drain()
        state = await _state(Session, w)
        assert state["gate"] == "approved" and state["story"] == "done", state
        assert state["messages"] == {_STATUS_KEY: 0, _VERDICT_KEY: 1}, state
        assert len(deliveries.webhooks) == 1, deliveries.webhooks  # 판정 메시지 하나분
        assert str(w["agent"]) in deliveries.sse and str(w["agent"]) in deliveries.ws, (deliveries.sse, deliveries.ws)
    finally:
        await engine.dispose()


async def test_sibling_savepoints_only_the_rolled_back_ones_reservations_are_dropped():
    """단위 — SAVEPOINT A 예약(release) · SAVEPOINT B 예약(롤백) · 바깥 예약 → 바깥 커밋 뒤 A·바깥만 실행. A 안의 중첩
    SAVEPOINT에서 한 예약은 A가 나중에 롤백되면 같이 버려진다(자손)."""
    from sqlalchemy import text

    from app.services.after_commit import schedule_after_commit

    engine, Session = await _session()
    try:
        ran: list[str] = []
        async with Session() as s:
            await s.execute(text("SELECT 1"))
            schedule_after_commit(s, [lambda: ran.append("outer")])
            async with s.begin_nested():
                schedule_after_commit(s, [lambda: ran.append("A")])
            try:
                async with s.begin_nested():
                    schedule_after_commit(s, [lambda: ran.append("B")])
                    raise RuntimeError("roll back B")
            except RuntimeError:
                pass
            try:
                async with s.begin_nested():
                    async with s.begin_nested():
                        schedule_after_commit(s, [lambda: ran.append("C-inner")])
                    raise RuntimeError("roll back C (after its inner released)")
            except RuntimeError:
                pass
            await s.commit()
        await _drain()
        assert sorted(ran) == ["A", "outer"], ran
    finally:
        await engine.dispose()


async def test_event_seq_wakes_follow_the_same_ownership():
    """event_seq wake 큐도 같은 기전 — 형제 SAVEPOINT 롤백이 다른 wake를 지우지 않고, 롤백된 SAVEPOINT 안의 wake는 유령으로
    나가지 않는다(예전: 통째 비우기 · 또는 롤백된 SAVEPOINT의 wake가 바깥 커밋 때 발화)."""
    from unittest.mock import patch as _patch

    from sqlalchemy import text

    from app.services.event_seq import _schedule_wake_after_commit

    engine, Session = await _session()
    try:
        fired: list[tuple[str, int]] = []
        with _patch("app.routers.agent_gateway.wake_agent", lambda rid, seq: fired.append((rid, seq))):
            async with Session() as s:
                await s.execute(text("SELECT 1"))
                async with s.begin_nested():
                    _schedule_wake_after_commit(s, "agent-kept", 1)
                try:
                    async with s.begin_nested():
                        _schedule_wake_after_commit(s, "agent-ghost", 2)
                        raise RuntimeError
                except RuntimeError:
                    pass
                await s.commit()
        assert fired == [("agent-kept", 1)], fired
    finally:
        await engine.dispose()
