"""story #4535 (E-DESKTOP-2 B-4 · AC1) — an organization's «원격 제어» switch. Contract 02d2cf71 §2 (v1.5).

Off by default; only an owner turns it on or off. While off the device line is off as a whole (PO 08:55Z ⓐ): every relay call
is refused (403 remote_control_off — the device token stays valid), an open relay stream ends with
`access_revoked {reason: remote_control_off}`, no command is made (409), and turning it off rejects the devices' open
commands in the same transaction. The daemon then waits without knocking; turning it on sends each of the org's live devices
one `desktop.remote_control` Event down its agents' own streams (the daemon acks it and opens the relay again), and the app's
`GET /desktop/remote-control` read is the floor when that Event is missed (PO 08:55Z).
"""
from __future__ import annotations

import uuid
from datetime import datetime, timezone

from sqlalchemy import select, update
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.desktop_relay import DesktopCommand
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


def state_view(org: Organization, *, can_change: bool) -> dict:
    at = org.remote_control_enabled_at
    return {"enabled": at is not None, "enabled_at": at.isoformat() if at else None, "can_change": can_change}


async def set_enabled(db: AsyncSession, *, org: Organization, actor_id: uuid.UUID, enabled: bool) -> int:
    """The switch, its audit line, and what the change does — in the caller's transaction. Returns the open commands rejected
    (turning off) or the devices woken (turning on). The same value again changes nothing (no audit line, nothing done)."""
    from app.models.remote_control_audit_log import OrgRemoteControlAuditLog

    if (org.remote_control_enabled_at is not None) == enabled:
        return 0
    now = _now()
    org.remote_control_enabled_at, org.remote_control_enabled_by = (now, actor_id) if enabled else (None, None)
    db.add(OrgRemoteControlAuditLog(org_id=org.id, actor_id=actor_id, enabled=enabled))
    setups = select(DesktopSetup.id).where(DesktopSetup.org_id == org.id)
    if not enabled:
        rejected = (await db.execute(
            update(DesktopCommand)
            .where(DesktopCommand.setup_id.in_(setups), DesktopCommand.state.in_(("queued", "delivered")))
            .values(state="rejected", result_code=OFF_CODE, finished_at=now)
            .returning(DesktopCommand.id)
        )).scalars().all()
        await db.flush()
        return len(rejected)
    return await _wake_devices(db, org.id)


async def _wake_devices(db: AsyncSession, org_id: uuid.UUID) -> int:
    """One `desktop.remote_control` Event to each agent of each live device of the org (its agents' streams are the only line
    still open to a parked daemon; the daemon acts once per setup_id, whichever stream it came on)."""
    from app.models.event import Event
    from app.services.desktop_relay import _setup_agents
    from app.services.event_seq import assign_recipient_seq

    devices = (await db.execute(select(DesktopSetup).where(
        DesktopSetup.org_id == org_id, DesktopSetup.exchanged_at.is_not(None), DesktopSetup.revoked_at.is_(None),
        DesktopSetup.project_id.is_not(None),
    ))).scalars().all()
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
