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
from datetime import datetime, timedelta, timezone

from sqlalchemy import func, select
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
    """Qadir 02:22Z ⓐ · 04:29Z (PO (가)) — after a command of a cancelled boost ended, a campaign that is not known to be off gets a
    pause: «pending» with ids (an ACTIVE switch whose answer was lost) and «running» (a start or resume whose ACTIVE went out after
    the cancel committed, right past the worker's last check) alike — one place for every path that ends a command with the
    campaign on, not a check after each ACTIVE call. Asked only when the cycle's latest toggle is not already a pause (a person's
    [중지], or this hook's own earlier pause — one that then fails is not asked again here: 4417's retry rules and a person's press
    carry it; asking after every command would loop). The scheduler's pause, attributed to the person who cancelled."""
    from app.models.ads_boost_run import AdsBoostRun
    from app.services.ads_boost_execution import OP_PAUSE, _latest_toggle, request_ads_boost_pause

    run = (await db.execute(select(AdsBoostRun).where(AdsBoostRun.gate_id == gate_id))).scalar_one_or_none()
    if (
        run is None or run.cancel_requested_at is None or run.status not in ("pending", "running") or run.campaign_id is None
        or run.cancel_requested_by is None or await _command_out(db, gate_id=gate_id)
    ):
        return False
    latest = await _latest_toggle(db, gate_id=gate_id, cycle=run.cycle_no)
    if latest is not None and latest.operation == OP_PAUSE:
        return False
    await request_ads_boost_pause(
        db, org_id=run.org_id, gate_id=gate_id, requester_member_id=run.cancel_requested_by, initiated_by="scheduler",
    )
    return True


# story #4491 (PO 06:26Z) — a cancel's pause that failed at the provider (dead_letter): the spend capture is scheduled again after
# these delays (by how many of the cycle's pauses have failed); past them, the regular daily capture and a person in Ads Manager
CANCEL_PAUSE_RETRY_DELAYS = (timedelta(minutes=5), timedelta(minutes=20), timedelta(minutes=80))


async def _failed_pauses_this_cycle(db: AsyncSession, *, gate_id: uuid.UUID, cycle: int) -> int:
    from app.models.publication_command import PublicationCommand
    from app.services.ads_boost_execution import OP_PAUSE, in_ads_boost_cycle

    return (await db.execute(
        select(func.count()).select_from(PublicationCommand).where(
            PublicationCommand.gate_id == gate_id, PublicationCommand.operation == OP_PAUSE,
            PublicationCommand.status == "dead_letter", in_ads_boost_cycle(cycle),
        )
    )).scalar_one()


async def schedule_capture_after_failed_cancel_pause(db: AsyncSession, *, command, now: datetime) -> bool:
    """story #4491 (Qadir 05:25Z · PO 06:26Z) — a cancelled boost whose pause ended dead_letter at the provider: nothing retried it
    (a dead_letter has no next attempt · the cancel's hook asks once · 4466's capture-now needed the run live at the cancel), so
    the campaign ran until the next daily capture — or never, past the boost's end. Here the gate is voided, so a spend capture
    makes the scheduler pause it again (`_pause_if_off_approved` · 4417's «a failed pause makes a new one»). Scheduled 5 · 20 ·
    80 minutes after the 1st · 2nd · 3rd failed pause of the cycle (`_schedule_capture_now` with a due time — the 4466 row);
    after the third, nothing more here: the daily captures and the card («광고 관리자에서 직접 멈춰 주세요»). A new cycle counts
    from zero. For a run «running», or «pending» with a campaign (the ACTIVE answer lost — PO 06:34Z: treated as on)."""
    from app.models.ads_boost_run import AdsBoostRun
    from app.services.ads_boost_execution import OP_PAUSE
    from app.services.ads_boost_gate_exit import _schedule_capture_now

    if command.operation != OP_PAUSE or command.status != "dead_letter":
        return False
    run = (await db.execute(select(AdsBoostRun).where(AdsBoostRun.gate_id == command.gate_id))).scalar_one_or_none()
    if (
        run is None or run.cancel_requested_at is None or run.status not in ("running", "pending") or run.campaign_id is None
        or (command.ads_boost_cycle or 1) != run.cycle_no
    ):
        return False  # «pending» with ids under a cancel = not known to be off, as live as «running» (PO 06:34Z)
    failed = await _failed_pauses_this_cycle(db, gate_id=command.gate_id, cycle=run.cycle_no)
    if failed < 1 or failed > len(CANCEL_PAUSE_RETRY_DELAYS):
        return False
    gate = (await db.execute(select(Gate).where(Gate.id == command.gate_id))).scalar_one()
    due_at = now + CANCEL_PAUSE_RETRY_DELAYS[failed - 1]
    await db.run_sync(lambda session: _schedule_capture_now(session, gate, due_at=due_at))
    await db.commit()
    return True


async def cancel_pause_retry_state(db: AsyncSession, *, run) -> str | None:
    """story #4491 (Yuna 06:27Z) — what the card says under «취소 중» when the cycle's latest pause failed at the provider:
    «scheduled» (the server will try again — a capture is due) · «exhausted» (no automatic try left: a person in Ads Manager).
    None otherwise (no cancel · no failed pause · a pause in flight)."""
    from app.services.ads_boost_execution import OP_PAUSE, _latest_toggle

    if run is None or run.cancel_requested_at is None:
        return None
    latest = await _latest_toggle(db, gate_id=run.gate_id, cycle=run.cycle_no)
    if latest is None or latest.operation != OP_PAUSE or latest.status != "dead_letter":
        return None
    # story #4495 (Qadir 07:53Z ②) — «scheduled» only when a paid capture is really waiting for this post (the retry the server
    # will make), not inferred from how many pauses failed: a capture that was never written (an error · a condition not met)
    # would have made the card promise a retry that is not coming
    from app.models.insight_snapshot import InsightSnapshot
    from app.services.ads_spend_snapshots import _PAID_CHANNELS

    gate = (await db.execute(select(Gate).where(Gate.id == run.gate_id))).scalar_one_or_none()
    waiting = None
    if gate is not None and gate.scope_key:
        # within the retry window (the longest delay): the boost's regular daily capture, a day out, is not the retry — with one
        # waiting capture per post (④) a written retry is always the earliest one, brought forward
        horizon = datetime.now(timezone.utc) + CANCEL_PAUSE_RETRY_DELAYS[-1] + timedelta(minutes=1)
        waiting = (await db.execute(
            select(InsightSnapshot.id).where(
                InsightSnapshot.publication_id == uuid.UUID(gate.scope_key), InsightSnapshot.status == "pending",
                InsightSnapshot.channel.in_(_PAID_CHANNELS), InsightSnapshot.due_at <= horizon,
            ).limit(1)
        )).scalar_one_or_none()
    # …and only within the three retries: past them the regular daily capture still waits, but that is not the retry promised
    failed = await _failed_pauses_this_cycle(db, gate_id=run.gate_id, cycle=run.cycle_no)
    live = run.status in ("running", "pending") and run.campaign_id is not None
    return "scheduled" if live and waiting is not None and failed <= len(CANCEL_PAUSE_RETRY_DELAYS) else "exhausted"


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
