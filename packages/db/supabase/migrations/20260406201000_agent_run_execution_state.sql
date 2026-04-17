-- S448 — agent execution loop state

ALTER TABLE public.agent_runs
  ADD COLUMN IF NOT EXISTS llm_call_count integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS tool_call_history jsonb NOT NULL DEFAULT '[]'::jsonb,
  ADD COLUMN IF NOT EXISTS output_memo_ids uuid[] NOT NULL DEFAULT '{}'::uuid[],
  ADD COLUMN IF NOT EXISTS last_error_code text;

CREATE INDEX IF NOT EXISTS idx_agent_runs_output_memo_ids_gin
  ON public.agent_runs USING gin (output_memo_ids);
