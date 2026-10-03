"""story #4520 (Didi 4507 live 03:49Z · Yuna 03:52Z / 03:57Z · PO) — the approvals inbox's own signals are not bell lines.

`approval_delivery` writes `conversation.gate_created` · `gate_resolved` · `gate_delegated` · `gate_tossed` Events: «no new
message, a pure SSE signal» that redraws an open approvals inbox (and the reconnect backfill rebuilds them from these rows —
4505). The bell read every Event of the person: each showed as one more unlabelled line and +1 unread — a decision request read
twice next to its `gate.pending_approval`. Now the bell list and the unread count leave the four out; the rows stay.
"""
from __future__ import annotations

import os
import uuid

import pytest

from tests.test_1994_backlink_api_realdb import (
    _client_for,
    _make_conversation,
    _make_human_member,
    _make_org,
    _make_org_owner,
    _make_project,
    _session_factory,
    _setup_app_human,
)

_REAL_DB_URL = os.getenv("PARITY_TEST_DATABASE_URL") or os.getenv("ALEMBIC_DATABASE_URL")

pytestmark = [
    pytest.mark.skipif(not _REAL_DB_URL, reason="통합 테스트는 실 PG(PARITY/ALEMBIC_DATABASE_URL) 필요"),
    pytest.mark.anyio,
]

_SIGNALS = ("conversation.gate_created", "conversation.gate_resolved", "conversation.gate_delegated", "conversation.gate_tossed")


@pytest.fixture
def anyio_backend():
    return "asyncio"


@pytest.fixture(autouse=True)
async def _dispose_global_engine_after_test():
    yield
    from app.core.database import engine as _global_engine

    await _global_engine.dispose()


async def _card(Session, org_id, project_id, sender, approver, gate_id):
    """A chat approval card for the gate, mentioning the approver (what the resolved / tossed signals find their people by)."""
    from app.models.conversation import ConversationMessage

    async with Session() as s:
        conv_id = await _make_conversation(s, org_id, project_id, [sender, approver], sender, conv_type="group")
        s.add(ConversationMessage(id=uuid.uuid4(), conversation_id=conv_id, sender_id=sender, content="결재 카드",
                                  mentioned_ids=[approver], msg_metadata={"approval_target": {"gate_id": str(gate_id)}}))
        await s.commit()
    return conv_id


async def _bell(Session, org_id, user_id):
    from app.main import app

    await _setup_app_human(app, Session, user_id, org_id)
    try:
        async with _client_for(app) as client:
            items = await client.get("/api/v2/event-notifications")
            count = await client.get("/api/v2/event-notifications/unread-count")
    finally:
        app.dependency_overrides.clear()
    assert items.status_code == 200 and count.status_code == 200, (items.text, count.text)
    body = items.json()
    rows = body.get("data", body) if isinstance(body, dict) else body
    c = count.json()
    return rows, (c.get("data") or c)["count"]


async def _signal_rows(Session, member_id, gate_id):
    from sqlalchemy import select

    from app.models.event import Event

    async with Session() as s:
        return sorted((await s.execute(select(Event.event_type).where(
            Event.recipient_id == member_id, Event.source_entity_id == gate_id, Event.event_type.in_(_SIGNALS),
        ))).scalars().all())


async def test_a_decision_request_is_one_bell_line_and_the_inbox_signals_stay_off_the_bell():
    """The approver gets the four signals (a new gate · decided · delegated away · tossed) and the gate's own alert: the bell
    shows the alert alone, the unread count counts it alone — and the four signal rows are still there (the approvals inbox's
    realtime and its reconnect backfill read them)."""
    from app.services.approval_delivery import (
        notify_gate_card_recipients_resolved,
        notify_gate_created_to_recipients,
        notify_gate_delegated_to_old_approver,
        notify_gate_tossed,
    )
    from app.services.notification_dispatch import dispatch_notification

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org = await _make_org(s)
            project = await _make_project(s, org.id)
            requester, _ = await _make_human_member(s, org.id, project.id)
            approver, approver_user = await _make_human_member(s, org.id, project.id)
            other, _ = await _make_human_member(s, org.id, project.id)
        gate_id = uuid.uuid4()
        await _card(Session, org.id, project.id, requester, approver, gate_id)
        tossed_to = await _card(Session, org.id, project.id, requester, approver, gate_id)
        async with Session() as s:
            await notify_gate_created_to_recipients(s, org_id=org.id, project_id=project.id, gate_id=gate_id,
                                                    recipient_ids=[approver])
            await dispatch_notification(s, org_id=org.id, event_type="gate.pending_approval", target_member_ids=[approver],
                                        title="결재 대기 중인 게이트가 있어요", reference_type="gate", reference_id=gate_id,
                                        source_project_id=project.id)
            await notify_gate_card_recipients_resolved(s, org_id=org.id, gate_id=gate_id, status="approved",
                                                       resolver_id=None, resolved_at=None)
            await notify_gate_delegated_to_old_approver(s, org_id=org.id, gate_id=gate_id, old_approver_id=approver,
                                                        new_approver_id=other)
            await notify_gate_tossed(s, org_id=org.id, gate_id=gate_id, target_conversation_id=tossed_to,
                                     tossed_by_id=requester)
            await s.commit()

        assert set(await _signal_rows(Session, approver, gate_id)) == set(_SIGNALS)  # written, as before
        rows, unread = await _bell(Session, org.id, approver_user)
        about_gate = [r for r in rows if r.get("source_entity_id") == str(gate_id)]
        assert [(r["event_type"], (r.get("payload") or {}).get("event_type")) for r in about_gate] == [
            ("dispatched", "gate.pending_approval"),
        ], about_gate  # before: + the four signals
        assert not [r for r in rows if r["event_type"] in _SIGNALS]
        assert unread == len([r for r in rows if not r.get("read_at")])  # the count leaves out what the list leaves out
    finally:
        await engine.dispose()


async def test_each_signal_alone_is_off_the_bell_and_out_of_the_unread_count():
    """One signal at a time against a clean bell: zero lines, zero unread (each type pinned on its own)."""
    from app.services.approval_delivery import notify_gate_created_to_recipients

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org = await _make_org(s)
            project = await _make_project(s, org.id)
            approver, approver_user = await _make_human_member(s, org.id, project.id)
        for kind in _SIGNALS:
            from sqlalchemy import update

            from app.models.event import Event

            gate_id = uuid.uuid4()
            async with Session() as s:
                await notify_gate_created_to_recipients(s, org_id=org.id, project_id=project.id, gate_id=gate_id,
                                                        recipient_ids=[approver])
                await s.execute(update(Event).where(Event.source_entity_id == gate_id).values(event_type=kind))
                await s.commit()
            rows, unread = await _bell(Session, org.id, approver_user)
            assert [r for r in rows if r["event_type"] == kind] == [] and unread == 0, (kind, rows, unread)
    finally:
        await engine.dispose()



async def test_a_decision_requests_bell_line_carries_its_name_and_other_gates_none():
    """AC3b (GREEN-2 live 07:14Z: the bell line read «작업 전달») — a decision request's bell Event carries its question as
    `gate_name` (the bell draws «결재 요청 · {name}»); a gate kind whose name lives on its work item carries none (the line
    reads «결재 요청» alone — no made-up name)."""
    from app.services.gate_service import create_gate

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org = await _make_org(s)
            project = await _make_project(s, org.id)
            owner, owner_user = await _make_org_owner(s, org.id)
        decision_id, review_id = uuid.uuid4(), uuid.uuid4()
        async with Session() as s:
            decision = await create_gate(s, org.id, decision_id, "agent_decision", "agent_decision_request", uuid.uuid4(),
                                         uuid.uuid4(), neutral_facts={"question": "  4520-GREEN-2  ", "options": ["a", "b"]},
                                         project_id=project.id, gate_id=decision_id)
            review = await create_gate(s, org.id, uuid.uuid4(), "story", "pr_review", uuid.uuid4(), uuid.uuid4(),
                                       project_id=project.id, gate_id=review_id)
            assert (decision.status, review.status) == ("pending", "pending")
            await s.commit()

        rows, _unread = await _bell(Session, org.id, owner_user)
        by_gate = {r.get("source_entity_id"): (r.get("payload") or {}) for r in rows}
        assert by_gate[str(decision_id)].get("event_type") == "gate.pending_approval"
        assert by_gate[str(decision_id)].get("gate_name") == "4520-GREEN-2"
        assert "gate_name" not in by_gate[str(review_id)]
    finally:
        await engine.dispose()



async def test_only_a_decision_request_is_named_and_a_long_question_is_cut():
    """Qadir 09:13Z — neutral_facts is free-form on other gates: a «question» there is not a name, so it is never carried; a
    decision request's question is carried cut to GATE_NAME_MAX."""
    from app.services.gate_service import GATE_NAME_MAX, create_gate

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org = await _make_org(s)
            project = await _make_project(s, org.id)
            _owner, owner_user = await _make_org_owner(s, org.id)
        review_id, decision_id = uuid.uuid4(), uuid.uuid4()
        async with Session() as s:
            await create_gate(s, org.id, uuid.uuid4(), "story", "pr_review", uuid.uuid4(), uuid.uuid4(),
                              neutral_facts={"question": "anything the maker wrote"}, project_id=project.id, gate_id=review_id)
            await create_gate(s, org.id, decision_id, "agent_decision", "agent_decision_request", uuid.uuid4(), uuid.uuid4(),
                              neutral_facts={"question": "가" * (GATE_NAME_MAX + 30)}, project_id=project.id, gate_id=decision_id)
            await s.commit()
        rows, _unread = await _bell(Session, org.id, owner_user)
        by_gate = {r.get("source_entity_id"): (r.get("payload") or {}) for r in rows}
        assert "gate_name" not in by_gate[str(review_id)]
        assert by_gate[str(decision_id)]["gate_name"] == "가" * GATE_NAME_MAX
    finally:
        await engine.dispose()
