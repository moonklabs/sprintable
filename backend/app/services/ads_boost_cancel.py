"""story #4460 — a person cancels a boost; the next request for the same post starts a new cycle with a new campaign.

PO 10:56Z · 16:30Z · 16:32Z. A post has one ads_boost gate (0328 slot) and a gate one run, so a cancel resets them in place:

1. The gate is voided the moment the cancel is asked for — an explicit ads_boost cancel transition (`void_ads_boost_gate_for_cancel`
   · who and why on the gate). 4466's rules then stop the money: start/resume are refused, queued start/resume commands are voided
   (a queued pause is kept), a live campaign is paused.
2. The run is marked «취소 중» (`cancel_requested_at`) and keeps every campaign id: an emptied run could neither stop nor read a live
   campaign. A running campaign gets its pause right away.
3. Only once the campaign is known to be off — the run paused, or never switched on, and no command of the gate still out — the
   cycle that ended is kept as a row (`ads_boost_run_cycles`: campaign · created values · spend) and the run is cleared
   (`finish_cancel_if_stopped`, called where the cancel is asked and after every boost command the worker finishes — the
   moments the campaign's state can become known).
4. A request for the same post then reopens the gate as a fresh cycle (`ads_boost.request_ads_boost`); its start makes a new campaign.

The requester (`gate.requested_by_member_id`) or an owner/admin may cancel; gates made before that column: owner/admin only.
The provider's old campaign stays paused there (no archive call — noted).
"""
from __future__ import annotations

import logging
import uuid
from datetime import datetime, timezone

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.gate import Gate

logger = logging.getLogger(__name__)

_ADS_BOOST_GATE_TYPE = "ads_boost"
CANCEL_VOID_REASON_CODE = "ADS_BOOST_CANCELLED"
# the gate's commands that may still reach the provider — while one is out, the campaign's state is not known yet
_OUT_STATUSES = ("pending", "in_progress", "blocked")


class AdsBoostCancelNotFoundError(Exception):
    def __init__(self, gate_id: uuid.UUID):
        self.gate_id = gate_id
        super().__init__(f"ads_boost gate not found: {gate_id}")


class AdsBoostCancelForbiddenError(Exception):
    def __init__(self, gate_id: uuid.UUID):
        self.gate_id = gate_id
        super().__init__(f"only the requester or an owner/admin may cancel this boost: {gate_id}")


class AdsBoostAlreadyCancelledError(Exception):
    def __init__(self, gate_id: uuid.UUID):
        self.gate_id = gate_id
        super().__init__(f"ads_boost already cancelled: {gate_id}")


class AdsBoostCancelInProgressError(Exception):
    """A new request for the post while its cancel has not finished (the old campaign is not known to be off yet)."""

    def __init__(self, gate_id: uuid.UUID):
        self.gate_id = gate_id
        super().__init__(f"ads_boost cancel still in progress: {gate_id}")


async def cancel_ads_boost(
    db: AsyncSession, *, org_id: uuid.UUID, gate_id: uuid.UUID, actor_member_id: uuid.UUID, actor_is_admin: bool,
    reason: str | None,
) -> dict:
    from app.models.ads_boost_run import AdsBoostRun
    from app.services.gate_service import void_ads_boost_gate_for_cancel
    from app.services.publication_command import void_pending_commands_for_gate

    gate = (await db.execute(select(Gate).where(Gate.id == gate_id).with_for_update())).scalar_one_or_none()
    if gate is None or gate.org_id != org_id or gate.gate_type != _ADS_BOOST_GATE_TYPE:
        raise AdsBoostCancelNotFoundError(gate_id)
    if not actor_is_admin and (gate.requested_by_member_id is None or gate.requested_by_member_id != actor_member_id):
        raise AdsBoostCancelForbiddenError(gate_id)
    run = (await db.execute(select(AdsBoostRun).where(AdsBoostRun.gate_id == gate_id).with_for_update())).scalar_one_or_none()
    if gate.status == "voided":
        if run is not None and run.cancel_requested_at is not None:
            return {"state": "cancelling"}
        raise AdsBoostAlreadyCancelledError(gate_id)

    now = datetime.now(timezone.utc)
    void_ads_boost_gate_for_cancel(gate, actor_member_id=actor_member_id, reason=reason, now=now)
    await void_pending_commands_for_gate(db, gate_id=gate.id, reason_code=CANCEL_VOID_REASON_CODE)  # a queued pause stays (4466)
    await _void_blocked_starts(db, gate_id=gate.id)
    from app.services.activity_log import ActivityLogService

    await ActivityLogService(db).record(
        org_id=org_id, action="ads_boost_cancelled", actor_id=actor_member_id, actor_type="human",
        entity_type="gate", entity_id=gate.id, context={"reason": reason} if reason else {},
    )
    if run is None or not (
        run.campaign_id or run.adset_id or run.ad_id or run.create_call_started_at or await _command_out(db, gate_id=gate.id)
    ):
        if run is not None:
            _reset_run(run)
        await db.commit()
        return {"state": "cancelled"}
    run.cancel_requested_at = now
    run.cancel_requested_by = actor_member_id
    run.cancel_reason = reason
    # story #4460 (Qadir 02:22Z ⓐ) — a campaign is live, or was made and never confirmed off (a start whose ACTIVE switch went out
    # and then failed: its outcome is unknown, the run still «pending»): pause it before anything is cleared. While a command of
    # the gate is still out, the worker's hook asks once it ended (`pause_left_campaign_for_cancel`).
    live = run.status == "running" or (
        run.status == "pending" and run.campaign_id is not None and not await _command_out(db, gate_id=gate.id)
    )
    await db.commit()
    if live:
        from app.services.ads_boost_execution import AdsBoostAlreadyInStateError, request_ads_boost_pause

        try:
            await request_ads_boost_pause(db, org_id=org_id, gate_id=gate_id, requester_member_id=actor_member_id)
        except AdsBoostAlreadyInStateError:
            pass  # a pause is already queued or done
        except Exception:
            # PO 00:40Z (Qadir lens ①) — the cancel is already committed (gate voided · run «취소 중»), so a failed fast pause must
            # not answer 500: the person would read «failed» while the cancel stands. The money is still stopped — the gate left
            # approved, so 4466's hook (ads_boost_gate_exit) queued a capture due now and the scheduler pauses the campaign there.
            logger.exception(
                "ads_boost cancel: the person's pause request failed after the cancel was committed — the scheduler's pause stops it",
                extra={"code": "ADS_BOOST_CANCEL_PAUSE_REQUEST_FAILED", "gate_id": str(gate_id)},
            )
            await db.rollback()
            return {"state": "cancelling"}
    finished = await finish_cancel_if_stopped(db, gate_id=gate_id, now=now)
    await db.commit()
    return {"state": "cancelled" if finished else "cancelling"}


async def finish_cancel_if_stopped(db: AsyncSession, *, gate_id: uuid.UUID, now: datetime | None = None) -> bool:
    """The one place a cancel finishes: only when the campaign is known to be off — the run paused or never switched on, and no
    command of the gate still out — the ended cycle is kept and the run cleared. Otherwise nothing changes («취소 중»)."""
    from app.models.ads_boost_run import AdsBoostRun, AdsBoostRunCycle
    from app.services.ads_spend_snapshots import _captured_spend_minor_for_gate

    now = now or datetime.now(timezone.utc)
    run = (await db.execute(select(AdsBoostRun).where(AdsBoostRun.gate_id == gate_id).with_for_update())).scalar_one_or_none()
    if run is None or run.cancel_requested_at is None:
        return False
    if run.status not in ("pending", "paused"):
        return False  # running · pause_pending: the money may still be going out
    if run.status == "pending" and run.campaign_id is not None:
        # Qadir 02:22Z ⓐ — a campaign that was made but never confirmed off (the ACTIVE switch's outcome unknown) may be spending:
        # only a landed pause («paused») lets the cycle end and its ids go
        return False
    if await _command_out(db, gate_id=gate_id):
        return False  # a command may still reach the provider: wait for its outcome
    gate = (await db.execute(select(Gate).where(Gate.id == gate_id))).scalar_one()
    spend = None
    if gate.scope_key:
        spend = await _captured_spend_minor_for_gate(
            db, org_id=gate.org_id, publication_id=uuid.UUID(gate.scope_key), cycle=run.cycle_no,
        )
    db.add(AdsBoostRunCycle(
        id=uuid.uuid4(), org_id=run.org_id, gate_id=gate_id, run_id=run.id,
        campaign_id=run.campaign_id, adset_id=run.adset_id, ad_id=run.ad_id,
        created_budget_minor=run.created_budget_minor, created_for_version_id=run.created_for_version_id,
        created_connection_id=run.created_connection_id, currency=gate.sealed_ads_currency, spend_minor=spend,
        started_at=run.cycle_started_at or run.started_at or run.created_at, ended_at=now,
        end_reason="cancelled", ended_by_member_id=run.cancel_requested_by,
    ))
    _reset_run(run)
    await db.flush()
    return True


async def _command_out(db: AsyncSession, *, gate_id: uuid.UUID) -> bool:
    """A command of the gate may still reach the provider (pending · in progress · stopped for a person)."""
    from app.models.publication_command import PublicationCommand

    return (await db.execute(
        select(PublicationCommand.id).where(
            PublicationCommand.gate_id == gate_id, PublicationCommand.status.in_(_OUT_STATUSES),
        ).limit(1)
    )).scalar_one_or_none() is not None


async def _void_blocked_starts(db: AsyncSession, *, gate_id: uuid.UUID) -> None:
    """Qadir 02:22Z ⓑ — a start or resume stopped for a person (blocked: the connection · an org pause) counted as «out» and the
    cancel waited on it forever; the gate is voided, so it could never switch anything on — void it with the cancel. A blocked
    pause stays: it stops money (4466 · 4476 re-raise it once the connection is back)."""
    from app.models.publication_command import PublicationCommand
    from app.services.ads_boost_execution import OP_BOOST_START, OP_RESUME

    for row in (await db.execute(
        select(PublicationCommand).where(
            PublicationCommand.gate_id == gate_id, PublicationCommand.status == "blocked",
            PublicationCommand.operation.in_((OP_BOOST_START, OP_RESUME)),
        ).with_for_update()
    )).scalars().all():
        row.status = "voided"
        row.reason_code = CANCEL_VOID_REASON_CODE


async def pause_left_campaign_for_cancel(db: AsyncSession, *, gate_id: uuid.UUID) -> bool:
    """Qadir 02:22Z ⓐ — after a command of a cancelled boost ended: a campaign that exists and was never confirmed off (run
    «pending» with ids) gets a pause, once per cycle — a pause that then fails is not asked again here (4417's retry rules and a
    person's press carry it; asking at every command would loop). The scheduler's pause, attributed to the person who cancelled."""
    from app.models.ads_boost_run import AdsBoostRun
    from app.models.publication_command import PublicationCommand
    from app.services.ads_boost_execution import OP_PAUSE, in_ads_boost_cycle, request_ads_boost_pause

    run = (await db.execute(select(AdsBoostRun).where(AdsBoostRun.gate_id == gate_id))).scalar_one_or_none()
    if (
        run is None or run.cancel_requested_at is None or run.status != "pending" or run.campaign_id is None
        or run.cancel_requested_by is None or await _command_out(db, gate_id=gate_id)
    ):
        return False
    asked = (await db.execute(
        select(PublicationCommand.id).where(
            PublicationCommand.gate_id == gate_id, PublicationCommand.operation == OP_PAUSE, in_ads_boost_cycle(run.cycle_no),
        ).limit(1)
    )).scalar_one_or_none()
    if asked is not None:
        return False
    await request_ads_boost_pause(
        db, org_id=run.org_id, gate_id=gate_id, requester_member_id=run.cancel_requested_by, initiated_by="scheduler",
    )
    return True


def _reset_run(run) -> None:
    """The run made ready for the next cycle (its ended cycle is kept as a row first) — its cycle number goes up, so the ended
    cycle's commands and captures are no longer this run's (Qadir 02:22Z)."""
    for field in (
        "campaign_id", "adset_id", "ad_id", "started_at", "paused_at", "cap_reached_at", "last_error",
        "spend_blocked_at", "spend_blocked_code", "spend_blocked_notified_at", "account_currency",
        "created_budget_minor", "created_for_version_id", "created_connection_id", "create_claimed_at",
        "create_call_started_at", "cancel_requested_at", "cancel_requested_by", "cancel_reason",
    ):
        setattr(run, field, None)
    run.status = "pending"
    run.cycle_no = (run.cycle_no or 1) + 1
