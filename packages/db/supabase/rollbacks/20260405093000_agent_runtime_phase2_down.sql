-- SID:389 rollback — Phase 2 agent runtime schema

DROP POLICY IF EXISTS "agent_long_term_memories_delete" ON public.agent_long_term_memories;
DROP POLICY IF EXISTS "agent_long_term_memories_update" ON public.agent_long_term_memories;
DROP POLICY IF EXISTS "agent_long_term_memories_insert" ON public.agent_long_term_memories;
DROP POLICY IF EXISTS "agent_long_term_memories_select" ON public.agent_long_term_memories;
DROP POLICY IF EXISTS "agent_deployments_delete" ON public.agent_deployments;
DROP POLICY IF EXISTS "agent_deployments_update" ON public.agent_deployments;
DROP POLICY IF EXISTS "agent_deployments_insert" ON public.agent_deployments;
DROP POLICY IF EXISTS "agent_deployments_select" ON public.agent_deployments;

DROP TRIGGER IF EXISTS trg_agent_long_term_memories_updated_at ON public.agent_long_term_memories;
DROP TRIGGER IF EXISTS trg_agent_long_term_memories_validate_agent ON public.agent_long_term_memories;
DROP TRIGGER IF EXISTS trg_agent_deployments_updated_at ON public.agent_deployments;
DROP TRIGGER IF EXISTS trg_agent_deployments_validate_agent ON public.agent_deployments;

DROP FUNCTION IF EXISTS public.validate_agent_runtime_member();

DROP TABLE IF EXISTS public.agent_long_term_memories;
DROP TABLE IF EXISTS public.agent_deployments;

DROP INDEX IF EXISTS idx_agent_runs_deployment_created;
DROP INDEX IF EXISTS idx_agent_runs_project_agent_created;
DROP INDEX IF EXISTS idx_agent_runs_org_status_created;

ALTER TABLE public.agent_runs DROP COLUMN IF EXISTS duration_ms;
ALTER TABLE public.agent_runs DROP COLUMN IF EXISTS finished_at;
ALTER TABLE public.agent_runs DROP COLUMN IF EXISTS started_at;
ALTER TABLE public.agent_runs DROP COLUMN IF EXISTS deployment_id;
ALTER TABLE public.agent_runs DROP COLUMN IF EXISTS project_id;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'agent_runs'
      AND column_name = 'duration_ms_legacy'
  ) THEN
    ALTER TABLE public.agent_runs RENAME COLUMN duration_ms_legacy TO duration_ms;
  END IF;
END $$;
