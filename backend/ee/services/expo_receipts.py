"""story #4396 — Expo push receipts (getReceipts): catch failures that only show up after an ok ticket.

An ok ticket from /push/send only means Expo accepted the message. Failures at FCM / APNs — and `DeviceNotRegistered` for a
token that stopped working — appear only in the receipt, which Expo makes available later. Before this module nothing read
receipts (expo_push.py deferred it), so dead tokens stayed active and those failures were invisible.

Expo's receipts API (docs.expo.dev/push-notifications/sending-notifications · Last Updated 2026-09-25):
- POST https://exp.host/--/api/v2/push/getReceipts {"ids": [...]} → {"data": {ticket_id: {"status": "ok"|"error",
  "message"?, "details"?: {"error"?}}}}
- «We recommend checking push receipts 15 minutes after sending» · «Push receipts are cleared after 24 hours.» ·
  1000 (or fewer) ticket ids per request.

Storage (PO 17:20Z): Redis only, no table / migration.
- ZSET `expo:receipts:due` — member = ticket id, score = when to check (sent + 15 min).
- HASH `expo:receipt:<ticket id>` — device_id · org_id · platform · sent_at, TTL 24 h. **No token value.**
- Without Redis (OSS / local) receipts are simply not checked — the same as before this module.

Checking runs inside the in-process delivery dispatcher loop (every backend instance). A ticket is taken with ZREM: only the
instance whose ZREM removed it processes it, so instances never check the same ticket twice.
"""
from __future__ import annotations

import json
import logging
import time
import uuid
from collections import Counter

import httpx
from sqlalchemy import update

logger = logging.getLogger(__name__)

_EXPO_RECEIPTS_URL = "https://exp.host/--/api/v2/push/getReceipts"
DUE_KEY = "expo:receipts:due"
_HASH_PREFIX = "expo:receipt:"
CHECK_AFTER_SECONDS = 15 * 60  # Expo's recommendation
RECEIPT_LIFETIME_SECONDS = 24 * 3600  # Expo clears receipts after 24 h
RETRY_AFTER_SECONDS = 5 * 60  # result unknown (Expo 5xx · network · receipt not ready yet) → look again later
MAX_IDS_PER_REQUEST = 1000

_client = None


def _redis():
    """The Redis client, or None when Redis is not configured (then receipts are not tracked)."""
    global _client
    from app.core.config import settings

    if not settings.redis_url:
        return None
    if _client is None:
        import redis.asyncio as aioredis

        _client = aioredis.from_url(settings.redis_url, decode_responses=True)
    return _client


def _hash_key(ticket_id: str) -> str:
    return f"{_HASH_PREFIX}{ticket_id}"


async def record_expo_tickets(org_id: uuid.UUID, tickets: list[tuple[str, uuid.UUID, str | None]]) -> None:
    """Remember ok tickets (ticket id · push_device id · platform) so their receipts are checked later. Best-effort: a Redis
    failure is logged and swallowed — sending already happened and must not fail because of this."""
    r = _redis()
    if r is None or not tickets:
        return
    now = time.time()
    try:
        pipe = r.pipeline(transaction=False)
        for ticket_id, device_id, platform in tickets:
            key = _hash_key(ticket_id)
            pipe.hset(key, mapping={
                "device_id": str(device_id), "org_id": str(org_id), "platform": platform or "", "sent_at": str(now),
            })
            pipe.expire(key, RECEIPT_LIFETIME_SECONDS)
            pipe.zadd(DUE_KEY, {ticket_id: now + CHECK_AFTER_SECONDS})
        await pipe.execute()
    except Exception:  # noqa: BLE001 — best-effort: sending already happened; any Redis failure only skips the receipt check
        logger.warning("expo receipts: could not record %d ticket(s) — their receipts will not be checked", len(tickets))


async def _fetch_receipts(ids: list[str]) -> dict[str, dict]:
    """POST getReceipts for ≤1000 ids. Raises on transport errors and on a non-2xx answer (the caller re-queues)."""
    async with httpx.AsyncClient(timeout=10.0) as client:
        resp = await client.post(
            _EXPO_RECEIPTS_URL,
            content=json.dumps({"ids": ids}),
            headers={"content-type": "application/json", "accept": "application/json"},
        )
    resp.raise_for_status()
    data = resp.json().get("data") or {}
    return data if isinstance(data, dict) else {}


async def _deactivate_devices(org_id: uuid.UUID, device_ids: list[uuid.UUID]) -> None:
    """DeviceNotRegistered → is_active=false, in its **own** session (never the dispatcher's): a failure here must not expire
    another step's ORM objects or roll back anything else."""
    from app.core.database import async_session_factory
    from app.models.push_device import PushDevice

    async with async_session_factory() as session:
        await session.execute(
            update(PushDevice)
            .where(PushDevice.org_id == org_id, PushDevice.id.in_(device_ids))
            .values(is_active=False)
        )
        await session.commit()


async def check_due_expo_receipts(now: float | None = None, limit: int = MAX_IDS_PER_REQUEST) -> None:
    """One pass: drop entries older than a receipt can live, take due tickets, read their receipts, act on them."""
    r = _redis()
    if r is None:
        return
    now = time.time() if now is None else now

    # 1. Sweep: hashes expire by TTL, ZSET members do not. Anything scheduled for a moment past Expo's 24 h is useless.
    await r.zremrangebyscore(DUE_KEY, "-inf", now - RECEIPT_LIFETIME_SECONDS)

    # 2. Take due tickets. ZREM decides who owns each one: only the instance that removed it processes it.
    candidates = await r.zrangebyscore(DUE_KEY, "-inf", now, start=0, num=limit)
    if not candidates:
        return
    pipe = r.pipeline(transaction=False)
    for ticket_id in candidates:
        pipe.zrem(DUE_KEY, ticket_id)
    removed = await pipe.execute()
    mine = [t for t, n in zip(candidates, removed) if n]
    if not mine:
        return
    pipe = r.pipeline(transaction=False)
    for ticket_id in mine:
        pipe.hgetall(_hash_key(ticket_id))
    metas = await pipe.execute()
    tickets = {t: m for t, m in zip(mine, metas) if m}  # a missing hash (TTL passed) is dropped quietly

    if not tickets:
        return

    async def requeue(ids: list[str]) -> None:
        """Result unknown → look again later, unless the receipt would already be gone by then."""
        pipe = r.pipeline(transaction=False)
        for t in ids:
            sent_at = float(tickets[t].get("sent_at") or 0)
            if now + RETRY_AFTER_SECONDS < sent_at + RECEIPT_LIFETIME_SECONDS:
                pipe.zadd(DUE_KEY, {t: now + RETRY_AFTER_SECONDS})
        await pipe.execute()

    ids = list(tickets)
    try:
        receipts = await _fetch_receipts(ids)
    except Exception as exc:  # noqa: BLE001 — any failure here means «result unknown» → re-queue, never an error of the push
        # Expo 5xx · 429 · network: the result is unknown, not an error of the push — not counted, just looked at again.
        logger.info("expo receipts: getReceipts unavailable (%s) — %d ticket(s) re-queued", type(exc).__name__, len(ids))
        await requeue(ids)
        _log_pass(checked=len(ids), ok=0, error=0, requeued=len(ids), deactivated=0)
        return

    not_ready = [t for t in ids if t not in receipts]
    if not_ready:
        await requeue(not_ready)

    dead: dict[uuid.UUID, list[uuid.UUID]] = {}
    errors: Counter[tuple[str, str, str]] = Counter()
    for t, receipt in receipts.items():
        meta = tickets.get(t)
        if meta is None or not isinstance(receipt, dict) or receipt.get("status") != "error":
            continue
        error = str((receipt.get("details") or {}).get("error") or "unknown")
        errors[(error, meta.get("org_id", ""), meta.get("platform", ""))] += 1
        if error == "DeviceNotRegistered":
            dead.setdefault(uuid.UUID(meta["org_id"]), []).append(uuid.UUID(meta["device_id"]))

    for (error, org_id, platform), count in errors.items():
        # One line per kind · org · platform. No token and no ticket id.
        logger.warning(
            "expo receipt errors",
            extra={"structured": {
                "event": "expo_receipt_error", "error": error, "org_id": org_id, "platform": platform or None, "count": count,
            }},
        )
    for org_id, device_ids in dead.items():
        await _deactivate_devices(org_id, device_ids)
        logger.info("expo receipts: deactivated %d DeviceNotRegistered device(s) org=%s", len(device_ids), org_id)
    ok = sum(1 for r in receipts.values() if isinstance(r, dict) and r.get("status") == "ok")
    _log_pass(
        checked=len(ids), ok=ok, error=sum(errors.values()), requeued=len(not_ready),
        deactivated=sum(len(v) for v in dead.values()),
    )


def _log_pass(*, checked: int, ok: int, error: int, requeued: int, deactivated: int) -> None:
    """One line per pass that took tickets — counts only (no token, no ticket id). A normal notification shows up here as
    ok=1 about 15 min after sending (the live check of AC4)."""
    logger.info(
        "expo receipts checked",
        extra={"structured": {
            "event": "expo_receipt_check", "checked": checked, "ok": ok, "error": error,
            "requeued": requeued, "deactivated": deactivated,
        }},
    )
