"""story 4863 (PO 11-09) — an agent on a person's computer was ended from OUTSIDE and nothing started it again: the people who hold that computer are told once.

11-08 23:17Z: six lane sessions were killed together, the app's two tries died too, the app itself was gone — and for 79 minutes nobody was told. The daemon (which outlives
the app) says «ended from outside and no session of this agent stood again» on the session's own `stopped` report
(`restart_stopped`, an additive field of POST /relay/sessions/{key}/state) — after the app's restart waits plus a margin, so both «the app hit its limit» and «there is no app to
restart anything» come here. This module is the one hand that tells (the server), by the rule 4781 fixed for the limit notice:

- who: the owners of the phones paired with the setup; with NO usable pairing, whoever connected the computer if still an active member, AND the org's owners
  (`desktop_limit_notice._recipients` — one definition);
- when: one notice per PERSON per WINDOW_SEC (six agents killed together are one notice — «{agent} and {others} more»: the report names the other agents that
  stand ended at that moment, the first report to tell carries the count); the same session end said twice (a retry) is told once;
- words: «{agent} (and N more) was ended from outside and did not start again» + the deep link; no token · key · account · path (a place on the computer is for the agent's own first input there, never for the notice).

The record of «already told» is the notification itself (its `event.payload.restart_key` and its time), read under a per-person advisory lock inside the same transaction that writes it:
no Redis claim to leak or release, nothing that outlives a rolled-back write, two reports at once for one person are ordered. One person's failure undoes only that person's notice (a savepoint
each) and a retry tells whoever was missed — and nobody twice. The caller commits (after the state report itself is committed) and never lets a failure here touch the report.
"""
from __future__ import annotations

import logging
import uuid
from datetime import datetime, timedelta, timezone

from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.desktop_setup import DesktopSetup
from app.models.notification import Notification
from app.services.desktop_limit_notice import _agent_name, _recipients, member_prefix

logger = logging.getLogger(__name__)

# The event type is a LITERAL at its dispatch call (the deep-link manifest scanner reads the source): «agent.restart_stopped» — registered in schemas/deeplink_manifest.py.
TYPE = "agent.restart_stopped"
# one notice per person per this long (the same 5 minutes as the limit notice)
WINDOW_SEC = 300
# a retry of the same end is recognised this long (far past any retry of a daemon; the lookup reads this person's recent notices of this type only, never every one they ever had)
RESTART_KEY_LOOKBACK_SEC = 86400
# at most this many other agents are counted from one report
ALSO_MAX = 32


async def _others(db: AsyncSession, setup: DesktopSetup, agent_member_id: uuid.UUID, also: list[uuid.UUID]) -> int:
    """How many OTHER agents the report names that are on THIS computer: set up with a live setup of the same organization on this computer (this setup, or another with the same machine key) AND with
    a session row in THAT setup. Any other id (another computer's agent, another organization's, an agent that moved away, a made-up one) is dropped: one device token cannot put somebody
    else's agent into a notice or inflate its number."""
    from sqlalchemy import or_

    from app.models.desktop_relay import DesktopSession
    from app.services.desktop_relay import _setup_agents

    wanted = {a for a in also[:ALSO_MAX] if a != agent_member_id}
    if not wanted:
        return 0
    same_computer = DesktopSetup.id == setup.id
    if setup.machine_key is not None:
        same_computer = or_(same_computer, DesktopSetup.machine_key == setup.machine_key)
    setups = (await db.execute(
        select(DesktopSetup).where(DesktopSetup.org_id == setup.org_id, DesktopSetup.revoked_at.is_(None), same_computer)
    )).scalars().all()
    members = {s.id: _setup_agents(s) & wanted for s in setups}
    if not any(members.values()):
        return 0
    pairs = (await db.execute(
        select(DesktopSession.setup_id, DesktopSession.agent_member_id).where(
            DesktopSession.agent_member_id.in_(wanted), DesktopSession.setup_id.in_([s.id for s in setups]))
    )).all()
    return len({agent for setup_id, agent in pairs if agent in members.get(setup_id, set())})


def _words(locale: str, agent: str, others: int) -> tuple[str, str]:
    from app.services.i18n_catalog import t

    title = t("desktop_restart_notice.title_many", locale, agent=agent, others=others) if others else t("desktop_restart_notice.title", locale, agent=agent)
    return title, t("desktop_restart_notice.body", locale)


class _NoRecord(Exception):
    """the dispatcher answered «told» but wrote no Notification row (the record of «already told»): undone, never counted"""


async def _lock_person(db: AsyncSession, org_id: uuid.UUID, user_id: uuid.UUID) -> None:
    """Two reports at once for one person are ordered: the second reads what the first wrote (the lock lasts to the end of the transaction)."""
    await db.execute(select(func.pg_advisory_xact_lock(func.hashtextextended(f"restart_notice:{org_id}:{user_id}", 0))))


async def tell(db: AsyncSession, setup: DesktopSetup, *, agent_member_id: uuid.UUID, session_key: str, at: datetime, also: list[uuid.UUID]) -> int:
    """Tell the people who hold this computer that `agent_member_id` was ended from outside and did not stand again. `at` is the time of the end the daemon reports: with the session key it names THIS
    end (a session key is reused by a later session — its later end is a new notice, a retry of this one is not). Returns how many people were told; the caller commits."""
    from app.services.notification_dispatch import dispatch_notification

    setup_id, org_id, project_id = setup.id, setup.org_id, setup.project_id  # (plain values: logging after a rollback must not touch an expired object)
    if org_id is None:
        return 0
    people = await _recipients(db, setup)
    if not people:
        logger.info("desktop restart notice: nobody to tell setup=%s (no phone paired, and not connected by an active member)", setup_id)
        return 0
    name = await _agent_name(db, agent_member_id)
    others = await _others(db, setup, agent_member_id, also)
    restart_key = f"{session_key}|{at.astimezone(timezone.utc).isoformat(timespec='microseconds')}"  # one spelling of an instant: a retry that carries the same time in another offset is the same end
    told = 0
    for person in sorted(people, key=lambda p: str(p.user_id)):  # one fixed order for the per-person locks: two setups holding the same two people can never take them in opposite orders
        try:
            async with db.begin_nested():  # one person's failure undoes only that person's notice
                await _lock_person(db, org_id, person.user_id)
                mine = (Notification.org_id == org_id, Notification.user_id == person.user_id, Notification.type == TYPE)
                recent = Notification.created_at >= func.clock_timestamp() - timedelta(seconds=RESTART_KEY_LOOKBACK_SEC)
                if (await db.execute(select(Notification.id).where(*mine, recent, Notification.event["payload"]["restart_key"].astext == restart_key).limit(1))).first() is not None:
                    logger.info("desktop restart notice: already told for this end setup=%s to=%s", setup_id, member_prefix(person.member_id))
                    continue
                if (await db.execute(select(Notification.id).where(*mine, Notification.created_at >= func.clock_timestamp() - timedelta(seconds=WINDOW_SEC)).limit(1))).first() is not None:
                    logger.info("desktop restart notice: not sent (a notice went to this person within the window) setup=%s to=%s", setup_id, member_prefix(person.member_id))
                    continue
                title, body = _words(person.locale, name, others)
                made: list = []
                sent = await dispatch_notification(
                    db, org_id=org_id, event_type="agent.restart_stopped", target_member_ids=[person.member_id], title=title, body=body,
                    reference_type="agent", reference_id=agent_member_id, source_project_id=project_id,
                    event={"payload": {"agent_name": name, "restart_key": restart_key}}, created_rows=made,
                )
                if sent and not any(isinstance(r, Notification) for r in made):
                    # the dispatcher can say «1» when only the bell line was written (its Notification insert failed): that is not «told» — the row we read «already told» from is missing.
                    # Raise inside the savepoint: the half-written bell line goes too, and a retry tells this person whole.
                    raise _NoRecord()
        except Exception:  # noqa: BLE001 — this person's notice only; a retry tells them (and nobody twice)
            logger.warning("desktop restart notice: failed setup=%s to=%s", setup_id, member_prefix(person.member_id), exc_info=True)
            continue
        if not sent:
            # the dispatcher answers 0 (it does not raise) when it told nobody (a failure it swallowed · a person whose settings turn the notice off): nothing is recorded, so a retry judges it again
            logger.warning("desktop restart notice: reached nobody setup=%s to=%s", setup_id, member_prefix(person.member_id))
            continue
        told += 1
        logger.info("desktop restart notice: sent setup=%s to=%s others=%d", setup_id, member_prefix(person.member_id), others)
    return told
