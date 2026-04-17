-- E-024:S6 — align agent_runs.started_at with actual execution start

ALTER TABLE public.agent_runs
  ALTER COLUMN started_at DROP DEFAULT;

ALTER TABLE public.agent_runs
  ALTER COLUMN started_at DROP NOT NULL;

UPDATE public.agent_runs
SET started_at = NULL
WHERE status IN ('queued', 'held');
