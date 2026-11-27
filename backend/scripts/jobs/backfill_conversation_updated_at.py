"""story 5053: put the rooms that are out of step back in step — `conversations.updated_at` = the time of the room's last message (idempotent chunked batch · dry-run by default).

Why a job and not part of migration 0506: the trigger of 0506 keeps every room in step from now on, but the rooms that were left behind by the roads that never raised the time (the approval card, the
activation / approval_target cards, system lines) need ONE correction. Done inside the migration it was a single statement over every organization's rooms in one transaction: the row lock of every changed room was held
until the migration committed (a live send into such a room waited for it) and on a big messages table the `GROUP BY conversation_id` scan runs inside that same transaction. As a job it is cut into small keyset chunks of
rooms, each its own short transaction, and can be run (or re-run) when the table is quiet.

Rules (the same as the trigger): a room's time only ever goes UP (a room already at or after its last word is left alone); a word timestamped in the future counts as «now»; a TOMBSTONED message (deleted_at set) is not
activity — the list preview skips it too, so counting it would lift a room whose preview then reads empty.

Index note: `(conversation_id, created_at)` over ALL messages makes each chunk an index range read; without it the chunk reads the room's messages through `(conversation_id)`. On a big table build it by hand first
(`CREATE INDEX CONCURRENTLY IF NOT EXISTS ix_conversation_messages_conv_created_all ON conversation_messages (conversation_id, created_at)`) — the repository builds big-table indexes by hand, not in a migration.

run:
  cd backend && DATABASE_URL=... python -m scripts.jobs.backfill_conversation_updated_at            # dry-run: how many rooms are out of step
  cd backend && DATABASE_URL=... python -m scripts.jobs.backfill_conversation_updated_at --apply     # correct them
options: --chunk N rooms per transaction (default 200)
"""
from __future__ import annotations

import argparse
import asyncio
import sys
import uuid

from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncSession

from scripts.jobs._db_env import resolve_database_url

_db_url_summary = resolve_database_url()

from app.core.database import async_session_factory  # noqa: E402 — the fallback above has to run first

# one chunk: the next `:chunk` rooms after `:after` (keyset on id), corrected from their last NON-deleted word. Returns the rooms it changed and the last room id it looked at.
_CHUNK_SQL = """
WITH batch AS (
    SELECT id FROM conversations WHERE id > :after ORDER BY id LIMIT :chunk
), last_words AS (
    SELECT m.conversation_id, max(m.created_at) AS last_at
    FROM conversation_messages m
    WHERE m.conversation_id IN (SELECT id FROM batch) AND m.deleted_at IS NULL
    GROUP BY m.conversation_id
), fixed AS (
    UPDATE conversations c SET updated_at = LEAST(w.last_at, clock_timestamp())
    FROM last_words w
    WHERE c.id = w.conversation_id AND LEAST(w.last_at, clock_timestamp()) > c.updated_at
    RETURNING c.id
)
SELECT (SELECT count(*) FROM fixed) AS changed, (SELECT id FROM batch ORDER BY id DESC LIMIT 1) AS last_id, (SELECT count(*) FROM batch) AS looked_at
"""

# dry-run: the same rule, nothing written
_COUNT_SQL = """
SELECT count(*) FROM conversations c
WHERE c.updated_at < LEAST(
    (SELECT max(m.created_at) FROM conversation_messages m WHERE m.conversation_id = c.id AND m.deleted_at IS NULL), clock_timestamp())
"""


async def backfill(session_factory, *, chunk: int = 200, apply: bool = True) -> int:
    """the number of rooms corrected (apply) or found out of step (dry-run)"""
    if not apply:
        async with session_factory() as s:
            return int((await s.execute(text(_COUNT_SQL))).scalar_one() or 0)
    total, after = 0, uuid.UUID(int=0)
    while True:
        async with session_factory() as s:  # one short transaction per chunk: no room's row lock is held beyond it
            row = (await s.execute(text(_CHUNK_SQL), {"after": after, "chunk": chunk})).one()
            await s.commit()
        if not row.looked_at:
            return total
        total += int(row.changed or 0)
        after = row.last_id


async def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    parser.add_argument("--apply", action="store_true", help="correct the rooms (default: only count them)")
    parser.add_argument("--chunk", type=int, default=200)
    args = parser.parse_args()
    print(f"[backfill_conversation_updated_at] db={_db_url_summary} apply={args.apply} chunk={args.chunk}")
    n = await backfill(async_session_factory, chunk=args.chunk, apply=args.apply)
    print(f"[backfill_conversation_updated_at] {'corrected' if args.apply else 'out of step'}: {n} room(s)")
    return 0


if __name__ == "__main__":
    sys.exit(asyncio.run(main()))
