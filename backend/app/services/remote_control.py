"""story #4535 (E-DESKTOP-2 B-4 · AC1) — an organization's «원격 제어» switch. Contract 02d2cf71 §2 (v1.5).

Off by default; only an owner turns it on or off. While off the device line is off as a whole (PO 08:55Z ⓐ): every relay call
is refused with **409** `remote_control_off` (routers/desktop_relay.py — the device token stays valid), an open relay stream ends
with its own `event: remote_control_off` frame — never `access_revoked` and never a 401/403, which the daemon takes as revoked
for good (story #4589 · PO 00:42Z: this text once said 403 · access_revoked, contract v1.5; the code is v1.8) — no command is
made (409), and turning it off rejects the devices' open commands in the same transaction. The daemon then waits without knocking; turning it on sends each of the org's live devices
one `desktop.remote_control` Event down its agents' own streams (the daemon acks it and opens the relay again), and the app's
`GET /desktop/remote-control` read is the floor when that Event is missed (PO 08:55Z).
"""
from __future__ import annotations

import uuid
from datetime import datetime, timezone

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.desktop_setup import DesktopSetup
from app.models.organization import Organization

OFF_CODE = "remote_control_off"
WAKE_EVENT = "desktop.remote_control"


class RemoteControlError(Exception):
    def __init__(self, status: int, code: str, message: str):
        super().__init__(message)
        self.status, self.code, self.message = status, code, message


def _now() -> datetime:
    return datetime.now(timezone.utc)


async def is_enabled(db: AsyncSession, org_id: uuid.UUID | None) -> bool:
    """The one place the switch is read (each refusal point asks here, none reads the column)."""
    if org_id is None:
        return False
    return (await db.execute(
        select(Organization.remote_control_enabled_at).where(Organization.id == org_id)
    )).scalar_one_or_none() is not None


def state_view(org: Organization, *, can_change: bool, owner_names: list[str], connected_setups: int) -> dict:
    """story #4583: + who can turn it on (owner_names — display names only · no email · no id) and how many of the org's
    setups are connected (a count only · no device name) — the off state names the owner to everyone else, and the
    approvals line shows only when a computer is connected (Yuna `4583/copy.md` · PO 04:09Z)."""
    at = org.remote_control_enabled_at
    return {
        "enabled": at is not None, "enabled_at": at.isoformat() if at else None, "can_change": can_change,
        "owner_names": owner_names, "connected_setups": connected_setups,
    }


async def owner_names(db: AsyncSession, org_id: uuid.UUID) -> list[str]:
    """story #4583: the display names of the org's owners whose name can be shown, oldest first. «Owner» is read where the
    PUT gate reads it (resolve_member: `members.org_role` on the anchor branch · `org_members.role` on the legacy one — Didi
    R2). The name is the person's own in this org (members · human · active · not deleted — the names /desktop shows for
    «connected by»). An owner with no name, or inactive, is left out — never shown as an id — though the gate may still let
    them turn it on (the gate's own rule · 4535 — this list names, it does not decide)."""
    from app.core.config import settings
    from app.models.member import Member
    from app.models.project import OrgMember

    person = (Member.org_id == org_id, Member.type == "human", Member.deleted_at.is_(None), Member.is_active.is_(True),
              Member.name.isnot(None))
    if settings.member_ssot_resolver_shadow:
        q = select(Member.name).where(Member.org_role == "owner", *person).order_by(Member.created_at, Member.name)
    else:
        q = select(Member.name).join(
            OrgMember, (OrgMember.user_id == Member.user_id) & (OrgMember.org_id == Member.org_id),
        ).where(OrgMember.org_id == org_id, OrgMember.role == "owner", OrgMember.deleted_at.is_(None), *person).order_by(
            OrgMember.created_at, Member.name,
        )
    rows = (await db.execute(q)).scalars().all()
    seen: list[str] = []
    for name in rows:
        if name and name not in seen:
            seen.append(name)
    return seen


def _live_devices(org_id: uuid.UUID) -> tuple:
    """The org's live devices: keys picked up · not disconnected · in a project. Turning it on wakes exactly these, and
    story #4583's `connected_setups` counts exactly these (Didi R4) — «≥ 1» means «turning it on reaches a computer»."""
    return (
        DesktopSetup.org_id == org_id, DesktopSetup.exchanged_at.is_not(None), DesktopSetup.revoked_at.is_(None),
        DesktopSetup.project_id.is_not(None),
    )


async def connected_setups(db: AsyncSession, org_id: uuid.UUID) -> int:
    """story #4583: how many of the org's live setups turning it on would wake (`_live_devices`). A count only."""
    from sqlalchemy import func

    return int((await db.execute(select(func.count()).select_from(DesktopSetup).where(*_live_devices(org_id)))).scalar_one())


async def set_enabled(db: AsyncSession, *, org: Organization, actor_id: uuid.UUID, enabled: bool) -> int:
    """The switch, its audit line, and what the change does — in the caller's transaction. Returns the open commands rejected
    (turning off) or the devices woken (turning on). The same value again changes nothing (no audit line, nothing done)."""
    from app.models.remote_control_audit_log import OrgRemoteControlAuditLog

    if (org.remote_control_enabled_at is not None) == enabled:
        return 0
    now = _now()
    org.remote_control_enabled_at, org.remote_control_enabled_by = (now, actor_id) if enabled else (None, None)
    db.add(OrgRemoteControlAuditLog(org_id=org.id, actor_id=actor_id, enabled=enabled))
    if not enabled:
        # story #4554 ④ · Kadir 4981 ②: one path with the disconnect's — an answer_approval among the open commands moves its
        # permission request to rejected too (the approver's phone must not read «answered» for an answer that never went down)
        from app.services.desktop_relay import reject_open_commands

        setup_ids = list((await db.execute(select(DesktopSetup.id).where(DesktopSetup.org_id == org.id))).scalars().all())
        rejected = await reject_open_commands(db, setup_ids=setup_ids, result_code=OFF_CODE)
        await db.flush()
        return rejected
    return await _wake_devices(db, org.id)


async def _wake_devices(db: AsyncSession, org_id: uuid.UUID) -> int:
    """One `desktop.remote_control` Event to each agent of each live device of the org (its agents' streams are the only line
    still open to a parked daemon; the daemon acts once per setup_id, whichever stream it came on)."""
    from app.models.event import Event
    from app.services.desktop_relay import _setup_agents
    from app.services.event_seq import assign_recipient_seq

    devices = (await db.execute(select(DesktopSetup).where(*_live_devices(org_id)))).scalars().all()
    for setup in devices:
        for agent_id in sorted(_setup_agents(setup)):
            event = Event(
                project_id=setup.project_id, org_id=org_id, event_type=WAKE_EVENT,
                source_entity_type="desktop_setup", source_entity_id=setup.id,
                recipient_id=agent_id, recipient_type="agent",
                payload={"event_type": WAKE_EVENT, "enabled": True, "setup_id": str(setup.id)},
                status="pending",
            )
            db.add(event)
            await db.flush()
            await assign_recipient_seq(db, event)
    return len(devices)
