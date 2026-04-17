-- S449 — agent deployment lifecycle API support

-- Normalize deployment lifecycle statuses to uppercase runtime states.
UPDATE public.agent_deployments
SET status = CASE status
  WHEN 'draft' THEN 'DEPLOYING'
  WHEN 'building' THEN 'DEPLOYING'
  WHEN 'active' THEN 'ACTIVE'
  WHEN 'failed' THEN 'DEPLOY_FAILED'
  WHEN 'archived' THEN 'TERMINATED'
  ELSE status
END
WHERE status IN ('draft', 'building', 'active', 'failed', 'archived');

ALTER TABLE public.agent_deployments
  DROP CONSTRAINT IF EXISTS agent_deployments_status_check;

ALTER TABLE public.agent_deployments
  ADD CONSTRAINT agent_deployments_status_check
  CHECK (status IN ('DEPLOYING', 'ACTIVE', 'SUSPENDED', 'TERMINATED', 'DEPLOY_FAILED'));

DROP INDEX IF EXISTS idx_agent_deployments_status;
CREATE INDEX IF NOT EXISTS idx_agent_deployments_status
  ON public.agent_deployments(status, created_at DESC);

CREATE UNIQUE INDEX IF NOT EXISTS uq_agent_deployments_live_per_agent
  ON public.agent_deployments(org_id, project_id, agent_id)
  WHERE deleted_at IS NULL AND status IN ('DEPLOYING', 'ACTIVE', 'SUSPENDED');

ALTER TABLE public.agent_runs
  DROP CONSTRAINT IF EXISTS agent_runs_status_check;

ALTER TABLE public.agent_runs
  ADD CONSTRAINT agent_runs_status_check
  CHECK (status IN ('queued', 'held', 'running', 'completed', 'failed'));

CREATE INDEX IF NOT EXISTS idx_agent_runs_deployment_status_created
  ON public.agent_runs(deployment_id, status, created_at DESC)
  WHERE deployment_id IS NOT NULL;
