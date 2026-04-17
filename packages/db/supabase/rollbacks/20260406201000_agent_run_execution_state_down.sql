-- S448 rollback — agent execution loop state

DROP INDEX IF EXISTS idx_agent_runs_output_memo_ids_gin;

ALTER TABLE public.agent_runs
  DROP COLUMN IF EXISTS last_error_code,
  DROP COLUMN IF EXISTS output_memo_ids,
  DROP COLUMN IF EXISTS tool_call_history,
  DROP COLUMN IF EXISTS llm_call_count;
