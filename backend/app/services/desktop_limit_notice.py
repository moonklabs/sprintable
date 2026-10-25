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
from datetime import datetime, timedelta, timezone
from zoneinfo import ZoneInfo

from sqlalchemy import and_, func, or_, select, update
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.desktop_relay import DesktopSession
from app.models.desktop_setup import DesktopSetup
from app.services import redis_shared

logger = logging.getLogger(__name__)

# The two event types are written as LITERALS at their dispatch calls (the deep-link manifest scanner reads the source for them):
# «agent.limit_paused» (stood) · «agent.limit_lifted» (working again) — both registered in schemas/deeplink_manifest.py.
# one «stood» notice per computer per this long (the others that stand soon after are folded into the first's count / not told)
WINDOW_SEC = 300
# story 4781 (AC2): «working again» is told only after the limit has stayed gone this long (10-25: the CLI's own retry every 30 minutes read as «lifted» for a second —
# ten false lines). 75 s sits inside the 60–90 s the story asked for; the sweep runs every LIFT_SWEEP_SEC, so a true lift is told within ~105 s.
LIFT_HOLD_SEC = 75
LIFT_SWEEP_SEC = 30
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


async def _add_promised_setups(org_id: uuid.UUID, user_id: uuid.UUID, setup_ids) -> None:
    """The setups the person's outstanding «stopped» notice is about. A SET with an atomic add (Redis SADD) — never a read-modify-write of the
    record: a stand after the window, and a session folded in at the same instant as another, only ever ADD to it (Kadir-lens/codex 4685)."""
    ids = sorted({str(i) for i in setup_ids})
    if not ids:
        return
    key = _key("promised", org_id, user_id)

    async def _op(client) -> None:
        await client.sadd(key, *ids)
        await client.expire(key, OPEN_TTL_SEC)

    def _fallback() -> None:
        have = set(json.loads(_local_get(key) or "[]"))
        _local[key] = (time.monotonic() + OPEN_TTL_SEC, json.dumps(sorted(have | set(ids))))

    await redis_shared.with_fallback(_op, _fallback)


async def _promised_setups(org_id: uuid.UUID, user_id: uuid.UUID) -> frozenset[uuid.UUID]:
    key = _key("promised", org_id, user_id)

    async def _op(client) -> list:
        return [m.decode() if isinstance(m, (bytes, bytearray)) else str(m) for m in await client.smembers(key)]

    def _fallback() -> list:
        return json.loads(_local_get(key) or "[]")

    out: set[uuid.UUID] = set()
    for raw in await redis_shared.with_fallback(_op, _fallback):
        try:
            out.add(uuid.UUID(raw))
        except ValueError:
            continue
    return frozenset(out)


async def _take_open(org_id: uuid.UUID, user_id: uuid.UUID) -> dict | None:
    """The outstanding «stood» record, removed in the same step (the «lifted» line goes once)."""
    key, promised = _key("open", org_id, user_id), _key("promised", org_id, user_id)

    async def _op(client) -> str | None:
        raw = await client.getdel(key)
        await client.delete(promised)  # the record and what it was about go together
        return None if raw is None else (raw.decode() if isinstance(raw, (bytes, bytearray)) else str(raw))

    def _fallback() -> str | None:
        raw = _local_get(key)
        _local.pop(key, None)
        _local.pop(promised, None)
        return raw

    raw = await redis_shared.with_fallback(_op, _fallback)
    try:
        return json.loads(raw) if raw else None
    except ValueError:
        return None


def member_prefix(member_id: uuid.UUID) -> str:
    """story 4781 (AC1): the first 8 characters of a member id — enough to tell people apart in a log, never a name or a whole id"""
    return str(member_id)[:8]


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


async def _limited_rows(db: AsyncSession, org_id: uuid.UUID, user_id: uuid.UUID, *, also_setups: frozenset[uuid.UUID] = frozenset(), include_waiting: bool = False) -> list[DesktopSession]:
    """The sessions standing at the limit that are THIS person's to hear about (AC8): those of every live setup of the organization whose
    recipients include them — a setup with a phone of theirs paired, or a setup with no usable pairing that they connected (the same two
    cases as `_recipients`). A revoked setup is not theirs any more: its stale row must not hold the «working again» line back.
    `also_setups`: the setups the person's outstanding «stopped» notice was made for (the record carries them). They keep counting for that
    person even if the pairing that made them its recipient is gone since — and ONLY those: a pairing that ended before the episode never held
    this person's line back.
    story 4781 `include_waiting`: a session whose lift is still WAITING (its limit is gone but the hold has not run out) is not yet confirmed back — the «working again» gate counts it as standing,
    so the first of two sessions to come back does not take the promise (codex 01a174f2: an ended session would otherwise consume it and the other's lift would find none)."""
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
    if also_setups:
        scope = or_(scope, DesktopSetup.id.in_(also_setups))
    return list((await db.execute(
        select(DesktopSession).join(DesktopSetup, DesktopSetup.id == DesktopSession.setup_id).where(
            DesktopSetup.org_id == org_id, DesktopSetup.revoked_at.is_(None),
            scope,
            or_(DesktopSession.limited.is_(True), DesktopSession.limit_cleared_at.is_not(None)) if include_waiting else DesktopSession.limited.is_(True),
            DesktopSession.state != "stopped",
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
    # story 4781 (AC1): on 10-25 nothing in the log said WHO a stopped-notice was meant for, so «did it reach the owner» could not be answered
    logger.info("desktop limit notice: stood setup=%s session=%s to=%s", setup.id, row.session_key, " ".join(member_prefix(p.member_id) for p in who))
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
        await _add_promised_setups(setup.org_id, person.user_id, [setup.id])  # folded into the notice that went: its promise covers this setup too
        logger.info("desktop limit notice: stood not sent (a notice went to this person within the window) setup=%s to=%s", setup.id, member_prefix(person.member_id))
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
            logger.warning("desktop limit notice: the stood notice reached nobody setup=%s session=%s to=%s", setup.id, row.session_key, member_prefix(person.member_id))
            return
        logger.info("desktop limit notice: stood sent setup=%s to=%s sent=%d", setup.id, member_prefix(person.member_id), sent)
        await _add_promised_setups(setup.org_id, person.user_id, [setup.id, *(r.setup_id for r in rows)])  # the promise is about THESE setups (merged, never replaced)
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
    promised = await _promised_setups(setup.org_id, person.user_id)
    if await _limited_rows(db, setup.org_id, person.user_id, also_setups=promised, include_waiting=True):
        logger.info("desktop limit notice: lifted not sent (some still stand) setup=%s to=%s", setup.id, member_prefix(person.member_id))
        if row.state != "stopped":
            # this session IS back, and nothing will ask again about it: remember it on the outstanding notice (Kadir lens 5235) — if the others then END instead of coming back, the
            # line is told rather than cleared silently (A works, B ends: A's «working again» would otherwise never be heard)
            open_record = await _take_open(setup.org_id, person.user_id)
            if open_record is not None:
                await _save_open(setup.org_id, person.user_id, {**open_record, "back": True})
        return  # some are still standing — «all working again» would be false
    record = await _take_open(setup.org_id, person.user_id)
    if record is None or (row.state == "stopped" and not record.get("back")):
        logger.info("desktop limit notice: lifted not sent (%s) setup=%s to=%s", "session ended" if record is not None else "nothing was promised", setup.id, member_prefix(person.member_id))
        return  # nothing was promised (or the session ended and no other had come back — not «working again»)
    locale = person.locale
    agent_id = uuid.UUID(record["agent"])
    others = int(record.get("others") or 0)
    name = await _agent_name(db, agent_id)
    kind = "many" if others else "one"
    sent = await dispatch_notification(
        db, org_id=setup.org_id, event_type="agent.limit_lifted", target_member_ids=[person.member_id],
        title=t(f"desktop_limit_notice.lifted.title_{kind}", locale, agent=name, others=others),
        body=t(f"desktop_limit_notice.lifted.body_{kind}", locale),
        reference_type="agent", reference_id=agent_id, source_project_id=setup.project_id,
        event={"payload": {"agent_name": name}},
    )
    logger.info("desktop limit notice: lifted sent setup=%s to=%s sent=%d", setup.id, member_prefix(person.member_id), sent)


async def _claim_due_lift(db: AsyncSession, row_id: uuid.UUID, cutoff: datetime) -> bool:
    """story 4781: take a waiting lift once — atomic, so two reports (or a report and the sweep, on two instances) never tell it twice. True = this call owns it."""
    got = await db.execute(
        update(DesktopSession).where(
            DesktopSession.id == row_id, DesktopSession.limit_cleared_at.is_not(None), DesktopSession.limit_cleared_at <= cutoff,
            DesktopSession.limited.is_not(True), DesktopSession.state != "stopped",
        ).values(limit_cleared_at=None).returning(DesktopSession.id)
    )
    return got.first() is not None


async def _tell_if_due(db: AsyncSession, setup: DesktopSetup, row: DesktopSession) -> None:
    """story 4781: the waiting lift of this row goes now if the limit has stayed gone for the hold (claimed once)"""
    cutoff = datetime.now(timezone.utc) - timedelta(seconds=LIFT_HOLD_SEC)
    if await _claim_due_lift(db, row.id, cutoff):
        await db.refresh(row)
        logger.info("desktop limit notice: lift told (the limit stayed gone) setup=%s session=%s", setup.id, row.session_key)
        await _lifted(db, setup, row)


async def after_report(db: AsyncSession, setup: DesktopSetup, row: DesktopSession, *, was_limited: bool) -> None:
    """Called after a report is written (flushed). `was_limited`: the row's `limited` BEFORE this report overwrote it.

    story 4781: a lift of a LIVE session is not told at once — `limit_cleared_at` marks it and the line goes when the limit has stayed gone for LIFT_HOLD_SEC (this call on a
    later report, or the sweep). A report that puts the limit back first cancels the waiting line AND the new «stopped» notice: the limit never lifted."""
    now_limited = bool(row.limited)
    try:
        async with db.begin_nested():  # a failure here rolls back to here — the state report itself stands
            if row.state == "stopped":
                had_wait = row.limit_cleared_at is not None
                row.limit_cleared_at = None  # an ended session waits for nothing (and a new session under the same key must not inherit a wait)
                if had_wait and now_limited == was_limited:
                    # the limit had been gone and the lift was waiting when the session ended: the notice outstanding for it is cleared without a line, as when a
                    # limited session ends (otherwise it stays open and a later session of the same person would be told a lift that was never this one's)
                    await _lifted(db, setup, row)
                    return
            elif now_limited and row.limit_cleared_at is not None:
                row.limit_cleared_at = None
                logger.info("desktop limit notice: lift cancelled (the limit came back before it was told) setup=%s session=%s", setup.id, row.session_key)
                return  # same episode: no second «stopped» either
            elif not now_limited and not was_limited and row.limit_cleared_at is not None:
                await _tell_if_due(db, setup, row)
                return
            if now_limited == was_limited:
                return
            if now_limited:
                await _stood(db, setup, row)
            elif row.state == "stopped":
                await _lifted(db, setup, row)  # the session ended: it clears the outstanding notice without a line (as before)
            else:
                row.limit_cleared_at = datetime.now(timezone.utc)
                await db.flush()
                logger.info("desktop limit notice: lift waits %ds (not told yet) setup=%s session=%s", LIFT_HOLD_SEC, setup.id, row.session_key)
                await _tell_if_due(db, setup, row)  # (a hold of 0 tells it now)
    except Exception:  # noqa: BLE001 — the notice is the echo of the record, never its condition
        logger.warning("desktop limit notice failed setup=%s session=%s", setup.id, row.session_key, exc_info=True)


async def sweep_due_lifts(db: AsyncSession) -> int:
    """story 4781: tell the lifts whose hold has run out although no report came (a long working turn reports nothing). Returns how many were told. One lift per call
    to `_lifted` inside its own savepoint; the caller commits."""
    cutoff = datetime.now(timezone.utc) - timedelta(seconds=LIFT_HOLD_SEC)
    due = (await db.execute(
        select(DesktopSession.id).where(
            DesktopSession.limit_cleared_at.is_not(None), DesktopSession.limit_cleared_at <= cutoff, DesktopSession.limited.is_not(True), DesktopSession.state != "stopped",
        ).order_by(DesktopSession.limit_cleared_at.asc()).limit(50)
    )).scalars().all()
    told = 0
    for row_id in due:
        try:
            async with db.begin_nested():
                if not await _claim_due_lift(db, row_id, cutoff):
                    continue  # another instance (or a report) took it
                row = await db.get(DesktopSession, row_id)
                setup = await db.get(DesktopSetup, row.setup_id) if row is not None else None
                if row is None or setup is None:
                    continue
                logger.info("desktop limit notice: lift told (the limit stayed gone, sweep) setup=%s session=%s", setup.id, row.session_key)
                await _lifted(db, setup, row)
                told += 1
        except Exception:  # noqa: BLE001
            logger.warning("desktop limit notice: the sweep failed for one lift session_id=%s", row_id, exc_info=True)
    return told


async def lift_sweep_loop() -> None:
    """story 4781: the sweep, every LIFT_SWEEP_SEC, on a session of its own (every instance runs it; the claim above keeps a lift to one telling)."""
    import asyncio

    from app.core.database import async_session_factory

    while True:
        try:
            await asyncio.sleep(LIFT_SWEEP_SEC)
            async with async_session_factory() as db:
                if await sweep_due_lifts(db):
                    await db.commit()
                else:
                    await db.rollback()
        except asyncio.CancelledError:
            raise
        except Exception:  # noqa: BLE001 — a failed sweep tries again at the next tick
            logger.warning("desktop limit notice: the lift sweep failed", exc_info=True)
