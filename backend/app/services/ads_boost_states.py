"""story #4447 — the value sets the boost card branches on: one place, the server's contract.

/spend publishes them as openapi enums (`routers/ads_boost_execution.py`), and the web imports a TypeScript file generated from
them (`scripts/gen_ads_boost_states_ts.py` → `apps/web/src/lib/ads-boost-states.generated.ts`, kept fresh by
tests/test_4447_ads_boost_states_contract.py). The card treats anything outside these sets as unknown — a safe cell, never «start».

- BOOST_RUN_STATUSES: what `ads_boost_runs.status` is ever set to — the column default and the writes in ads_boost_execution.py
  (a test pins the set to those writes). The web once had `failed` (never written) and lacked `pause_pending` (a delayed pause).
- COMMAND_STATUSES: `publication_commands.status` (models/publication_command.py) — `blocked_unapproved` is newsletter-only.
- COMMAND_FAILURE_KINDS: `publication_commands.failure_kind` (services/publication_command.py FAILURE_KIND_*).
"""
from __future__ import annotations

BOOST_RUN_STATUSES: tuple[str, ...] = ("pending", "running", "pause_pending", "paused")
COMMAND_STATUSES: tuple[str, ...] = ("pending", "in_progress", "completed", "failed", "dead_letter", "voided", "blocked")
COMMAND_FAILURE_KINDS: tuple[str, ...] = ("connection", "needs_check", "transient", "not_sent", "paused")
