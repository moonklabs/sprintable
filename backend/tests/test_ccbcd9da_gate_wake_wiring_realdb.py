"""ccbcd9da: 게이트 자동재개 wake 무음 근본 fix — E2E 배선 검증(실 PG).

0f428e1e 그라운딩 근본: doc/epic gate 승인 후 자동재개(_apply_doc_confirmed/_apply_epic_transition
→ dispatch_payload_to_member(commit=False))가 delivery/agent_wake 를 반환하지 않아 gates.py 가 commit
후 wake_agent/webhook 을 스케줄할 방법이 없었다(무음). A-1 은 형제함수 dispatch_entity_to_assignee 와
동형(delivery 반환)으로 맞추고 gates.py commit 지점을 배선한다. A-2 는 두 형제함수의 Event/wake/
notification 로직을 _finalize_dispatch 공통 경로로 수렴(재발 방지).

이 파일은 (a) 실제(비-mock) dispatch_payload_to_member 를 태워 gate_service.transition_gate 가
pending_deliveries 를 정확히 채우는지, (b) gates.py 라우터 엔드포인트가 commit 후 wake_agent/webhook
을 실제로 호출하는지(전엔 무음), (c) A-2 회귀 — human 저자도 이제 dispatch_notification 을 받는지
검증한다.
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


async def _seed_doc_gate_line(s, *, author_type="agent"):
    """org/project/author(agent TeamMember)/doc(draft)/gate(pending)/published line + step_run(gate_pending)."""
    from app.models.doc import Doc
    from app.models.gate import Gate
    from app.models.project import Project
    from app.models.team import TeamMember
    from app.models.workflow_line import (
        WorkflowLineDefinition, WorkflowLineDefinitionVersion, WorkflowLineStepRun,
    )

    org, proj = uuid.uuid4(), uuid.uuid4()
    s.add(Project(id=proj, org_id=org, name="p"))
    await s.flush()

    author = TeamMember(
        id=uuid.uuid4(), org_id=org, project_id=proj, type=author_type,
        name="author", role="member", is_active=True,
    )
    s.add(author)
    await s.flush()

    doc = Doc(org_id=org, project_id=proj, created_by=author.id, title="문서", slug=f"d-{uuid.uuid4().hex[:8]}",
               content="", status="draft")
    s.add(doc)
    await s.flush()

    gate = Gate(org_id=org, work_item_id=doc.id, work_item_type="doc", gate_type="custom_review",
                status="pending")
    s.add(gate)
    await s.flush()

    defn = WorkflowLineDefinition(org_id=org, project_id=proj, entity_type="doc", name="L",
                                   is_active=True, version=1)
    s.add(defn)
    await s.flush()
    s.add(WorkflowLineDefinitionVersion(
        line_definition_id=defn.id, org_id=org, project_id=proj, entity_type="doc", version=1,
        status="published", config_hash="h", created_by_member_id=uuid.uuid4(),
        config={"steps": [{"from_status": "draft", "to_status": "confirmed",
                            "on_approve": {"apply_transition": True}}]},
    ))
    sr = WorkflowLineStepRun(
        org_id=org, project_id=proj, line_definition_id=defn.id, entity_type="doc", entity_id=doc.id,
        from_status="draft", to_status="confirmed", status="gate_pending", mode="enforcing",
        gate_id=gate.id, correlation_id=uuid.uuid4(), transition_id=uuid.uuid4().hex,
    )
    s.add(sr)
    await s.commit()
    return {"org": org, "proj": proj, "author": author.id, "doc": doc.id, "gate": gate.id}


@pytest.mark.skipif(not _REAL_DB_URL, reason="real Postgres 필요")
@pytest.mark.anyio
async def test_transition_gate_real_dispatch_collects_agent_wake_payload():
    """(a) mock 0 — 실제 dispatch_payload_to_member 를 태워 transition_gate 가 pending_deliveries 를
    채우는지 검증(agent 저자 → recipient_seq 확정된 agent_wake)."""
    from app.services.gate_service import transition_gate
    engine, Session = await _session()
    async with Session() as s:
        seeded = await _seed_doc_gate_line(s, author_type="agent")
        approver = uuid.uuid4()
        pending: list = []
        gate = await transition_gate(
            s, seeded["org"], seeded["gate"], "approved", resolver_id=approver,
            pending_deliveries=pending,
        )
        await s.commit()
        assert gate.status == "approved"
        # ⭐핵심: 전엔 이 리스트가 항상 빈 채로 남았다(dispatch_payload_to_member 반환 자체가 없었음).
        assert len(pending) == 1
        payload = pending[0]
        assert payload["agent_wake"] is not None
        assert payload["agent_wake"]["recipient_id"] == str(seeded["author"])
        assert isinstance(payload["agent_wake"]["recipient_seq"], int)
        assert payload["delivery"]["recipient_id"] == seeded["author"]
        assert payload["delivery"]["source_entity_type"] == "doc"

        # doc 이 실제로 confirmed 로 전이됐는지도 side-effect 로 확인.
        from sqlalchemy import text as sa_text
        st = (await s.execute(
            sa_text("SELECT status FROM docs WHERE id=:i"), {"i": seeded["doc"]}
        )).scalar()
        assert st == "confirmed"
    await engine.dispose()


@pytest.mark.skipif(not _REAL_DB_URL, reason="real Postgres 필요")
@pytest.mark.anyio
async def test_transition_gate_endpoint_wakes_after_commit(monkeypatch):
    """(b) gates.py 라우터 E2E — commit 후 wake_agent + deliver_injected_event_webhook(background_tasks)
    가 실제로 호출되는지 검증(전엔 무호출=무음)."""
    from fastapi import BackgroundTasks
    from app.routers import gates as gates_mod
    from app.routers.gates import GateTransitionRequest, transition_gate_endpoint
    from app.services.member_resolver import ResolvedMember
    from unittest.mock import AsyncMock, patch

    engine, Session = await _session()
    try:
        async with Session() as s:
            seeded = await _seed_doc_gate_line(s, author_type="agent")

        woken = {}
        scheduled = {}

        def _fake_wake_agent(recipient_id, recipient_seq):
            woken["recipient_id"] = recipient_id
            woken["recipient_seq"] = recipient_seq

        async def _fake_deliver(**kw):
            scheduled.update(kw)

        approver = ResolvedMember(
            id=uuid.uuid4(), user_id=uuid.uuid4(), name="h", type="human", role="member",
            org_id=seeded["org"],
        )
        async with Session() as s2:
            with patch.object(gates_mod, "resolve_member", AsyncMock(return_value=approver)), \
                 patch.object(gates_mod, "wake_agent", _fake_wake_agent), \
                 patch("app.services.conversation_webhook.deliver_injected_event_webhook", _fake_deliver):
                bg = BackgroundTasks()
                await transition_gate_endpoint(
                    id=seeded["gate"], body=GateTransitionRequest(status="approved"),
                    background_tasks=bg,
                    session=s2, org_id=seeded["org"],
                    auth=type("A", (), {"user_id": str(uuid.uuid4())})(),
                )
                # 라우터는 background_tasks.add_task 로 스케줄만 함 — 테스트에서 직접 실행해 검증.
                for task in bg.tasks:
                    await task()

        assert woken.get("recipient_id") == str(seeded["author"])
        assert scheduled.get("recipient_id") == seeded["author"]
        assert scheduled.get("source_entity_type") == "doc"
    finally:
        await engine.dispose()


@pytest.mark.skipif(not _REAL_DB_URL, reason="real Postgres 필요")
@pytest.mark.anyio
async def test_apply_doc_confirmed_notifies_human_author(monkeypatch):
    """(c) A-2 회귀: human 저자도 dispatch_notification 대상(전엔 dispatch_payload_to_member 가
    non-agent notification 을 아예 호출하지 않아 human 저자는 총 무통지였음)."""
    from app.services.workflow_line_resolution import _apply_doc_confirmed
    import app.services.agent_dispatch as ad
    from app.models.doc import Doc
    from app.models.project import Project
    from app.models.team import TeamMember
    from app.models.workflow_line import WorkflowLineStepRun

    captured = {}

    async def _fake_notify(db, *, org_id, event_type, target_member_ids, title, body, **kw):
        captured["target_member_ids"] = target_member_ids
        captured["event_type"] = event_type

    monkeypatch.setattr(ad, "dispatch_notification", _fake_notify)

    engine, Session = await _session()
    async with Session() as s:
        org, proj = uuid.uuid4(), uuid.uuid4()
        s.add(Project(id=proj, org_id=org, name="p"))
        await s.flush()
        author = TeamMember(id=uuid.uuid4(), org_id=org, project_id=proj, type="human",
                             name="h", role="member", is_active=True)
        s.add(author)
        await s.flush()
        doc = Doc(org_id=org, project_id=proj, created_by=author.id, title="d",
                   slug=f"d-{uuid.uuid4().hex[:8]}", content="", status="draft")
        s.add(doc)
        await s.flush()
        sr = WorkflowLineStepRun(
            org_id=org, project_id=proj, entity_type="doc", entity_id=doc.id,
            from_status="draft", to_status="confirmed", status="gate_pending", mode="enforcing",
            correlation_id=uuid.uuid4(), transition_id=uuid.uuid4().hex,
        )
        s.add(sr)
        await s.flush()
        wake_payload = await _apply_doc_confirmed(s, sr, resolver_id=uuid.uuid4())
        await s.commit()
        assert sr.status == "applied"
        # ⭐A-2 핵심: human 저자 → dispatch_notification 실제 호출(전엔 미호출).
        assert captured.get("target_member_ids") == [author.id]
        assert captured.get("event_type") == "dispatched"
        # human 은 wake_agent 대상이 아니므로 agent_wake=None 이 정상(webhook/notification 만 대상).
        assert wake_payload is not None
        assert wake_payload["agent_wake"] is None
    await engine.dispose()
