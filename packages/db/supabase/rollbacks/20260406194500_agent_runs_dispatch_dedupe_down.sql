-- S447 rollback — memo dispatch dedupe support

DROP INDEX IF EXISTS idx_agent_runs_trigger_memo_created;
DROP INDEX IF EXISTS idx_agent_runs_dispatch_key_unique;

ALTER TABLE public.agent_runs
  DROP COLUMN IF EXISTS source_updated_at,
  DROP COLUMN IF EXISTS dispatch_key;
