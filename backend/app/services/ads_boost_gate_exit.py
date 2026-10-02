"""story #4466 (PO 11:51Z · (다)) — the one place that notices an ads_boost gate leaving «approved».

A live boost must not keep spending on values nobody approves any more. However the gate leaves approved — the same post's boost
requested again (pending re-review), the approval undone, any later path — this hook sees the status change in the session before
it is written and schedules a spend capture for that boost, due now. The capture worker then pauses the live campaign
(`ads_spend_snapshots._pause_if_off_approved`, the scheduler's one pause path) and goes on checking it at every capture, so a path
that bypasses the ORM is still caught at the next regular capture. Nothing here calls a provider or queues the pause itself: a
flush cannot run the async pause request, and a second pause path would drift from the first.

Registered by importing this module from `app.models.gate` (every writer of a gate's status imports the model).
"""
from __future__ import annotations

import uuid
from datetime import datetime, timezone

from sqlalchemy import event, inspect, select, update
from sqlalchemy.dialects.postgresql import insert as pg_insert
from sqlalchemy.orm import Session

_ADS_BOOST_GATE_TYPE = "ads_boost"


@event.listens_for(Session, "before_flush")
def _capture_now_when_ads_boost_gate_leaves_approved(session: Session, flush_context, instances) -> None:
    from app.models.ads_boost_run import AdsBoostRun
    from app.models.gate import Gate

    for obj in list(session.dirty):
        if isinstance(obj, Gate):
            if obj.gate_type != _ADS_BOOST_GATE_TYPE or obj.status == "approved":
                continue
            if "approved" not in (inspect(obj).attrs.status.history.deleted or ()):
                continue
            _schedule_capture_now(session, obj)
        elif isinstance(obj, AdsBoostRun) and obj.cancel_requested_at is not None:
            # story #4495 (Qadir 07:53Z ③) — a cancel marks the run in the same transaction as it voids the gate, but after the
            # gate's flush (the next query's autoflush): the gate's leave was seen while the run still read «not cancelled», so a
            # «pending» run with a campaign got no capture. The run's own mark is the second trigger — order no longer matters.
            hist = inspect(obj).attrs.cancel_requested_at.history
            if not hist.added or any(v is not None for v in (hist.deleted or ())):
                continue  # only the moment the mark is set (it was empty before)
            gate = session.connection().execute(select(Gate).where(Gate.id == obj.gate_id)).first()
            if gate is not None and gate.gate_type == _ADS_BOOST_GATE_TYPE and gate.status != "approved":
                _schedule_capture_now(session, gate)


def _in_session_run(session: Session, gate_id):
    """The gate's run as this session holds it (values not flushed yet win over the database's)."""
    from app.models.ads_boost_run import AdsBoostRun

    for obj in list(session.identity_map.values()):
        if isinstance(obj, AdsBoostRun) and obj.gate_id == gate_id:
            return obj
    return None


def _schedule_capture_now(session: Session, gate, *, due_at: datetime | None = None) -> None:
    """A spend capture for this live boost, due now (or at `due_at` — story #4491: the retry after a cancel's failed pause).
    story #4495 (④) — one waiting paid capture per post: when one is already waiting, the earliest is brought forward to `due_at`
    (or now) instead of adding a row next to it (the daily chain then runs from that earlier capture: spend is checked sooner)."""
    from app.models.ads_boost_run import AdsBoostRun
    from app.models.channel_connection import ChannelConnection
    from app.models.insight_snapshot import InsightSnapshot
    from app.services.ads_spend_snapshots import _PAID_CHANNELS

    conn = session.connection()  # connection-level statements: no autoflush inside the flush
    run = _in_session_run(session, gate.id) or conn.execute(
        select(
            AdsBoostRun.campaign_id, AdsBoostRun.status, AdsBoostRun.created_connection_id, AdsBoostRun.cancel_requested_at,
        ).where(AdsBoostRun.gate_id == gate.id)
    ).first()
    # live = running · or, under a cancel, «pending» with a campaign (its ACTIVE answer was lost — story #4491)
    live = run is not None and (run.status == "running" or (run.status == "pending" and run.cancel_requested_at is not None))
    if not live or not run.campaign_id or not gate.scope_key:
        return  # nothing live to stop
    due = due_at or datetime.now(timezone.utc)
    publication_id = uuid.UUID(gate.scope_key)
    waiting = conn.execute(
        select(InsightSnapshot.id, InsightSnapshot.due_at).where(
            InsightSnapshot.publication_id == publication_id, InsightSnapshot.status == "pending",
            InsightSnapshot.channel.in_(_PAID_CHANNELS),
        ).order_by(InsightSnapshot.due_at).limit(1)
    ).first()
    if waiting is not None:
        if due < waiting.due_at:
            conn.execute(update(InsightSnapshot).where(InsightSnapshot.id == waiting.id).values(due_at=due))
        return
    connection_id = run.created_connection_id or gate.sealed_ads_connection_id  # story #4461 — the campaign's own account
    channel = conn.execute(select(ChannelConnection.channel).where(ChannelConnection.id == connection_id)).scalar_one_or_none()
    conn.execute(pg_insert(InsightSnapshot).values(
        id=uuid.uuid4(), org_id=gate.org_id, work_item_id=gate.work_item_id, publication_id=publication_id,
        publication_kind="channel_publication", channel=channel or "meta_ads", external_id=None,
        due_at=due, status="pending",
    ).on_conflict_do_nothing(constraint="uq_insight_snapshots_publication_due_at"))
