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

from sqlalchemy import event, inspect, select
from sqlalchemy.dialects.postgresql import insert as pg_insert
from sqlalchemy.orm import Session

_ADS_BOOST_GATE_TYPE = "ads_boost"


@event.listens_for(Session, "before_flush")
def _capture_now_when_ads_boost_gate_leaves_approved(session: Session, flush_context, instances) -> None:
    from app.models.gate import Gate

    for obj in list(session.dirty):
        if not isinstance(obj, Gate) or obj.gate_type != _ADS_BOOST_GATE_TYPE or obj.status == "approved":
            continue
        if "approved" not in (inspect(obj).attrs.status.history.deleted or ()):
            continue
        _schedule_capture_now(session, obj)


def _schedule_capture_now(session: Session, gate, *, due_at: datetime | None = None) -> None:
    """A spend capture for this live boost, due now (or at `due_at` — story #4491: the retry after a cancel's failed pause)."""
    from app.models.ads_boost_run import AdsBoostRun
    from app.models.channel_connection import ChannelConnection
    from app.models.insight_snapshot import InsightSnapshot

    conn = session.connection()  # connection-level statements: no autoflush inside the flush
    run = conn.execute(
        select(AdsBoostRun.campaign_id, AdsBoostRun.status, AdsBoostRun.created_connection_id).where(AdsBoostRun.gate_id == gate.id)
    ).first()
    if run is None or not run.campaign_id or run.status != "running" or not gate.scope_key:
        return  # nothing live to stop
    connection_id = run.created_connection_id or gate.sealed_ads_connection_id  # story #4461 — the campaign's own account
    channel = conn.execute(select(ChannelConnection.channel).where(ChannelConnection.id == connection_id)).scalar_one_or_none()
    conn.execute(pg_insert(InsightSnapshot).values(
        id=uuid.uuid4(), org_id=gate.org_id, work_item_id=gate.work_item_id, publication_id=uuid.UUID(gate.scope_key),
        publication_kind="channel_publication", channel=channel or "meta_ads", external_id=None,
        due_at=due_at or datetime.now(timezone.utc), status="pending",
    ).on_conflict_do_nothing(constraint="uq_insight_snapshots_publication_due_at"))
