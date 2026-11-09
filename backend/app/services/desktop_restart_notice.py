"""story 4863 (PO 11-09) — an agent on a person's computer was ended from OUTSIDE (a user script's kill · the OS · an update) and nothing started it again:
the person who holds that computer is told, once.

11-08 23:17Z: six lane sessions were killed together; the app started them twice, each died again, the automatic restart stopped, the app itself was gone —
and for 79 minutes nobody was told. The product only tells; it does not decide what the agent does.

The daemon (which outlives the app) says «ended from outside and no session of this agent stood again» on the session's own `stopped` report
(`restart_stopped`, an additive field of POST /relay/sessions/{key}/state) — after the restart's wait sum plus a margin, so both «the app hit its limit» and «there is no app to
restart anything» come here. This module is the one hand that tells (the server), by the rule 4781 fixed for the limit notice:

- who: the owners of the phones paired with the setup; with NO usable pairing, whoever connected the computer if still an active member, AND the org's owners
  (`desktop_limit_notice._recipients` — one definition);
- when: one notice per PERSON per WINDOW_SEC (six agents killed together are one notice — «{agent} and {others} more»: the report names the other agents that
  stand ended at that moment, the first report to claim the window carries the count); the same session's report twice is told once;
- words: «{agent} (and N more) was ended from outside and did not start again» + the deep link; no token · key · account · path (a place on the computer is for the agent's own first input there, never for the notice).
A failure here never fails the state report that carried it (the caller keeps it in a savepoint).
"""
from __future__ import annotations

import logging
import time
import uuid

from sqlalchemy import func, or_, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.desktop_setup import DesktopSetup
from app.services import redis_shared
from app.services.desktop_limit_notice import Recipient, _agent_name, _recipients, member_prefix

logger = logging.getLogger(__name__)

# The event type is a LITERAL at its dispatch call (the deep-link manifest scanner reads the source): «agent.restart_stopped» — registered in schemas/deeplink_manifest.py.
# one notice per person per this long (the same 5 minutes as the limit notice)
WINDOW_SEC = 300
# the same session told once for this long (a daemon asking again after a lost answer — a day: longer than any retry, shorter than the key's usefulness)
SESSION_TTL_SEC = 86400
# at most this many other agents are counted from one report
ALSO_MAX = 32

_DOMAIN = "desktop_restart_notice"
_local: dict[str, float] = {}  # key → expires (monotonic) — the no-Redis path of this process


def _key(kind: str, *parts: str) -> str:
    return redis_shared.key(_DOMAIN, kind, *parts)


async def _claim(key: str, ttl: int) -> bool:
    """True = this call owns the key for `ttl` seconds (first caller wins)."""
    async def _op(client) -> bool:
        return bool(await client.set(key, "1", nx=True, ex=ttl))

    def _fallback() -> bool:
        if _local.get(key, 0.0) > time.monotonic():
            return False
        _local[key] = time.monotonic() + ttl
        return True

    return await redis_shared.with_fallback(_op, _fallback)


async def _release(key: str) -> None:
    async def _op(client) -> None:
        await client.delete(key)

    def _fallback() -> None:
        _local.pop(key, None)

    await redis_shared.with_fallback(_op, _fallback)


async def _others(db: AsyncSession, setup: DesktopSetup, agent_member_id: uuid.UUID, also: list[uuid.UUID]) -> int:
    """How many OTHER agents the report names that are on THIS computer: set up with it NOW (a member of this setup or of another live setup of the same organization with the same machine
    key) AND with a session row there. Any other id (another computer's agent, another organization's, an agent that moved away, a made-up one) is dropped: one device token cannot put somebody
    else's agent into a notice or inflate its number."""
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
    on_this_computer: set[uuid.UUID] = set()
    for s in setups:
        on_this_computer |= _setup_agents(s)
    wanted &= on_this_computer
    if not wanted:
        return 0
    with_session = set((await db.execute(
        select(DesktopSession.agent_member_id).where(DesktopSession.agent_member_id.in_(wanted), DesktopSession.setup_id.in_([s.id for s in setups]))
    )).scalars().all())
    return len(wanted & with_session)


def _words(locale: str, agent: str, others: int) -> tuple[str, str]:
    from app.services.i18n_catalog import t

    title = t("desktop_restart_notice.title_many", locale, agent=agent, others=others) if others else t("desktop_restart_notice.title", locale, agent=agent)
    return title, t("desktop_restart_notice.body", locale)


async def tell(db: AsyncSession, setup: DesktopSetup, *, agent_member_id: uuid.UUID, session_key: str, also: list[uuid.UUID]) -> int:
    """Tell the people who hold this computer that `agent_member_id` was ended from outside and did not stand again. Returns how many people were told."""
    from app.services.notification_dispatch import dispatch_notification

    if setup.org_id is None:
        return 0
    once = _key("session", str(setup.id), session_key)
    if not await _claim(once, SESSION_TTL_SEC):
        logger.info("desktop restart notice: already told for this session setup=%s", setup.id)
        return 0
    told = 0
    try:
        people: list[Recipient] = await _recipients(db, setup)
        if not people:
            logger.info("desktop restart notice: nobody to tell setup=%s (no phone paired, and not connected by an active member)", setup.id)
            await _release(once)  # nobody was told: a later report (a phone paired meanwhile) may still tell it
            return 0
        name = await _agent_name(db, agent_member_id)
        others = await _others(db, setup, agent_member_id, also)
        failed = False
        for person in people:
            window = _key("window", str(setup.org_id), str(person.user_id))
            if not await _claim(window, WINDOW_SEC):
                logger.info("desktop restart notice: not sent (a notice went to this person within the window) setup=%s to=%s", setup.id, member_prefix(person.member_id))
                continue
            title, body = _words(person.locale, name, others)
            try:
                async with db.begin_nested():  # one person's failure undoes only that person's notice
                    sent = await dispatch_notification(
                        db, org_id=setup.org_id, event_type="agent.restart_stopped", target_member_ids=[person.member_id], title=title, body=body,
                        reference_type="agent", reference_id=agent_member_id, source_project_id=setup.project_id,
                        event={"payload": {"agent_name": name}},
                    )
            except BaseException as exc:  # (a cancellation too: the claim must not stay held for a notice that was never made)
                await _release(window)
                if not isinstance(exc, Exception):
                    raise
                failed = True
                logger.warning("desktop restart notice: failed setup=%s to=%s", setup.id, member_prefix(person.member_id), exc_info=True)
                continue
            if not sent:
                # the dispatcher answers 0 (it does not raise) when it told nobody (a failure it swallowed · a person whose settings turn the notice off):
                # the window is let go so the next report may still tell this person
                await _release(window)
                logger.warning("desktop restart notice: reached nobody setup=%s to=%s", setup.id, member_prefix(person.member_id))
                continue
            told += 1
            logger.info("desktop restart notice: sent setup=%s to=%s others=%d", setup.id, member_prefix(person.member_id), others)
        if failed or told == 0:
            await _release(once)  # a person was not told (a failure · the window held by others · switched off): the same session asked again is judged again — whoever was told is held by their window
        return told
    except BaseException:
        await _release(once)
        raise
