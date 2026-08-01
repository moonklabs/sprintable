# scripts/jobs/ — operational scripts that run against a live database

## This is the canonical location

If a script needs to connect to a real (dev/prod) database — backfills, one-off
migrations of data (not schema), audits, expiries — it goes **here**, not in
`backend/scripts/` root.

`backend/Dockerfile` only `COPY`s `scripts/jobs/` and `scripts/migrate.sh` into the
deployed backend image (story #1666 — deliberate: `scripts/` root also holds
deploy/setup/provision `.sh` files and a `RUNBOOK.md` that have no reason to ship
inside a running container, and keeping them out minimizes recon-surface). A script
placed in `scripts/` root will pass CI, merge, and deploy cleanly — and then be
completely unreachable from inside the container. This has already happened twice
before this story existed (`backfill_reference_semantic_candidates.py`, moved by
오르테가 2026-07-31; `backfill_activity_events.py` and
`expire_undeliverable_pending_dispatched_events.py`, moved by story #2384 itself).
`backend/tests/test_2384_scripts_root_image_exclusion_lint.py` now guards against a
fourth occurrence — any new `.py` added to `scripts/` root that isn't on that test's
explicit CI/local-only allowlist fails CI.

## How to actually run one against dev

The only currently-provisioned Cloud Run Job for this is **`sprintable-verify-oneoff`**
(dev). It's a manual/occasional-use job, not a standing pipeline — someone with gcloud
access to the project runs it via `gcloud run jobs execute sprintable-verify-oneoff
--args=...` (or the Cloud Console), overriding the command to
`python -m scripts.jobs.<script_name> [args...]`. There is currently **no self-service
path** for an agent session to trigger this directly — running an operational script
against dev is PO/infra-lane, same as any other Cloud Run job execution.

⚠️ The job's environment supplies `ALEMBIC_URL` (psycopg2-scheme), not `DATABASE_URL`
(asyncpg-scheme) — this was itself a prior footgun (오르테가 판정, 2026-07-31, on
`backfill_reference_semantic_candidates.py`: *"손질이 한 번이면 코드로 넣고, 매번이면
그건 손질이 아니라 결함이다"*). A script meant to run in this job should fall back to
`ALEMBIC_URL` when `DATABASE_URL` is unset and convert the scheme itself — see
`backfill_reference_semantic_candidates.py` for the reference implementation. Log which
one it used (scheme+host only, never credentials) on its first line of output.

## Before you add a script here

1. Does it write to (or delete/expire) production-adjacent data? If yes, it needs a
   `--dry-run` default and an explicit `--apply` (or equivalent) to actually mutate —
   see `expire_undeliverable_pending_dispatched_events.py` for the pattern.
2. Is it idempotent? Someone will re-run it, on purpose or by accident.
3. Does its docstring state the exact invocation (`python -m scripts.jobs.<name>
   [args]`) and what env var it needs? The next person running it under time pressure
   won't read the source first.
