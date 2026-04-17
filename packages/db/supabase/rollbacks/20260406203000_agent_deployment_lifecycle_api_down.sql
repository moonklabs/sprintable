-- S449 rollback — agent deployment lifecycle API support

DROP INDEX IF EXISTS idx_agent_runs_deployment_status_created;

ALTER TABLE public.agent_runs
  DROP CONSTRAINT IF EXISTS agent_runs_status_check;

ALTER TABLE public.agent_runs
  ADD CONSTRAINT agent_runs_status_check
  CHECK (status IN ('running', 'completed', 'failed'));

DROP INDEX IF EXISTS uq_agent_deployments_live_per_agent;
DROP INDEX IF EXISTS idx_agent_deployments_status;

ALTER TABLE public.agent_deployments
  DROP CONSTRAINT IF EXISTS agent_deployments_status_check;

UPDATE public.agent_deployments
SET status = CASE status
  WHEN 'DEPLOYING' THEN 'building'
  WHEN 'ACTIVE' THEN 'active'
  WHEN 'DEPLOY_FAILED' THEN 'failed'
  WHEN 'TERMINATED' THEN 'archived'
  WHEN 'SUSPENDED' THEN 'archived'
  ELSE status
END
WHERE status IN ('DEPLOYING', 'ACTIVE', 'SUSPENDED', 'TERMINATED', 'DEPLOY_FAILED');

ALTER TABLE public.agent_deployments
  ADD CONSTRAINT agent_deployments_status_check
  CHECK (status IN ('draft', 'building', 'active', 'failed', 'archived'));

CREATE INDEX IF NOT EXISTS idx_agent_deployments_status
  ON public.agent_deployments(status, created_at DESC);
