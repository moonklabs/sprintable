"""story 4734 (design 4734-pairing-unit · PO OK 10-20) — the COMPUTER: one Mac · one person · one organization.

A desktop setup (`desktop_setups` row) is one run of the setup flow (usually one lane, one or a few agents); one Mac holds many. The product's unit
for a person — «my phone ↔ my computer», the web «connected devices» line — is the computer, not the setup. The server stores no computer row: a
computer's id is DERIVED from what each setup already records, so nothing migrates and an old row is grouped the moment this lands:

- `machine_key` (story 4660: HMAC(server secret, org_id | the Mac's device id)) says «this Mac in this organization»; the setup's `confirmed_by` says
  whose it is. A Mac with two people's setups of one organization is two computers (a phone must not reach the other person's agents — 4618).
- A setup made before the app sent its device id has no `machine_key` (dev: 222 of 251 live lines). It joins the computer that has the same device
  name and the same person when exactly ONE machine key carries that pair; otherwise it forms its own computer by (device name, person).

A computer's id is NOT a secret and NEVER a capability: anyone can compute a keyless computer's id from public values (organization · device name · person); it opens nothing —
every act on it is checked against the caller's role in the organization and the organization of the rows it names (lens review 10-20).

The authority to command stays per setup (`remote_device_pairings.setup_id` · the daemon's own pins): nothing here widens who may do what. This module only
says which setups are one computer — for the web list, the phone's `/startable` entries (an added id), and the removal of a phone / a disconnect that
the person does once for the computer.
"""
from __future__ import annotations

import uuid
from dataclasses import dataclass
from datetime import datetime
from typing import Sequence

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.desktop_setup import DesktopSetup

# a fixed namespace: the derived id of one computer is the same on every request and every server
COMPUTER_NS = uuid.UUID("5d0b7b0a-4b3e-4b8e-9c2a-4734c0de0a01")
# the most setups one org's grouping reads · the most computers the list returns. Past the first, the grouping is INCOMPLETE: the list says
# `truncated`, the relay says «not now» (`removed_phones: null`), and every act that spans a computer (disconnect · remove a phone) refuses
# with `computer_too_large` rather than do part of it silently. 20000 setups of one org is far past anything real; this is a safety valve.
GROUP_ROWS_MAX = 20000
LIST_COMPUTERS_MAX = 100


class ComputerGroupingIncomplete(Exception):
    """The org has more setups than `GROUP_ROWS_MAX`: a computer's setup list may be missing some — no computer-wide act may run on it."""


@dataclass(frozen=True)
class SetupFacts:
    id: uuid.UUID
    machine_key: str | None
    confirmed_by: uuid.UUID | None
    device_name: str
    confirmed_at: datetime | None


def _who(r: SetupFacts) -> str:
    """Whose it is. A setup whose confirmer is not known is nobody's computer but its own: «unknown counts as not the same» (story 4618) — two unknowns never join."""
    return str(r.confirmed_by) if r.confirmed_by else f"unknown:{r.id}"


def _name(device_name: str | None) -> str:
    return (device_name or "").strip().casefold()


def assign_computers(org_id: uuid.UUID, rows: Sequence[SetupFacts]) -> dict[uuid.UUID, uuid.UUID]:
    """setup id → computer id, for the rows given (all of one organization). Pure: the same rows always give the same ids."""
    keys_by_pair: dict[tuple[str, str], set[str]] = {}
    for r in rows:
        if r.machine_key:
            keys_by_pair.setdefault((_name(r.device_name), _who(r)), set()).add(r.machine_key)
    out: dict[uuid.UUID, uuid.UUID] = {}
    for r in rows:
        who = _who(r)
        if r.machine_key:
            where = f"mk:{r.machine_key}"
        else:
            keys = keys_by_pair.get((_name(r.device_name), who))
            where = f"mk:{next(iter(keys))}" if keys and len(keys) == 1 else f"dn:{_name(r.device_name)}"
        out[r.id] = uuid.uuid5(COMPUTER_NS, f"{org_id}|{where}|{who}")
    return out


async def org_setup_facts(db: AsyncSession, org_id: uuid.UUID) -> tuple[list[SetupFacts], bool]:
    """The confirmed setups of the org, newest first — the same set the web list reads (a line the same machine's new setup replaced is not a
    computer's line: story 4660) — in the few columns the grouping needs. The second value: more rows existed than `GROUP_ROWS_MAX` (incomplete)."""
    rows = (await db.execute(
        select(DesktopSetup.id, DesktopSetup.machine_key, DesktopSetup.confirmed_by, DesktopSetup.device_name, DesktopSetup.confirmed_at)
        .where(
            DesktopSetup.org_id == org_id, DesktopSetup.confirmed_at.isnot(None),
            DesktopSetup.revoked_reason.is_distinct_from("replaced_by_new_setup"),
        )
        .order_by(DesktopSetup.confirmed_at.desc()).limit(GROUP_ROWS_MAX + 1)
    )).all()
    return [SetupFacts(*r) for r in rows[:GROUP_ROWS_MAX]], len(rows) > GROUP_ROWS_MAX


async def computer_index(db: AsyncSession, org_id: uuid.UUID, *, complete: bool = False) -> dict[uuid.UUID, uuid.UUID]:
    """setup id → computer id for every setup of the org the grouping reads. `complete=True`: raise `ComputerGroupingIncomplete` instead of
    returning a partial answer — for anything that acts on a whole computer."""
    facts, capped = await org_setup_facts(db, org_id)
    if capped and complete:
        raise ComputerGroupingIncomplete()
    return assign_computers(org_id, facts)


async def setup_ids_of_computer(
    db: AsyncSession, org_id: uuid.UUID, computer_id: uuid.UUID, *, live_only: bool = True, complete: bool = False,
    index: dict[uuid.UUID, uuid.UUID] | None = None,
) -> list[uuid.UUID]:
    """The setups of one computer (this org only — another org's id gives none). `live_only`: handed over and not disconnected. `complete`: see `computer_index`.
    `index`: a grouping already read — a caller that needs the computer of a setup AND its siblings reads the grouping once, so both come from one snapshot."""
    if index is None:
        index = await computer_index(db, org_id, complete=complete)
    ids = [sid for sid, cid in index.items() if cid == computer_id]
    if not ids or not live_only:
        return ids
    live = (await db.execute(
        select(DesktopSetup.id).where(
            DesktopSetup.id.in_(ids), DesktopSetup.org_id == org_id, DesktopSetup.revoked_at.is_(None), DesktopSetup.exchanged_at.is_not(None),
        )
    )).scalars().all()
    return list(live)


_STATE_ORDER = ("handed_over", "waiting_for_app", "not_handed_over", "disconnected")


def _computer_state(states: list[str]) -> str:
    """A computer is as alive as its best line: connected if any setup is, else waiting · not handed over, else disconnected."""
    for s in _STATE_ORDER:
        if s in states:
            return s
    return "disconnected"


async def list_computers(db: AsyncSession, *, user_id: uuid.UUID, org_id: uuid.UUID) -> dict:
    """The org's computers for the web «연결된 기기» (org owner/admin): one item per computer, newest first, each with its setups (the same item the
    setup list gives) inside. The limit counts COMPUTERS — a Mac with a hundred setups cannot push other Macs out of the list."""
    from app.services.desktop_setup import DesktopSetupError, setup_items
    from app.services.project_auth import is_org_owner_or_admin

    if not await is_org_owner_or_admin(db, user_id, org_id):
        raise DesktopSetupError("not_org_admin")
    facts, capped = await org_setup_facts(db, org_id)
    index = assign_computers(org_id, facts)
    groups: dict[uuid.UUID, list[uuid.UUID]] = {}
    for f in facts:  # newest confirmed first: a computer's place is its newest line's
        groups.setdefault(index[f.id], []).append(f.id)
    chosen = list(groups)[:LIST_COMPUTERS_MAX]
    ids = [sid for cid in chosen for sid in groups[cid]]
    rows = {r.id: r for r in (await db.execute(select(DesktopSetup).where(DesktopSetup.id.in_(ids)))).scalars().all()} if ids else {}
    items = await setup_items(db, [rows[i] for i in ids if i in rows], org_id=org_id)
    # how many phones each setup holds a live pair with — the web says «paired with fewer phones than the others» from it (a daemon not yet on the
    # computer-wide pin list leaves a newer setup with none) · only phones of this org that are not removed
    from sqlalchemy import func

    from app.models.agent_permission import RemoteDevice, RemoteDevicePairing

    paired = dict((await db.execute(
        select(RemoteDevicePairing.setup_id, func.count())
        .join(RemoteDevice, RemoteDevice.id == RemoteDevicePairing.remote_device_id)
        .where(RemoteDevicePairing.setup_id.in_(ids), RemoteDevicePairing.removed_at.is_(None),
               RemoteDevice.org_id == org_id, RemoteDevice.revoked_at.is_(None))
        .group_by(RemoteDevicePairing.setup_id)
    )).all()) if ids else {}
    for it in items:
        it["paired_phones"] = paired.get(it["setup_id"], 0)
    by_id = {it["setup_id"]: it for it in items}
    computers: list[dict] = []
    for cid in chosen:
        its = [by_id[sid] for sid in groups[cid] if sid in by_id]
        if not its:
            continue
        newest = its[0]
        heard = [it["last_used_at"] for it in its if it["last_used_at"] is not None]
        computers.append({
            "computer_id": cid, "device_name": newest["device_name"], "state": _computer_state([it["state"] for it in its]),
            "confirmed_by": newest["confirmed_by"], "confirmed_by_name": newest["confirmed_by_name"], "confirmed_at": newest["confirmed_at"],
            "last_used_at": max(heard) if heard else None,
            "live_setups": sum(1 for it in its if it["state"] == "handed_over"), "active_keys": sum(it["active_keys"] for it in its),
            "setups": its,
        })
    return {"computers": computers, "truncated": capped or len(groups) > LIST_COMPUTERS_MAX}


async def revoke_computer(db: AsyncSession, *, computer_id: uuid.UUID, user_id: uuid.UUID, org_id: uuid.UUID) -> dict:
    """«Disconnect this computer»: every setup of it that is still connected, one by one through the setup's own disconnect (its keys, its device
    token, its open commands, the agents it made). The locks are taken ONCE for the whole computer in the one order (member rows, then setups by id)
    so a disconnect that spans setups cannot meet a setup exchange in the opposite order."""
    from app.services.desktop_setup import DesktopSetupError, _lock_in_order, revoke_setup
    from app.services.project_auth import is_org_owner_or_admin

    if not await is_org_owner_or_admin(db, user_id, org_id):
        raise DesktopSetupError("not_org_admin")
    try:
        everyone = await setup_ids_of_computer(db, org_id, computer_id, live_only=False, complete=True)
    except ComputerGroupingIncomplete:
        raise DesktopSetupError("computer_too_large") from None
    if not everyone:
        raise DesktopSetupError("setup_not_found")
    # discover → lock (once, in the one order: member rows, then setups by id) → discover again. The exchange locks every live setup of the org while it runs, so a
    # setup of this computer cannot appear once our locks are held; one that was exchanged BETWEEN the first read and the locks shows in the second read — we do not
    # go back for more locks (member rows after setup rows is the order that deadlocks against an exchange): nothing was changed, the person is told to try again.
    try:
        found = sorted(await setup_ids_of_computer(db, org_id, computer_id, live_only=True, complete=True))
    except ComputerGroupingIncomplete:
        raise DesktopSetupError("computer_too_large") from None
    if not found:
        return {"computer_id": computer_id, "setups": 0, "keys": 0, "already": True, "revoked_at": None, "revoked_by": None}
    rows = (await db.execute(select(DesktopSetup).where(DesktopSetup.id.in_(found)))).scalars().all()
    made = {
        uuid.UUID(str(m["member_id"])) for r in rows for m in (r.members or [])
        if m.get("kind") == "agent" and m.get("member_id") and not m.get("existing")
    }
    await _lock_in_order(db, member_ids=made, setup_ids=set(found))
    try:
        live = sorted(await setup_ids_of_computer(db, org_id, computer_id, live_only=True, complete=True))
    except ComputerGroupingIncomplete:  # setups pushed the org past the cap between the two reads
        raise DesktopSetupError("computer_too_large") from None
    # a setup we found and locked that is STILL connected but no longer in this computer was regrouped meanwhile (a keyless line joined a machine that
    # got its key): the computer the person clicked is no longer what it was — nothing is changed, they repeat on the line they now see
    still = set((await db.execute(
        select(DesktopSetup.id).where(DesktopSetup.id.in_(found), DesktopSetup.revoked_at.is_(None))
    )).scalars().all())
    if set(live) - set(found) or still - set(live):
        raise DesktopSetupError("computer_changing")
    if not live:  # another admin's disconnect of it committed while we waited for the locks
        return {"computer_id": computer_id, "setups": 0, "keys": 0, "already": True, "revoked_at": None, "revoked_by": None}
    keys, revoked_at, revoked_by = 0, None, None
    for sid in live:
        done = await revoke_setup(db, setup_id=sid, user_id=user_id, org_id=org_id)
        keys += done.keys
        revoked_at = max(filter(None, [revoked_at, done.revoked_at]), default=None)
        revoked_by = done.revoked_by
    return {"computer_id": computer_id, "setups": len(live), "keys": keys, "already": False, "revoked_at": revoked_at, "revoked_by": revoked_by}
