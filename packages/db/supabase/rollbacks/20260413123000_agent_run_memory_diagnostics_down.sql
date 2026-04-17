-- E-033:S3 rollback — remove agent run memory diagnostics columns

ALTER TABLE public.agent_runs
  DROP COLUMN IF EXISTS memory_diagnostics,
  DROP COLUMN IF EXISTS restored_memory_count;
