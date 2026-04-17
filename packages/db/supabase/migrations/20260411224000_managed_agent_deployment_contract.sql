-- E-025:S5 — managed agent deployment contract normalization

ALTER TABLE public.agent_deployments
  ADD COLUMN IF NOT EXISTS failure_code text,
  ADD COLUMN IF NOT EXISTS failure_message text,
  ADD COLUMN IF NOT EXISTS failure_detail jsonb,
  ADD COLUMN IF NOT EXISTS failed_at timestamptz;

UPDATE public.agent_deployments
SET
  failure_code = COALESCE(failure_code, 'deployment_failed'),
  failure_message = COALESCE(failure_message, 'Deployment failed'),
  failure_detail = COALESCE(failure_detail, '{}'::jsonb),
  failed_at = COALESCE(failed_at, updated_at)
WHERE status = 'DEPLOY_FAILED';

COMMENT ON COLUMN public.agent_deployments.config IS 'Managed deployment contract snapshot shared by UI and runtime (provider, billing mode, scope).';
COMMENT ON COLUMN public.agent_deployments.failure_code IS 'Stable deployment failure code persisted for DEPLOY_FAILED rows.';
COMMENT ON COLUMN public.agent_deployments.failure_message IS 'Human-readable deployment failure summary persisted for DEPLOY_FAILED rows.';
COMMENT ON COLUMN public.agent_deployments.failure_detail IS 'Structured deployment failure evidence persisted for DEPLOY_FAILED rows.';
COMMENT ON COLUMN public.agent_deployments.failed_at IS 'Timestamp when the deployment most recently entered DEPLOY_FAILED.';
