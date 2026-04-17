-- SID:468 — monthly agent usage materialized view + breakdown APIs support

CREATE MATERIALIZED VIEW IF NOT EXISTS public.monthly_agent_usage AS
SELECT
  ar.org_id,
  date_trunc('month', COALESCE(ar.finished_at, ar.created_at))::date AS usage_month,
  ar.agent_id,
  tm.name AS agent_name,
  COALESCE(ar.model, 'unknown') AS model,
  COUNT(*)::bigint AS run_count,
  ROUND(SUM(COALESCE(ar.duration_ms, 0))::numeric / 3600000, 4) AS total_hours,
  SUM(COALESCE(ar.input_tokens, 0) + COALESCE(ar.output_tokens, 0))::bigint AS total_tokens,
  SUM(COALESCE(ar.computed_cost_cents, 0))::bigint AS total_cost_cents
FROM public.agent_runs ar
LEFT JOIN public.team_members tm ON tm.id = ar.agent_id
WHERE ar.status IN ('running', 'completed', 'failed')
GROUP BY 1, 2, 3, 4, 5
WITH NO DATA;

CREATE UNIQUE INDEX IF NOT EXISTS idx_monthly_agent_usage_org_month_agent_model
  ON public.monthly_agent_usage (org_id, usage_month, agent_id, model);

CREATE OR REPLACE FUNCTION public.refresh_monthly_agent_usage()
RETURNS void
LANGUAGE plpgsql
AS $$
BEGIN
  REFRESH MATERIALIZED VIEW CONCURRENTLY public.monthly_agent_usage;
END;
$$;

CREATE OR REPLACE FUNCTION public.get_monthly_agent_usage_summary(
  p_org_id uuid,
  p_month date
)
RETURNS TABLE (
  active_agents bigint,
  total_hours numeric,
  total_tokens bigint,
  total_cost_cents bigint
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF auth.uid() IS NULL OR NOT EXISTS (
    SELECT 1
    FROM public.get_user_admin_org_ids() admin_org_id
    WHERE admin_org_id = p_org_id
  ) THEN
    RAISE EXCEPTION 'forbidden'
      USING ERRCODE = '42501';
  END IF;

  RETURN QUERY
  SELECT
    COALESCE(COUNT(DISTINCT agent_id), 0)::bigint AS active_agents,
    COALESCE(ROUND(SUM(total_hours), 2), 0)::numeric AS total_hours,
    COALESCE(SUM(total_tokens), 0)::bigint AS total_tokens,
    COALESCE(SUM(total_cost_cents), 0)::bigint AS total_cost_cents
  FROM public.monthly_agent_usage
  WHERE org_id = p_org_id
    AND usage_month = date_trunc('month', p_month)::date;
END;
$$;

CREATE OR REPLACE FUNCTION public.get_monthly_agent_usage_breakdown(
  p_org_id uuid,
  p_month date,
  p_group_by text
)
RETURNS TABLE (
  key text,
  label text,
  total_hours numeric,
  total_tokens bigint,
  total_cost_cents bigint,
  run_count bigint
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF auth.uid() IS NULL OR NOT EXISTS (
    SELECT 1
    FROM public.get_user_admin_org_ids() admin_org_id
    WHERE admin_org_id = p_org_id
  ) THEN
    RAISE EXCEPTION 'forbidden'
      USING ERRCODE = '42501';
  END IF;

  RETURN QUERY
  SELECT
    CASE WHEN p_group_by = 'agent' THEN agent_id::text ELSE model END AS key,
    CASE WHEN p_group_by = 'agent' THEN COALESCE(agent_name, 'Unknown agent') ELSE model END AS label,
    COALESCE(ROUND(SUM(total_hours), 2), 0)::numeric AS total_hours,
    COALESCE(SUM(total_tokens), 0)::bigint AS total_tokens,
    COALESCE(SUM(total_cost_cents), 0)::bigint AS total_cost_cents,
    COALESCE(SUM(run_count), 0)::bigint AS run_count
  FROM public.monthly_agent_usage
  WHERE org_id = p_org_id
    AND usage_month = date_trunc('month', p_month)::date
  GROUP BY 1, 2
  ORDER BY total_cost_cents DESC, total_tokens DESC, label ASC;
END;
$$;

GRANT EXECUTE ON FUNCTION public.get_monthly_agent_usage_summary(uuid, date) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.get_monthly_agent_usage_breakdown(uuid, date, text) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.refresh_monthly_agent_usage() TO service_role;

REFRESH MATERIALIZED VIEW public.monthly_agent_usage;

DO $$
DECLARE
  existing_job_id bigint;
BEGIN
  IF EXISTS (SELECT 1 FROM pg_namespace WHERE nspname = 'cron') THEN
    SELECT jobid INTO existing_job_id
    FROM cron.job
    WHERE jobname = 'refresh_monthly_agent_usage_hourly'
    LIMIT 1;

    IF existing_job_id IS NOT NULL THEN
      PERFORM cron.unschedule(existing_job_id);
    END IF;

    PERFORM cron.schedule(
      'refresh_monthly_agent_usage_hourly',
      '7 * * * *',
      $job$SELECT public.refresh_monthly_agent_usage();$job$
    );
  END IF;
EXCEPTION
  WHEN undefined_table OR undefined_function THEN
    RAISE NOTICE 'pg_cron unavailable; monthly_agent_usage refresh must be scheduled externally';
END;
$$;
