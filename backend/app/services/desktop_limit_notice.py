"""story #4685 (AC1 · PO 10-14 00:27Z) — an agent on a person's computer stands at the usage limit: the person who connected that
computer is told, once; and once more when work starts again.

10-13: five lanes stood for 30 minutes (and, with no reset time read, for 7 hours) and nobody was told — the only notice a limit
had was the turn-end one a phone's [지금 지시] earned, which a session with no instruction pending never earns. Words: Yuna's
`limit-notice-1014.md`, as written (i18n_catalog `desktop_limit_notice.*` + the existing paused_limit title).

- «stood» = a report moves a session from not-limited to limited (`DesktopSession.limited`, read BEFORE the report overwrites it —
  no column needed). Told to the people whose PHONE is paired with that setup (story 4685 AC9 · PO 10-21: the person who holds the
  computer from their phone), or — when no phone is paired — to `setup.confirmed_by` (the person who connected it); in their
  language, the reset time in the org's zone. A window of WINDOW_SEC per PERSON (story 4685 AC8: not per setup — one computer's six agents have six setups, and the
  10-20 weekly limit sent six notices) folds the others that stand soon after into the same notice (the first one goes at once —
  AC3's «within a minute»); the count in it is the sessions of ALL that person's setups that stand at that moment.
- «lifted» = the last limited session of that person leaves the limit (and one stood notice is outstanding): told once, with the
  same agent and count as that «stood» notice. A session that is later than the window still counts: the line goes only when ALL
  are back (a false «all working» would be worse than a late line). A session that ENDS is not «working again» — it clears the
  outstanding notice without a line. A revoked setup's sessions are not the person's any more: they neither stand nor hold the line back.
- A failure here never fails the state report (the work is in a savepoint; the report is the record, the notice is its echo).
- Redis keeps the window and the outstanding notice across instances; without Redis they live in this process (a restart forgets —
  the cost is one missing «lifted» line, never a duplicate «stood»).
"""
from __future__ import annotations

import json
import logging
import time
import uuid
from dataclasses import dataclass
from datetime import datetime, timezone
from zoneinfo import ZoneInfo

from sqlalchemy import and_, func, or_, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.desktop_relay import DesktopSession
from app.models.desktop_setup import DesktopSetup
from app.services import redis_shared

logger = logging.getLogger(__name__)

# The two event types are written as LITERALS at their dispatch calls (the deep-link manifest scanner reads the source for them):
# «agent.limit_paused» (stood) · «agent.limit_lifted» (working again) — both registered in schemas/deeplink_manifest.py.
# one «stood» notice per computer per this long (the others that stand soon after are folded into the first's count / not told)
WINDOW_SEC = 300
# an outstanding «stood» notice waits this long for the «lifted» line (a week of standing is not a thing to keep promising)
OPEN_TTL_SEC = 7 * 86400

_DOMAIN = "desktop_limit_notice"
_local: dict[str, tuple[float, str]] = {}  # key → (expires monotonic, value) — the no-Redis path of this process


def _key(kind: str, org_id: uuid.UUID, user_id: uuid.UUID) -> str:
    """story 4685 AC8: one window and one promise per PERSON in an organization — the user who connected the computer (`setup.confirmed_by`)."""
    return redis_shared.key(_DOMAIN, kind, str(org_id), str(user_id))


def _local_get(key: str) -> str | None:
    hit = _local.get(key)
    if hit is None:
        return None
    if hit[0] <= time.monotonic():
        _local.pop(key, None)
        return None
    return hit[1]


async def _claim_window(org_id: uuid.UUID, user_id: uuid.UUID) -> bool:
    """True = this report owns the window (its notice goes); False = a notice for this computer went within WINDOW_SEC."""
    key = _key("window", org_id, user_id)

    async def _op(client) -> bool:
        return bool(await client.set(key, "1", nx=True, ex=WINDOW_SEC))

    def _fallback() -> bool:
        if _local_get(key) is not None:
            return False
        _local[key] = (time.monotonic() + WINDOW_SEC, "1")
        return True

    return await redis_shared.with_fallback(_op, _fallback)


async def _release_window(org_id: uuid.UUID, user_id: uuid.UUID) -> None:
    key = _key("window", org_id, user_id)

    async def _op(client) -> None:
        await client.delete(key)

    def _fallback() -> None:
        _local.pop(key, None)

    await redis_shared.with_fallback(_op, _fallback)


async def _save_open(org_id: uuid.UUID, user_id: uuid.UUID, record: dict) -> None:
    key, value = _key("open", org_id, user_id), json.dumps(record)

    async def _op(client) -> None:
        await client.set(key, value, ex=OPEN_TTL_SEC)

    def _fallback() -> None:
        _local[key] = (time.monotonic() + OPEN_TTL_SEC, value)

    await redis_shared.with_fallback(_op, _fallback)


async def _take_open(org_id: uuid.UUID, user_id: uuid.UUID) -> dict | None:
    """The outstanding «stood» record, removed in the same step (the «lifted» line goes once)."""
    key = _key("open", org_id, user_id)

    async def _op(client) -> str | None:
        raw = await client.getdel(key)
        return None if raw is None else (raw.decode() if isinstance(raw, (bytes, bytearray)) else str(raw))

    def _fallback() -> str | None:
        raw = _local_get(key)
        _local.pop(key, None)
        return raw

    raw = await redis_shared.with_fallback(_op, _fallback)
    try:
        return json.loads(raw) if raw else None
    except ValueError:
        return None


@dataclass(frozen=True)
class Recipient:
    """One person to tell: their users.id (the unit of the window and the promise), their member row in the org, their language."""
    user_id: uuid.UUID
    member_id: uuid.UUID
    locale: str


def _usable_pairing_filters():
    """What makes a pairing count as «a phone is paired with this setup»: the daemon has not been told to drop it (`removed_at` null), the phone key is not
    revoked, and its owner is an active human member of an organization (the caller adds the org). One definition for the recipients and for the counts."""
    from app.models.agent_permission import RemoteDevice, RemoteDevicePairing
    from app.models.member import Member

    return (
        RemoteDevicePairing.removed_at.is_(None), RemoteDevice.revoked_at.is_(None),
        Member.type == "human", Member.is_active.is_(True), Member.deleted_at.is_(None), Member.user_id.is_not(None),
    )


async def _with_locales(db: AsyncSession, org_id: uuid.UUID, people: dict[uuid.UUID, uuid.UUID]) -> list[Recipient]:
    """{user id: member id} → the Recipients, each in their own language (the org's when they have none). Ordered by user id: a fixed order for
    the per-person locks the «working again» path takes, so two reports never wait on each other in a circle."""
    from app.models.user import User
    from app.services.agent_onboarding_config import SUPPORTED_LOCALES
    from app.services.org_locale import resolve_org_locale

    out: list[Recipient] = []
    org_locale: str | None = None
    for user_id in sorted(people, key=str):
        locale = (await db.execute(select(User.locale).where(User.id == user_id))).scalar_one_or_none()
        if locale not in SUPPORTED_LOCALES:
            org_locale = org_locale or await resolve_org_locale(db, org_id)
            locale = org_locale
        out.append(Recipient(user_id, people[user_id], locale))
    return out


async def _recipients(db: AsyncSession, setup: DesktopSetup) -> list[Recipient]:
    """Who is told about this setup (story 4685 AC9): the owners of the phones paired with it, one entry per person (a person with two phones
    is told once); with no usable pairing, whoever connected the computer if still an active member of the org. Empty = nobody to tell."""
    from app.models.agent_permission import RemoteDevice, RemoteDevicePairing
    from app.models.member import Member
    people: dict[uuid.UUID, uuid.UUID] = {}
    paired = await db.execute(
        select(Member.user_id, Member.id)
        .select_from(RemoteDevicePairing)
        .join(RemoteDevice, RemoteDevice.id == RemoteDevicePairing.remote_device_id)
        .join(Member, Member.id == RemoteDevice.member_id)
        .where(RemoteDevicePairing.setup_id == setup.id, Member.org_id == setup.org_id, *_usable_pairing_filters())
        .order_by(RemoteDevicePairing.paired_at.asc(), RemoteDevicePairing.id.asc())
    )
    for user_id, member_id in paired.all():
        people.setdefault(user_id, member_id)
    if not people and setup.confirmed_by is not None:
        member_id = (await db.execute(
            select(Member.id).where(
                Member.org_id == setup.org_id, Member.type == "human", Member.user_id == setup.confirmed_by,
                Member.deleted_at.is_(None), Member.is_active.is_(True),
            )
        )).scalars().first()
        if member_id is not None:
            people[setup.confirmed_by] = member_id
    return await _with_locales(db, setup.org_id, people)


def format_time(at: datetime, tz: ZoneInfo, locale: str, *, now: datetime) -> str:
    """Yuna's {time}: the person's zone · today → the time only («오후 3:20» / «3:20 PM») · another day → date + time («10월 15일 오전
    9:00» / «Oct 15, 9:00 AM»). (The org's zone stands in for the person's: a person has none stored.)"""
    from app.services.i18n_catalog import t

    local, today = at.astimezone(tz), now.astimezone(tz).date()
    ampm = t("desktop_limit_notice.time.am" if local.hour < 12 else "desktop_limit_notice.time.pm", locale)
    clock = t("desktop_limit_notice.time.clock", locale, ampm=ampm, hour=local.hour % 12 or 12, minute=f"{local.minute:02d}")
    if local.date() == today:
        return clock
    months = ("Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec")
    month = str(local.month) if locale == "ko" else months[local.month - 1]  # ko says «10월» (a number), en «Oct»
    return t("desktop_limit_notice.time.dated", locale, month=month, day=local.day, clock=clock)


def where_text(rows: list[DesktopSession], locale: str) -> str | None:
    """story #4686 (Yuna `run-info-1014.md` (5)): where the limit hit — «{account} · {model}». A usage limit hits the ACCOUNT, so the account
    comes first. `rows` are the sessions the notice names, this report's first. One account (one or several sessions): its model too when
    all of them run the same one. Several accounts: «{first} and {k} more accounts». No account known (Codex, a login that could not be
    read): the model alone — and for several sessions only when they all run one model. Nothing known → None (no «한도가 걸린 곳: »)."""
    from app.services.i18n_catalog import t

    accounts = list(dict.fromkeys(r.run_account for r in rows if r.run_account))
    models = {r.run_model for r in rows if r.run_model}
    if accounts:
        if len(accounts) > 1:
            where = t("desktop_limit_notice.where_more_accounts", locale, account=accounts[0], k=len(accounts) - 1)
        else:
            own = {r.run_model for r in rows if r.run_account and r.run_model}
            where = (t("desktop_limit_notice.where_account_model", locale, account=accounts[0], model=next(iter(own)))
                     if len(own) == 1 and all(r.run_model for r in rows if r.run_account) else accounts[0])
    elif len(models) == 1 and all(r.run_model for r in rows):
        where = next(iter(models))
    else:
        return None
    return t("desktop_limit_notice.where", locale, where=where)


async def _limited_rows(db: AsyncSession, org_id: uuid.UUID, user_id: uuid.UUID, *, ever: bool = False) -> list[DesktopSession]:
    """The sessions standing at the limit that are THIS person's to hear about (AC8): those of every live setup of the organization whose
    recipients include them — a setup with a phone of theirs paired, or a setup with no usable pairing that they connected (the same two
    cases as `_recipients`). A revoked setup is not theirs any more: its stale row must not hold the «working again» line back.
    `ever=True` is the wider reading the «working again» gate needs (same as `_lifted_candidates`): also a setup a phone of theirs was once
    paired with (pairing since removed, key since revoked) — the notice they were promised may have been made for it, so it still counts as
    standing for them. (A setup they merely connected, with someone else's phone paired, never told them: it does not hold their line back.)"""
    from app.models.agent_permission import RemoteDevice, RemoteDevicePairing
    from app.models.member import Member

    def _pairing_of_this_setup(*extra):
        return (
            select(RemoteDevicePairing.id)
            .join(RemoteDevice, RemoteDevice.id == RemoteDevicePairing.remote_device_id)
            .join(Member, Member.id == RemoteDevice.member_id)
            .where(RemoteDevicePairing.setup_id == DesktopSetup.id, Member.org_id == org_id, *_usable_pairing_filters(), *extra)
            .exists()
        )

    theirs_paired = _pairing_of_this_setup(Member.user_id == user_id)
    nobody_paired = ~_pairing_of_this_setup()
    scope = or_(theirs_paired, and_(DesktopSetup.confirmed_by == user_id, nobody_paired))
    if ever:
        was_theirs = (
            select(RemoteDevicePairing.id)
            .join(RemoteDevice, RemoteDevice.id == RemoteDevicePairing.remote_device_id)
            .join(Member, Member.id == RemoteDevice.member_id)
            .where(RemoteDevicePairing.setup_id == DesktopSetup.id, Member.org_id == org_id, Member.user_id == user_id)
            .exists()
        )
        scope = or_(scope, was_theirs)
    return list((await db.execute(
        select(DesktopSession).join(DesktopSetup, DesktopSetup.id == DesktopSession.setup_id).where(
            DesktopSetup.org_id == org_id, DesktopSetup.revoked_at.is_(None),
            scope,
            DesktopSession.limited.is_(True), DesktopSession.state != "stopped",
        ).order_by(DesktopSession.state_at.asc(), DesktopSession.id.asc())
    )).scalars().all())


async def _agent_name(db: AsyncSession, agent_id: uuid.UUID) -> str:
    from app.models.member import Member

    return (await db.execute(select(Member.name).where(Member.id == agent_id))).scalar_one_or_none() or ""


async def _stood(db: AsyncSession, setup: DesktopSetup, row: DesktopSession) -> None:
    who = await _recipients(db, setup)
    if not who:
        logger.info("desktop limit notice: nobody to tell setup=%s (no phone paired, and not connected by an active member)", setup.id)
        return
    for person in who:  # each person once — and each in a savepoint of their own: one person's failure takes back only their own echo, never another person's
        try:
            async with db.begin_nested():
                await _stood_for(db, setup, row, person)
        except Exception:  # noqa: BLE001 — the window is let go in `_stood_for`; the next report may still tell this person
            logger.warning("desktop limit notice: telling one person failed setup=%s session=%s", setup.id, row.session_key, exc_info=True)


async def _stood_for(db: AsyncSession, setup: DesktopSetup, row: DesktopSession, person: Recipient) -> None:
    from app.models.organization import Organization
    from app.services.i18n_catalog import t
    from app.services.notification_dispatch import dispatch_notification
    from app.services.org_time import org_tz

    locale = person.locale
    if not await _claim_window(setup.org_id, person.user_id):
        return
    try:
        rows = await _limited_rows(db, setup.org_id, person.user_id)
        # this report's agent first (the one that just stood), then the others that stand now — one agent counted once
        agents: list[uuid.UUID] = [row.agent_member_id]
        for r in rows:
            if r.agent_member_id not in agents:
                agents.append(r.agent_member_id)
        others = len(agents) - 1
        name = await _agent_name(db, agents[0])
        now = datetime.now(timezone.utc)
        ats = [r.limit_at for r in rows]
        latest = max(ats) if ats and all(a is not None for a in ats) else None
        if latest is not None and latest > now:
            org = await db.get(Organization, setup.org_id)
            time_text = format_time(latest, org_tz(getattr(org, "timezone", None)), locale, now=now)
            body = t("desktop_limit_notice.stood.body_known", locale, time=time_text)
        else:  # a time not known for all of them, or one already past: never «풀려요» at a time that has gone
            body = t("desktop_limit_notice.stood.body_unknown", locale)
        # story #4686: where it hit (account first, then the model) — this report's session first; no line when nothing is known
        named = [row] + [r for r in rows if r.id != row.id]
        where = where_text(named, locale)
        if where:
            body = f"{body} {where}"
        title = (t("desktop_limit_notice.stood.title_many", locale, agent=name, others=others) if others
                 else t("desktop_command.turn_end_title.paused_limit", locale, agent=name))
        sent = await dispatch_notification(
            db, org_id=setup.org_id, event_type="agent.limit_paused", target_member_ids=[person.member_id], title=title, body=body,
            reference_type="agent", reference_id=agents[0], source_project_id=setup.project_id,
            event={"payload": {"agent_name": name}},
        )
        if not sent:
            # the dispatcher answers 0 (it does not raise) when it told nobody — a failure it swallowed, or a person whose settings turn
            # the notice off. Nothing was told: the window is let go (the next report may still tell it) and nothing is promised — else
            # the person would never hear «stopped» and later hear only «working again», and for five minutes no report could tell it
            # (Kadir's codex lens ③, 10-14)
            await _release_window(setup.org_id, person.user_id)
            logger.warning("desktop limit notice: the stood notice reached nobody setup=%s session=%s", setup.id, row.session_key)
            return
        await _save_open(setup.org_id, person.user_id, {"agent": str(agents[0]), "others": others})
    except Exception:
        await _release_window(setup.org_id, person.user_id)  # nothing was told: the next report may still tell it
        raise


async def _lifted_candidates(db: AsyncSession, setup: DesktopSetup) -> list[Recipient]:
    """Who may be owed a «working again» line for this setup: the people it tells NOW, and everyone it could have told when the limit stood — the owners of
    phones that were once paired with it (a pairing since removed, a key since revoked) and whoever connected it. The promise is kept to the person it was
    made to, even if the pairing that made them its recipient is gone by the time the limit lifts."""
    from app.models.agent_permission import RemoteDevice, RemoteDevicePairing
    from app.models.member import Member
    people: dict[uuid.UUID, uuid.UUID] = {r.user_id: r.member_id for r in await _recipients(db, setup)}
    former = await db.execute(
        select(Member.user_id, Member.id)
        .select_from(RemoteDevicePairing)
        .join(RemoteDevice, RemoteDevice.id == RemoteDevicePairing.remote_device_id)
        .join(Member, Member.id == RemoteDevice.member_id)
        .where(RemoteDevicePairing.setup_id == setup.id, Member.org_id == setup.org_id, Member.type == "human", Member.is_active.is_(True),
               Member.deleted_at.is_(None), Member.user_id.is_not(None))
    )
    for user_id, member_id in former.all():
        people.setdefault(user_id, member_id)
    if setup.confirmed_by is not None and setup.confirmed_by not in people:
        member_id = (await db.execute(
            select(Member.id).where(
                Member.org_id == setup.org_id, Member.type == "human", Member.user_id == setup.confirmed_by,
                Member.deleted_at.is_(None), Member.is_active.is_(True),
            )
        )).scalars().first()
        if member_id is not None:
            people[setup.confirmed_by] = member_id
    return await _with_locales(db, setup.org_id, people)


async def _lifted(db: AsyncSession, setup: DesktopSetup, row: DesktopSession) -> None:
    for person in await _lifted_candidates(db, setup):
        try:
            async with db.begin_nested():
                await _lifted_for(db, setup, row, person)
        except Exception:  # noqa: BLE001 — one person's failure takes back only their own echo
            logger.warning("desktop limit notice: the working-again line for one person failed setup=%s session=%s", setup.id, row.session_key, exc_info=True)


async def _lifted_for(db: AsyncSession, setup: DesktopSetup, row: DesktopSession, person: Recipient) -> None:
    from app.services.i18n_catalog import t
    from app.services.notification_dispatch import dispatch_notification

    # Serialised per person: two of one person's setups can come back at the same moment in two transactions, each of which would see the OTHER's row
    # still standing (it is not committed yet) and return — and nobody would tell «working again». The second to ask waits for the first's commit, then
    # counts again and sees the whole picture.
    await db.execute(select(func.pg_advisory_xact_lock(func.hashtext(f"desktop-limit-lifted:{setup.org_id}:{person.user_id}"))))
    if await _limited_rows(db, setup.org_id, person.user_id, ever=True):
        return  # some are still standing — «all working again» would be false
    record = await _take_open(setup.org_id, person.user_id)
    if record is None or row.state == "stopped":
        return  # nothing was promised (or the session ended — not «working again»)
    locale = person.locale
    agent_id = uuid.UUID(record["agent"])
    others = int(record.get("others") or 0)
    name = await _agent_name(db, agent_id)
    kind = "many" if others else "one"
    await dispatch_notification(
        db, org_id=setup.org_id, event_type="agent.limit_lifted", target_member_ids=[person.member_id],
        title=t(f"desktop_limit_notice.lifted.title_{kind}", locale, agent=name, others=others),
        body=t(f"desktop_limit_notice.lifted.body_{kind}", locale),
        reference_type="agent", reference_id=agent_id, source_project_id=setup.project_id,
        event={"payload": {"agent_name": name}},
    )


async def after_report(db: AsyncSession, setup: DesktopSetup, row: DesktopSession, *, was_limited: bool) -> None:
    """Called after a report is written (flushed). `was_limited`: the row's `limited` BEFORE this report overwrote it."""
    now_limited = bool(row.limited)
    if now_limited == was_limited:
        return
    try:
        async with db.begin_nested():  # a failure here rolls back to here — the state report itself stands
            if now_limited:
                await _stood(db, setup, row)
            else:
                await _lifted(db, setup, row)
    except Exception:  # noqa: BLE001 — the notice is the echo of the record, never its condition
        logger.warning("desktop limit notice failed setup=%s session=%s", setup.id, row.session_key, exc_info=True)
