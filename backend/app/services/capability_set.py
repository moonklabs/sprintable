"""story 5025 (C1 · contract v1.2 §3 · §5 · §6) — what each pinned PHONE may do with each AGENT of a computer, SIGNED by the server so that the computer's second layer can check it.

The first layer is the server's own (`can_command` · `can_view` — the very functions the command endpoints use); this module turns their answers into ONE signed object per computer (`capability_set`) and hands it to the
computer three ways: pushed down its relay stream on every change and every half life, pulled whole when the host (re)connects, and — the keys it checks with — in the setup exchange and a pull of their own.

What it is NOT: it is not a second source of truth (the set is computed from the same functions, at the moment it is signed), it adds no permission (a phone gets `control` only where `can_command` says so, `read` only
where `can_view` says so) and it holds no secret but the signing key. A server without a signing key is a server WITHOUT this road: nothing is offered, nothing is pushed, a host sees an older server.

The signing key is NEVER the JWT secret, the local-bootstrap secret or the repository-signing secret (`app.core.config` · `capability_signing_key` / `capability_signing_key_file`). A KMS-held key (the hosted production plan)
is a second way to fill `_load_keys` and is not in this change.
"""
from __future__ import annotations

import base64
import functools
import hashlib
import json
import logging
import os
import re
import time
import uuid
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from pathlib import Path

from cryptography.hazmat.primitives import serialization
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey
from sqlalchemy import func, select, update
from sqlalchemy.dialects.postgresql import insert as pg_insert
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.config import settings
from app.models.agent_permission import RemoteDevice, RemoteDevicePairing
from app.models.desktop_relay import DesktopCapabilityRejection
from app.models.desktop_setup import DesktopSetup
from app.core.database import async_session_factory
from app.services.desktop_relay import DISCONNECTED_CODE, DesktopRelayError, enqueue_command

logger = logging.getLogger(__name__)

CAPABILITY_DOMAIN = b"sprintable/capability_set/v1\n"  # what is signed = this ‖ the payload bytes (a signature for one thing is never one for another)
ROTATE_DOMAIN = b"sprintable/attest_rotate/v1\n"
LIFETIME = timedelta(minutes=10)  # `exp` = `iat` + this: the bound of how late a revocation can be (§3.2)
HALF_LIFE = timedelta(minutes=5)  # a computer that is connected hears a fresh set at least this often
ROTATE_LIFETIME = timedelta(minutes=10)  # a rotation envelope is issued fresh with every attest-keys answer over TLS and is good for this long — a captured one is dead the same way an old set is (a replay can not hand a host on to a key later)
ATTEST_LIMIT = "6/minute"  # the keys pull signs one envelope per retired key each time: a few a minute per computer (a host that is refused waits and asks again, like a pull)
PULL_LIMIT = "1/10 seconds"  # a pull is a computer's own: once in ten seconds (§3.2 · memo ④ — a host that is refused waits and asks again)
REPORT_LIMIT = "12/minute"  # the rejection report: a few a minute (§6)
REJECTION_CODES = ("no_capability", "capability_expired", "not_in_seal_to")
MAX_REJECTIONS_PER_REPORT = 50
MAX_COUNT_PER_ENTRY = 10_000
MAX_COUNT_TOTAL = 10**12  # a row's count never passes this (a BIGINT with room, an addition that cannot wrap)


def _b64u(raw: bytes) -> str:
    return base64.urlsafe_b64encode(raw).rstrip(b"=").decode("ascii")


def _unb64u(text: str) -> bytes:
    return base64.urlsafe_b64decode(text + "=" * (-len(text) % 4))


# ── the keys ──────────────────────────────────────────────────────────────────────────────────────────────────────────────


@dataclass(frozen=True)
class SigningKey:
    private: Ed25519PrivateKey
    public: str  # base64url of the 32 raw public bytes
    kid: str  # a short name for the PUBLIC key (never a secret): «ak1-» + the first 16 hex of its sha256

    def sign(self, domain: bytes, payload: bytes) -> str:
        return _b64u(self.private.sign(domain + payload))


def _from_seed(seed_text: str) -> SigningKey:
    seed = _unb64u(seed_text.strip())
    if len(seed) != 32:
        raise ValueError("a capability signing key is a 32-byte Ed25519 seed")
    private = Ed25519PrivateKey.from_private_bytes(seed)
    raw = private.public_key().public_bytes(serialization.Encoding.Raw, serialization.PublicFormat.Raw)
    return SigningKey(private=private, public=_b64u(raw), kid="ak1-" + hashlib.sha256(raw).hexdigest()[:16])


_POSIX_FILE_MODES = os.name == "posix"  # a Windows file has no 0600: its st_mode shows group/other bits whatever its ACL says — the mode check is for the systems that have one (a Windows supervisor keeps the file in the user's own data folder)
_OTHER_SECRET_NAME = re.compile(r"(secret|signing|password|token|api_key|private_key)", re.IGNORECASE)


def _other_secrets() -> set[str]:
    """The values of the server's OTHER secrets, read from its own settings by NAME (a new secret setting is covered the day it is added): every setting whose name says secret · signing · password · token · api key · private key,
    except this module's own `capability_*` ones. Used only to refuse a signing key that is the same string as one of them (story 5025 C1 follow-up: «never the JWT secret…» was a sentence and a test of this file's source; this is the runtime check)."""
    out: set[str] = set()
    for name in type(settings).model_fields:
        if name.startswith("capability_") or not _OTHER_SECRET_NAME.search(name):
            continue
        value = getattr(settings, name, None)
        if isinstance(value, str) and len(value.strip()) >= 8:
            out.add(value.strip())
    for name, value in os.environ.items():  # the secrets this server reads straight from its environment (CRON_SECRET · SLACK_SIGNING_SECRET · STORAGE_LOCAL_SIGNING_SECRET …) are not in `settings`: same name rule
        if name.upper().startswith("CAPABILITY_") or not _OTHER_SECRET_NAME.search(name):
            continue
        if len(value.strip()) >= 8:
            out.add(value.strip())
    return out


def _load_keys() -> tuple[SigningKey | None, list[SigningKey]]:
    """(the current key | None, the retired keys). None → the capability road is off. A key that does not read as a key is a configuration error — logged once per call, never silently «off» for a half-set server: the road is
    off (nothing is signed with a wrong key) and the log says so. Three more reasons for «off», all logged without the value: a key FILE that others can read or write (mode & 0o077 — it is a private key: 0600 or nothing), a key that is the very
    same string as another secret of this server (the signing key is its own secret), and a malformed one."""
    seed = (settings.capability_signing_key or "").strip()
    if not seed and settings.capability_signing_key_file:
        try:
            path = Path(settings.capability_signing_key_file)
            mode = os.stat(path).st_mode
            if _POSIX_FILE_MODES and mode & 0o077:
                logger.error("capability_signing_key_file is accessible to other users (mode %04o): the capability road is off — make it 0600", mode & 0o777)
                return None, []
            seed = path.read_text(encoding="utf8").strip()
        except OSError:
            logger.error("capability_signing_key_file cannot be read: the capability road is off")
            return None, []
    if not seed:
        return None, []
    retired_texts = [t.strip() for t in (settings.capability_retired_keys or "").split(",") if t.strip()]
    if {seed, *retired_texts} & _other_secrets():
        logger.error("a capability signing key is the same string as another secret of this server: the capability road is off — the signing key is its own secret")
        return None, []
    try:
        current = _from_seed(seed)
        retired = [_from_seed(t) for t in retired_texts]
    except Exception:  # noqa: BLE001 — a malformed key never raises into a request: the road is off
        logger.error("a capability signing key is malformed: the capability road is off")
        return None, []
    return current, [k for k in retired if k.kid != current.kid]


def server_time() -> str:
    return _iso(datetime.now(timezone.utc))


def enabled() -> bool:
    return _load_keys()[0] is not None


def attest_keys() -> list[dict]:
    """The keys a host checks sets with (§5.3): `[{kid, public_key}]`. Empty when the road is off — the field is then left out of every answer (an older server's answer, byte for byte)."""
    current, _ = _load_keys()
    return [] if current is None else [{"kid": current.kid, "public_key": current.public}]


def rotations() -> list[dict]:
    """The rotation door (§5.3): for each RETIRED key, one envelope signed BY that key saying «add the current key · remove me». A host that pinned the retired key accepts the new list only through such a door; a host that pinned
    nothing ignores it. Issued fresh each time (the `iat` is now)."""
    current, retired = _load_keys()
    if current is None:
        return []
    out = []
    now = datetime.now(timezone.utc)
    for old in retired:
        payload = _canonical({
            "kind": "attest_rotate", "v": 1, "add": [{"kid": current.kid, "public_key": current.public}], "remove": [old.kid],
            "epoch": int(settings.capability_epoch), "iat": _iso(now), "exp": _iso(now + ROTATE_LIFETIME),
        })
        out.append({"v": 1, "kid": old.kid, "p": _b64u(payload), "sig": old.sign(ROTATE_DOMAIN, payload)})
    return out


# ── the set ───────────────────────────────────────────────────────────────────────────────────────────────────────────────


def _canonical(obj: dict) -> bytes:
    return json.dumps(obj, separators=(",", ":"), sort_keys=True, ensure_ascii=False).encode("utf8")


def _iso(at: datetime) -> str:
    return at.astimezone(timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")


async def compute_caps(db: AsyncSession, setup: DesktopSetup) -> list[dict]:
    """The set, from the SAME functions the endpoints use: for every ACTIVE pin of this computer (not removed, key not revoked, key of this organization) × every agent of the computer —
    `control` when `can_command` says so and `read` when `can_view` says so. An entry with no action is left out. §4: when pins of more than one PERSON are on the computer only a key that proved it holds its private key
    (`pop_verified_at`) is in the set; a computer of one person keeps its older unproved keys (C1). A pin the server has no key for is not here at all. Sorted — so the same facts always make the same bytes (and the same hash)."""
    from app.models.member import Member
    from app.services.desktop_commands import can_command, can_view, org_role

    rows = (await db.execute(
        select(RemoteDevice.id, RemoteDevice.member_id, RemoteDevice.pop_verified_at)
        .join(RemoteDevicePairing, RemoteDevicePairing.remote_device_id == RemoteDevice.id)
        .where(RemoteDevicePairing.setup_id == setup.id, RemoteDevicePairing.removed_at.is_(None), RemoteDevice.revoked_at.is_(None), RemoteDevice.org_id == setup.org_id)
    )).all()
    mixed = len({r.member_id for r in rows}) > 1
    phones = [r for r in rows if r.pop_verified_at is not None or not mixed]
    agent_ids = sorted({uuid.UUID(m["member_id"]) for m in (setup.members or []) if m.get("kind") == "agent" and m.get("member_id")})
    if not phones or not agent_ids:
        return []
    agents = {a.id: a for a in (await db.execute(
        select(Member).where(Member.id.in_(agent_ids), Member.org_id == setup.org_id, Member.type == "agent", Member.deleted_at.is_(None))
    )).scalars().all()}
    people: dict[uuid.UUID, tuple[uuid.UUID | None, str | None]] = {}
    for member_id in {r.member_id for r in phones}:
        row = (await db.execute(select(Member.user_id, Member.is_active).where(Member.id == member_id, Member.org_id == setup.org_id, Member.deleted_at.is_(None)))).first()
        user_id = row.user_id if row is not None and row.is_active else None  # (codex: a person who was removed from the organization — deactivated or deleted — keeps their paired keys; they name nothing)
        role = await org_role(db, setup.org_id, user_id) if user_id is not None else None
        people[member_id] = (user_id if role is not None else None, role)  # …and a person with no live seat in the organization is no one either (`org_role` reads only a live seat)
    caps: list[dict] = []
    for phone in sorted(phones, key=lambda r: str(r.id)):
        user_id, role = people.get(phone.member_id, (None, None))
        if user_id is None:
            continue  # a key of a person who is no longer here has no right to name
        for agent_id in agent_ids:
            agent = agents.get(agent_id)
            if agent is None:
                continue
            actions = []
            if can_command(member_id=phone.member_id, member_role=role, user_id=user_id, agent=agent, setup=setup):
                actions.append("control")
            if await can_view(db, user_id=user_id, org_id=setup.org_id, agent_id=agent_id):
                actions.append("read")
            if actions:
                caps.append({"phone_key_id": str(phone.id), "agent_member_id": str(agent_id), "actions": actions})
    return caps


def caps_hash(caps: list[dict]) -> str:
    return hashlib.sha256(_canonical({"caps": caps})).hexdigest()


async def _next_serial(db: AsyncSession, setup_id: uuid.UUID) -> int:
    """`serial = max(previous + 1, unix_ms)` (memo ②): taken in one statement under the row's lock. A database restored to an older state still hands out a serial ABOVE anything a host has seen, because the clock is ahead of it."""
    unix_ms = int(time.time() * 1000)
    return int((await db.execute(
        update(DesktopSetup).where(DesktopSetup.id == setup_id).values(capability_serial=func.greatest(DesktopSetup.capability_serial + 1, unix_ms))
        .returning(DesktopSetup.capability_serial)
    )).scalar_one())


async def _lock_fresh(db: AsyncSession, setup_id: uuid.UUID) -> DesktopSetup | None:
    """The computer's row, LOCKED and RE-READ: the object a request carries was loaded earlier (its `members` · `confirmed_by` may be older than a change that has since committed — an agent moved off this computer);
    the facts a set is computed from, and the serial it is given, come from the row as it is under the lock."""
    return (await db.execute(
        select(DesktopSetup).where(DesktopSetup.id == setup_id).with_for_update().execution_options(populate_existing=True)
    )).scalar_one_or_none()


async def build_envelope(db: AsyncSession, setup: DesktopSetup, caps: list[dict] | None = None) -> dict | None:
    """The signed set, as it goes down: `{v, kid, p, sig}` where `p` is base64url of the bytes that were signed (the verifier checks THOSE bytes, then parses them). None when the road is off."""
    current, _ = _load_keys()
    if current is None:
        return None
    # the computer's row is locked FIRST (a lock this transaction already holds is held again for nothing), and only then are the facts read and the serial taken — so a set's serial is in the order the changes COMMITTED:
    # a pull that read the facts before an unpair committed can never be handed a serial above the push that carries the unpair (codex: a stale set with a newer serial would bring a removed capability back)
    fresh = await _lock_fresh(db, setup.id)
    if fresh is None:
        return None
    if fresh.revoked_at is not None:  # a request that was let in before the cut-off and got the lock after it commits is told the truth — no new set (codex: it would extend what a cut-off took away)
        raise DesktopRelayError(409, DISCONNECTED_CODE, "that computer has been disconnected")
    setup = fresh
    if caps is None:
        caps = await compute_caps(db, setup)
    now = datetime.now(timezone.utc)
    payload = _canonical({
        "kind": "capability_set", "v": 1, "setup_id": str(setup.id), "epoch": int(settings.capability_epoch),
        "serial": await _next_serial(db, setup.id), "caps": caps, "iat": _iso(now), "exp": _iso(now + LIFETIME),
    })
    return {"v": 1, "kid": current.kid, "p": _b64u(payload), "sig": current.sign(CAPABILITY_DOMAIN, payload)}


async def push_capability_set(db: AsyncSession, setup: DesktopSetup, *, force: bool = False) -> bool:
    """Tell the computer what its phones may do now — when the set CHANGED since the last one pushed (or `force`: its half life is over). Called inside the transaction that changed something, so the command and the change
    are one commit. False (and nothing written) when the road is off, the computer is cut off, remote control is off for the organization, or nothing changed."""
    if not enabled() or setup.revoked_at is not None or setup.exchanged_at is None or setup.org_id is None:
        return False
    setup = await _lock_fresh(db, setup.id)  # (locked and re-read: the cut-off mark, the agents and the confirmer are the ones under the lock)
    if setup is None or setup.revoked_at is not None:
        return False
    last = setup.capability_hash
    caps = await compute_caps(db, setup)
    h = caps_hash(caps)
    if not force and last == h:
        return False
    envelope = await build_envelope(db, setup, caps)
    if envelope is None:
        return False
    serial = json.loads(_unb64u(envelope["p"]))["serial"]
    try:
        await enqueue_command(db, setup=setup, kind="capability_set", payload={"envelope": envelope}, idempotency_key=f"capset:{serial}", requested_by=setup.id)
    except DesktopRelayError:  # remote control is off · the computer was just cut off: there is nothing to tell
        return False
    await db.execute(update(DesktopSetup).where(DesktopSetup.id == setup.id).values(capability_hash=h, capability_pushed_at=func.now()))
    return True


async def tell(db: AsyncSession, setup_ids) -> None:
    """After a pairing or a key was changed: push the new set of each computer concerned — AFTER the change has committed, in a session of its own that holds nothing else (codex: pushing inside the changing transaction took the
    computer's row after the pairing rows, while other requests take the row first and the pairing rows next — a lock-order cycle; a push that starts from nothing can only wait, never cycle). The change never waits for it and never
    fails because of it: a push that cannot be made (a signing error · a lock that could not be taken) is left to the NEXT change or the half life, at most five minutes away (the set expires after ten). A change that rolls back
    schedules nothing (`schedule_after_commit` drops what a rolled-back transaction scheduled)."""
    if not enabled():
        return
    from app.services.after_commit import schedule_after_commit

    schedule_after_commit(db, [functools.partial(_push_after_commit, setup_id) for setup_id in sorted({s for s in setup_ids}, key=str)])


async def _push_after_commit(setup_id: uuid.UUID) -> None:
    try:
        async with async_session_factory() as s:
            setup = await s.get(DesktopSetup, setup_id)
            if setup is not None and await push_capability_set(s, setup):
                await s.commit()
    except Exception:  # noqa: BLE001 — logged; the next change or the half life carries it
        logger.exception("capability_set push failed for a computer: left to the next change or the half life")


async def pull(db: AsyncSession, setup: DesktopSetup) -> dict | None:
    """What the computer asks for when it (re)connects: the WHOLE current set, signed now (the host REPLACES what it holds with it — a revocation it missed closes at that moment). `server_time` rides along for its clock
    (the skew comes from a response the host opened itself, never from a set)."""
    envelope = await build_envelope(db, setup)
    if envelope is None:
        return None
    return {"envelope": envelope, "server_time": server_time()}


# ── what a host says of its own refusals (§6) ──────────────────────────────────────────────────────────────────────────────


async def record_rejections(db: AsyncSession, setup: DesktopSetup, entries: list[dict]) -> int:
    """Add the host's counts. Each entry is {code, phone_key_id, agent_member_id, count, at?}: a closed word, two ids that are the server's own, a count. Nothing about WHAT was refused. Returns how many entries were taken.

    «Two ids that are the server's own» is CHECKED: the phone must be one this computer was ever paired with (a pairing row of THIS computer, removed or not: a late refusal of a phone that has just been removed is true) and the agent one of
    this computer's own agents; any other entry is dropped, not stored and not counted. So the table of a computer can never hold more than 3 words × its phones × its agents — a computer cannot fill it with ids it makes up."""
    phone_ids = {r for (r,) in (await db.execute(select(RemoteDevicePairing.remote_device_id).where(RemoteDevicePairing.setup_id == setup.id))).all()}
    agent_ids = {uuid.UUID(str(m["member_id"])) for m in (setup.members or []) if m.get("kind") == "agent" and m.get("member_id")}
    taken = 0
    now = datetime.now(timezone.utc)
    for e in entries:
        if uuid.UUID(str(e["phone_key_id"])) not in phone_ids or uuid.UUID(str(e["agent_member_id"])) not in agent_ids:
            continue
        stmt = pg_insert(DesktopCapabilityRejection).values(
            setup_id=setup.id, code=e["code"], phone_key_id=e["phone_key_id"], agent_member_id=e["agent_member_id"], count=e["count"], last_at=now,
        )
        await db.execute(stmt.on_conflict_do_update(
            index_elements=["setup_id", "code", "phone_key_id", "agent_member_id"],
            set_={"count": func.least(DesktopCapabilityRejection.count + stmt.excluded.count, MAX_COUNT_TOTAL), "last_at": now},
        ))
        taken += 1
    return taken
