-- S447 — memo dispatch dedupe support

ALTER TABLE public.agent_runs
  ADD COLUMN IF NOT EXISTS dispatch_key text,
  ADD COLUMN IF NOT EXISTS source_updated_at timestamptz;

CREATE UNIQUE INDEX IF NOT EXISTS idx_agent_runs_dispatch_key_unique
  ON public.agent_runs(dispatch_key)
  WHERE dispatch_key IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_agent_runs_trigger_memo_created
  ON public.agent_runs(trigger, memo_id, created_at DESC)
  WHERE memo_id IS NOT NULL;
