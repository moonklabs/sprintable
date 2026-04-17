-- E-024:S7 — explicit retry/non-retryable failure disposition for agent runs

ALTER TABLE public.agent_runs
  ADD COLUMN IF NOT EXISTS failure_disposition text;

ALTER TABLE public.agent_runs
  DROP CONSTRAINT IF EXISTS agent_runs_failure_disposition_check;

ALTER TABLE public.agent_runs
  ADD CONSTRAINT agent_runs_failure_disposition_check
  CHECK (failure_disposition IN ('retry_scheduled', 'retry_launched', 'retry_exhausted', 'non_retryable') OR failure_disposition IS NULL);

UPDATE public.agent_runs
SET failure_disposition = CASE
  WHEN status <> 'failed' THEN NULL
  WHEN next_retry_at IS NOT NULL AND retry_count < max_retries THEN 'retry_scheduled'
  WHEN retry_count >= max_retries THEN 'retry_exhausted'
  ELSE 'non_retryable'
END;

CREATE INDEX IF NOT EXISTS idx_agent_runs_failure_disposition
  ON public.agent_runs(org_id, failure_disposition, created_at DESC)
  WHERE status = 'failed';
