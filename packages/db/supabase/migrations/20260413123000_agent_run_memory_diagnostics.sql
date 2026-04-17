-- E-033:S3 — persist restored memory counts and retrieval diagnostics on agent runs

ALTER TABLE public.agent_runs
  ADD COLUMN IF NOT EXISTS restored_memory_count integer,
  ADD COLUMN IF NOT EXISTS memory_diagnostics jsonb;
