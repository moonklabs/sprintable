// GENERATED — do not edit. Source: backend/app/services/ads_boost_states.py (story #4447).
// Regenerate: (cd backend && PYTHONPATH=. uv run python scripts/gen_ads_boost_states_ts.py)
export const BOOST_RUN_STATUSES = ['pending', 'running', 'pause_pending', 'paused'] as const;
export const COMMAND_STATUSES = ['pending', 'in_progress', 'completed', 'failed', 'dead_letter', 'voided', 'blocked', 'blocked_unapproved', 'cancelled'] as const;
export const COMMAND_FAILURE_KINDS = ['connection', 'needs_check', 'transient', 'not_sent', 'paused'] as const;
export type BoostRunStatus = (typeof BOOST_RUN_STATUSES)[number];
export type CommandStatus = (typeof COMMAND_STATUSES)[number];
export type CommandFailureKind = (typeof COMMAND_FAILURE_KINDS)[number];
