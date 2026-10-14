"""story #4685 (AC1 · PO 10-14 00:27Z) — an agent on a person's computer stands at the usage limit: the person who connected that
computer is told, once; and once more when work starts again.

10-13: five lanes stood for 30 minutes (and, with no reset time read, for 7 hours) and nobody was told — the only notice a limit
had was the turn-end one a phone's [지금 지시] earned, which a session with no instruction pending never earns. Words: Yuna's
`limit-notice-1014.md`, as written (i18n_catalog `desktop_limit_notice.*` + the existing paused_limit title).

- «stood» = a report moves a session from not-limited to limited (`DesktopSession.limited`, read BEFORE the report overwrites it —
  no column needed). Told to `setup.confirmed_by` (the person who connected the computer), in their language, the reset time in the
  org's zone. A window of WINDOW_SEC per computer folds the others that stand soon after into the same notice (the first one goes at
  once — AC3's «within a minute»); the count in it is the sessions that stand at that moment.
- «lifted» = the last limited session of that computer leaves the limit (and one stood notice is outstanding): told once, with the
  same agent and count as that «stood» notice. A session that is later than the window still counts: the line goes only when ALL
  are back (a false «all working» would be worse than a late line). A session that ENDS is not «working again» — it clears the
  outstanding notice without a line.
- A failure here never fails the state report (the work is in a savepoint; the report is the record, the notice is its echo).
- Redis keeps the window and the outstanding notice across instances; without Redis they live in this process (a restart forgets —
  the cost is one missing «lifted» line, never a duplicate «stood»).
"""
from __future__ import annotations

import json
import logging
import time
import uuid
from datetime import datetime, timezone
from zoneinfo import ZoneInfo

from sqlalchemy import select
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


def _key(kind: str, setup_id: uuid.UUID) -> str:
    return redis_shared.key(_DOMAIN, kind, str(setup_id))


def _local_get(key: str) -> str | None:
    hit = _local.get(key)
    if hit is None:
        return None
    if hit[0] <= time.monotonic():
        _local.pop(key, None)
        return None
    return hit[1]


async def _claim_window(setup_id: uuid.UUID) -> bool:
    """True = this report owns the window (its notice goes); False = a notice for this computer went within WINDOW_SEC."""
    key = _key("window", setup_id)

    async def _op(client) -> bool:
        return bool(await client.set(key, "1", nx=True, ex=WINDOW_SEC))

    def _fallback() -> bool:
        if _local_get(key) is not None:
            return False
        _local[key] = (time.monotonic() + WINDOW_SEC, "1")
        return True

    return await redis_shared.with_fallback(_op, _fallback)


async def _release_window(setup_id: uuid.UUID) -> None:
    key = _key("window", setup_id)

    async def _op(client) -> None:
        await client.delete(key)

    def _fallback() -> None:
        _local.pop(key, None)

    await redis_shared.with_fallback(_op, _fallback)


async def _save_open(setup_id: uuid.UUID, record: dict) -> None:
    key, value = _key("open", setup_id), json.dumps(record)

    async def _op(client) -> None:
        await client.set(key, value, ex=OPEN_TTL_SEC)

    def _fallback() -> None:
        _local[key] = (time.monotonic() + OPEN_TTL_SEC, value)

    await redis_shared.with_fallback(_op, _fallback)


async def _take_open(setup_id: uuid.UUID) -> dict | None:
    """The outstanding «stood» record, removed in the same step (the «lifted» line goes once)."""
    key = _key("open", setup_id)

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


async def _recipient(db: AsyncSession, setup: DesktopSetup) -> tuple[uuid.UUID, str] | None:
    """(the member to tell, their language) — whoever connected the computer, if still an active member of the org."""
    from app.models.member import Member
    from app.models.user import User
    from app.services.agent_onboarding_config import SUPPORTED_LOCALES
    from app.services.org_locale import resolve_org_locale

    if setup.confirmed_by is None:
        return None
    member_id = (await db.execute(
        select(Member.id).where(
            Member.org_id == setup.org_id, Member.type == "human", Member.user_id == setup.confirmed_by,
            Member.deleted_at.is_(None), Member.is_active.is_(True),
        )
    )).scalars().first()
    if member_id is None:
        return None
    locale = (await db.execute(select(User.locale).where(User.id == setup.confirmed_by))).scalar_one_or_none()
    return member_id, locale if locale in SUPPORTED_LOCALES else await resolve_org_locale(db, setup.org_id)


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


async def _limited_rows(db: AsyncSession, setup_id: uuid.UUID) -> list[DesktopSession]:
    return list((await db.execute(
        select(DesktopSession).where(
            DesktopSession.setup_id == setup_id, DesktopSession.limited.is_(True), DesktopSession.state != "stopped",
        ).order_by(DesktopSession.state_at.asc(), DesktopSession.id.asc())
    )).scalars().all())


async def _agent_name(db: AsyncSession, agent_id: uuid.UUID) -> str:
    from app.models.member import Member

    return (await db.execute(select(Member.name).where(Member.id == agent_id))).scalar_one_or_none() or ""


async def _stood(db: AsyncSession, setup: DesktopSetup, row: DesktopSession) -> None:
    from app.models.organization import Organization
    from app.services.i18n_catalog import t
    from app.services.notification_dispatch import dispatch_notification
    from app.services.org_time import org_tz

    who = await _recipient(db, setup)
    if who is None:
        logger.info("desktop limit notice: nobody to tell setup=%s (not connected by an active member)", setup.id)
        return
    member_id, locale = who
    if not await _claim_window(setup.id):
        return
    try:
        rows = await _limited_rows(db, setup.id)
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
            db, org_id=setup.org_id, event_type="agent.limit_paused", target_member_ids=[member_id], title=title, body=body,
            reference_type="agent", reference_id=agents[0], source_project_id=setup.project_id,
            event={"payload": {"agent_name": name}},
        )
        if not sent:
            # the dispatcher answers 0 (it does not raise) when it told nobody — a failure it swallowed, or a person whose settings turn
            # the notice off. Nothing was told: the window is let go (the next report may still tell it) and nothing is promised — else
            # the person would never hear «stopped» and later hear only «working again», and for five minutes no report could tell it
            # (Kadir's codex lens ③, 10-14)
            await _release_window(setup.id)
            logger.warning("desktop limit notice: the stood notice reached nobody setup=%s session=%s", setup.id, row.session_key)
            return
        await _save_open(setup.id, {"agent": str(agents[0]), "others": others})
    except Exception:
        await _release_window(setup.id)  # nothing was told: the next report may still tell it
        raise


async def _lifted(db: AsyncSession, setup: DesktopSetup, row: DesktopSession) -> None:
    from app.services.i18n_catalog import t
    from app.services.notification_dispatch import dispatch_notification

    if await _limited_rows(db, setup.id):
        return  # some are still standing — «all working again» would be false
    record = await _take_open(setup.id)
    if record is None or row.state == "stopped":
        return  # nothing was promised (or the session ended — not «working again»)
    who = await _recipient(db, setup)
    if who is None:
        return
    member_id, locale = who
    agent_id = uuid.UUID(record["agent"])
    others = int(record.get("others") or 0)
    name = await _agent_name(db, agent_id)
    kind = "many" if others else "one"
    await dispatch_notification(
        db, org_id=setup.org_id, event_type="agent.limit_lifted", target_member_ids=[member_id],
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
