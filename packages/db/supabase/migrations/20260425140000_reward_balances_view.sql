-- E-PLATFORM-SECURE S9: reward_balances materialized view + auto-refresh trigger

-- 1. materialized view
CREATE MATERIALIZED VIEW IF NOT EXISTS public.reward_balances AS
  SELECT
    member_id,
    project_id,
    SUM(amount) AS balance
  FROM public.reward_ledger
  GROUP BY member_id, project_id;

-- 2. UNIQUE index (CONCURRENTLY refresh에 필수)
CREATE UNIQUE INDEX IF NOT EXISTS idx_reward_balances_member_project
  ON public.reward_balances(member_id, project_id);

CREATE INDEX IF NOT EXISTS idx_reward_balances_project_balance
  ON public.reward_balances(project_id, balance DESC);

-- 3. auto-refresh trigger function
CREATE OR REPLACE FUNCTION public.refresh_reward_balances()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
BEGIN
  REFRESH MATERIALIZED VIEW CONCURRENTLY public.reward_balances;
  RETURN NULL;
END;
$$;

-- 4. trigger: reward_ledger INSERT/UPDATE/DELETE 시 자동 갱신
DROP TRIGGER IF EXISTS trg_reward_balances_refresh ON public.reward_ledger;
CREATE TRIGGER trg_reward_balances_refresh
  AFTER INSERT OR UPDATE OR DELETE ON public.reward_ledger
  FOR EACH STATEMENT
  EXECUTE FUNCTION public.refresh_reward_balances();
