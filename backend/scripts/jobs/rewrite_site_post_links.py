"""story 4796 — the public links of published hosted-site posts that were stored with a host that is going away.

The publish route used to build the link from the request's own host; behind the VM's pass-through front door that host is the Cloud Run host (the door sets `Host` to it), so the link stored in
`activity_logs.context.url` (action `site_post_published`) carries `run.app`, and answers 404 once the Cloud Run backend is deleted (RUNBOOK §10). The routes now build the link from
`PUBLIC_API_URL` (`app/core/public_origin.py`); this job rewrites what is already stored.

Three modes, one command line each (run it in the one-off Cloud Run job `sprintable-verify-oneoff`, like the other `scripts/jobs/` scripts; `DATABASE_URL`, else `ALEMBIC_URL` — `_db_env.py`):

  python -m scripts.jobs.rewrite_site_post_links
      READ-ONLY report: how many stored links there are per origin (scheme + host) — origins and counts only, never a full link.
  python -m scripts.jobs.rewrite_site_post_links --old-origin https://OLD --new-origin https://dev-api.sprintable.ai
      READ-ONLY plan: how many links start with that old origin (nothing is written).
  python -m scripts.jobs.rewrite_site_post_links --old-origin https://OLD --new-origin https://dev-api.sprintable.ai --apply
      Rewrites ONLY the origin prefix of the links that start with `--old-origin/`, in one transaction, and prints the count before and after. `--old-origin` may be repeated.

Nothing else is touched: only rows with action `site_post_published`, only `context.url`, only the leading origin; the path and the query (`public_key`, `lang`) stay. The new origin must be https (or http://localhost).
"""
from __future__ import annotations

import argparse
import asyncio
import sys

from sqlalchemy import text

from scripts.jobs._db_env import resolve_database_url

_db_url_summary = resolve_database_url()

ACTION = "site_post_published"
_ORIGIN_RE = r"^https?://[^/]+"


def _like_prefix(origin: str) -> str:
    """`origin` + '/' as a LIKE pattern prefix, with the LIKE metacharacters of the origin escaped (backslash is the escape character)."""
    escaped = origin.replace("\\", "\\\\").replace("%", "\\%").replace("_", "\\_")
    return escaped + "/%"


def check_origin(value: str, *, what: str) -> str:
    from app.core.origin_check import parse_origin

    try:
        return parse_origin(value)
    except ValueError as exc:
        raise SystemExit(f"{what}: {exc}") from exc


async def counts_by_origin(session) -> list[tuple[str | None, int]]:
    rows = await session.execute(
        text(f"SELECT substring(context->>'url' from '{_ORIGIN_RE}') AS origin, count(*) FROM activity_logs WHERE action = :action GROUP BY 1 ORDER BY 2 DESC, 1"),
        {"action": ACTION},
    )
    return [(r[0], int(r[1])) for r in rows]


async def count_with_origin(session, old_origin: str) -> int:
    row = await session.execute(
        text("SELECT count(*) FROM activity_logs WHERE action = :action AND context->>'url' LIKE :prefix ESCAPE '\\'"),
        {"action": ACTION, "prefix": _like_prefix(old_origin)},
    )
    return int(row.scalar_one())


async def rewrite_origin(session, old_origin: str, new_origin: str) -> int:
    result = await session.execute(
        text(
            "UPDATE activity_logs SET context = jsonb_set(context, '{url}', to_jsonb(CAST(:new AS text) || substr(context->>'url', char_length(CAST(:old AS text)) + 1))) "
            "WHERE action = :action AND context->>'url' LIKE :prefix ESCAPE '\\'"
        ),
        {"action": ACTION, "new": new_origin, "old": old_origin, "prefix": _like_prefix(old_origin)},
    )
    return int(result.rowcount)


async def run(old_origins: list[str], new_origin: str | None, apply: bool) -> int:
    if _db_url_summary is None:
        # without DATABASE_URL / ALEMBIC_URL the app's default would be a local database: never write there by accident
        raise SystemExit("neither DATABASE_URL nor ALEMBIC_URL is set: refusing to run")
    from app.core.database import async_session_factory  # noqa: E402 — the URL fallback above has to run first

    print(f"database: {_db_url_summary}")
    async with async_session_factory() as session:
        if not old_origins:
            for origin, n in await counts_by_origin(session):
                print(f"{origin or '(no url)'}\t{n}")
            return 0
        if new_origin is None:
            raise SystemExit("--new-origin is required with --old-origin")
        total_before = 0
        for old in old_origins:
            n = await count_with_origin(session, old)
            total_before += n
            print(f"{old} -> {new_origin}: {n} link(s) {'to rewrite' if apply else 'would be rewritten (dry run, nothing written)'}")
        if not apply:
            return 0
        done = 0
        for old in old_origins:
            done += await rewrite_origin(session, old, new_origin)
        await session.commit()
        left = sum([await count_with_origin(session, old) for old in old_origins])
        print(f"rewritten: {done}; still with an old origin: {left}")
        return 0 if (done == total_before and left == 0) else 1


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__.split("\n", 1)[0])
    parser.add_argument("--old-origin", action="append", default=[], help="an origin the stored links start with (repeatable)")
    parser.add_argument("--new-origin", help="the origin to write instead")
    parser.add_argument("--apply", action="store_true", help="write (default: read only)")
    args = parser.parse_args(argv)
    if args.apply and not args.old_origin:
        raise SystemExit("--apply needs --old-origin")
    if args.old_origin and not args.new_origin:
        raise SystemExit("--new-origin is required with --old-origin")
    olds = [check_origin(o, what="--old-origin") for o in args.old_origin]
    new = check_origin(args.new_origin, what="--new-origin") if args.new_origin else None
    return asyncio.run(run(olds, new, args.apply))


if __name__ == "__main__":
    sys.exit(main())
