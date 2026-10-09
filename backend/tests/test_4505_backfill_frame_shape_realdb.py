"""story #4505 (Mirko live 00:51Z · PO 01:06Z) — a backfill frame carries the live frame's keys at the top level.

A live frame is the pushed dict (payload keys top-level: `gate_id`, `status` …); a backfill frame was `_event_to_payload`, with
them only under `payload`. The approvals inbox and the chat approval card read the live shape (`payload.gate_id`), so a gate
event that came by backfill — created before the stream opened, or in a reconnect gap — was dropped until reload. The events
here are made by the real notify functions; every key their live push carries is in the backfill frame with the same value.
"""
from __future__ import annotations

import os
import uuid

import pytest

from tests.test_4500_recipient_org_scope_realdb import _conversation, _two_orgs

_REAL_DB_URL = os.getenv("PARITY_TEST_DATABASE_URL") or os.getenv("ALEMBIC_DATABASE_URL")

pytestmark = [
    pytest.mark.destructive_schema,  # the seeds write team_members (a table in the destructive schema, a view when migrated)
    pytest.mark.skipif(not _REAL_DB_URL, reason="real Postgres 필요"),
    pytest.mark.anyio,
]

# keys a live push adds that are about the delivery, not the event — the subscriber is the recipient; a backfill frame has
# its own id / cursor fields
_DELIVERY_ONLY = {"recipient_id", "recipient_seq", "_sse_transient_id"}


@pytest.fixture
def anyio_backend():
    return "asyncio"


@pytest.fixture(autouse=True)
async def _dispose_global_engine_after_test():
    yield
    from app.core.database import engine as _global_engine

    await _global_engine.dispose()


async def _frames(Session, pushes):
    """(live payload, backfill frame) for each push — the backfill frame built from the Event row the push announced."""
    from app.models.event import Event
    from app.routers.events import _backfill_frame_data

    out = []
    async with Session() as s:
        for _pid, live in pushes:
            evt = await s.get(Event, uuid.UUID(live["event_id"]))
            out.append((live, _backfill_frame_data(evt)))
    return out


def _assert_live_keys_in_backfill(live: dict, frame: dict):
    for k, v in live.items():
        if k in _DELIVERY_ONLY:
            continue
        assert k in frame, f"backfill frame lacks the live key {k!r}: {sorted(frame)}"
        assert frame[k] == v, (k, frame[k], v)


async def _card(Session, w, gate_id, mentioned):
    from app.models.conversation import ConversationMessage

    conv_id, _ = await _conversation(Session, w)
    async with Session() as s:
        s.add(ConversationMessage(id=uuid.uuid4(), conversation_id=conv_id, sender_id=w.own, content="카드",
                                  mentioned_ids=mentioned, msg_metadata={"approval_target": {"gate_id": str(gate_id)}}))
        await s.commit()
    return conv_id


async def test_gate_resolved_and_delegated_backfill_frames_carry_the_live_keys():
    from app.services.approval_delivery import notify_gate_card_recipients_resolved, notify_gate_delegated_to_old_approver

    engine, Session, w = await _two_orgs()
    try:
        gate_id = uuid.uuid4()
        await _card(Session, w, gate_id, [w.own])
        async with Session() as s:
            resolved = await notify_gate_card_recipients_resolved(
                s, org_id=w.org_a, gate_id=gate_id, status="approved", resolver_id=None, resolved_at=None,
            )
            delegated = await notify_gate_delegated_to_old_approver(
                s, org_id=w.org_a, gate_id=gate_id, old_approver_id=w.own, new_approver_id=uuid.uuid4(),
            )
            await s.commit()
        assert resolved and delegated
        for live, frame in await _frames(Session, resolved + delegated):
            _assert_live_keys_in_backfill(live, frame)
            assert frame["gate_id"] == str(gate_id)
        [(_, resolved_frame)] = await _frames(Session, resolved)
        assert resolved_frame["status"] == "approved"  # the inbox reads status at the top level too
    finally:
        await engine.dispose()


async def test_gate_created_backfill_frame_has_gate_id_at_the_top_level():
    from sqlalchemy import select

    from app.models.event import Event
    from app.routers.events import _backfill_frame_data
    from app.services.approval_delivery import notify_gate_created_to_recipients

    engine, Session, w = await _two_orgs()
    try:
        gate_id = uuid.uuid4()
        async with Session() as s:
            await notify_gate_created_to_recipients(s, org_id=w.org_a, project_id=w.project_a, gate_id=gate_id,
                                                    recipient_ids=[w.own])
            await s.commit()
        async with Session() as s:
            evt = (await s.execute(select(Event).where(
                Event.source_entity_id == gate_id, Event.event_type == "conversation.gate_created",
            ))).scalar_one()
        frame = _backfill_frame_data(evt)
        # the live push for it is {"event_id", "event_type", "gate_id", "recipient_id"} (approval_delivery._schedule_…)
        _assert_live_keys_in_backfill(
            {"event_id": str(evt.id), "event_type": "conversation.gate_created", "gate_id": str(gate_id), "recipient_id": str(w.own)},
            frame,
        )
    finally:
        await engine.dispose()


def test_a_payload_key_never_overwrites_a_frame_key():
    """The frame's own top-level keys win over a payload key of the same name (event_id · event_type · source · content …)."""
    from datetime import datetime, timezone

    from app.models.event import Event
    from app.routers.events import _backfill_frame_data

    evt = Event(
        id=uuid.uuid4(), org_id=uuid.uuid4(), project_id=uuid.uuid4(), event_type="conversation.gate_created",
        source_entity_type="gate", source_entity_id=uuid.uuid4(), recipient_id=uuid.uuid4(), recipient_type="human",
        payload={"gate_id": "g", "event_id": "not-this", "event_type": "not-this", "source": "not-this", "created_at": "x"},
        status="pending", created_at=datetime.now(timezone.utc),
    )
    frame = _backfill_frame_data(evt)
    assert frame["gate_id"] == "g"
    assert frame["event_id"] == str(evt.id) and frame["event_type"] == "conversation.gate_created"
    assert frame["source"] == {"type": "gate", "id": str(evt.source_entity_id)} and frame["created_at"] != "x"


def test_the_stream_builds_its_backfill_frames_with_the_live_shape():
    """The wiring: the stream's backfill batch goes through _backfill_frame_data (the old builder had the payload keys only
    under `payload`). A source pin, as test_2101 pins the backfill filter of the same generator — the frames above are built
    by the same function the stream calls."""
    import inspect

    from app.routers import events as ev_module

    source = inspect.getsource(ev_module.agent_event_stream)
    # story 4649: the stream passes its own org (the frame's stream_org_id) — same builder, same shape
    assert "_backfill_frame_data(evt, org_id) for evt in batch" in source
    assert "_event_to_payload(evt) for evt in batch" not in source
