-- SID:364 — plan_offering_snapshots grandfathering
-- 정책문서 5.3: 기존 구독자는 구독 시점 요금제 조건 유지
-- plan_offerings(UI용)와 별도로 snapshot 테이블 운용

-- 1. plan_offering_snapshots — grandfathering snapshot 1행/티어/버전
CREATE TABLE IF NOT EXISTS public.plan_offering_snapshots (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tier_id         uuid NOT NULL REFERENCES public.plan_tiers(id) ON DELETE CASCADE,
  version         integer NOT NULL DEFAULT 1,
  price_monthly   numeric(10,2),
  price_annual    numeric(10,2),
  features        jsonb NOT NULL,
  effective_from  timestamptz NOT NULL DEFAULT now(),
  effective_until  timestamptz,
  created_at      timestamptz NOT NULL DEFAULT now(),
  UNIQUE(tier_id, version)
);

COMMENT ON TABLE public.plan_offering_snapshots IS '요금제 스냅샷 (grandfathering 기준)';

CREATE INDEX idx_offering_snapshots_tier ON public.plan_offering_snapshots(tier_id);
CREATE INDEX idx_offering_snapshots_active ON public.plan_offering_snapshots(tier_id) WHERE effective_until IS NULL;

-- RLS
ALTER TABLE public.plan_offering_snapshots ENABLE ROW LEVEL SECURITY;
CREATE POLICY "snapshots_select_all" ON public.plan_offering_snapshots FOR SELECT USING (true);

-- 2. 초기 스냅샷 시드 (tier당 1행)
INSERT INTO public.plan_offering_snapshots (tier_id, version, price_monthly, price_annual, features) VALUES
  ('00000000-0000-0000-0000-000000000a01', 1, 0, NULL,
   '{"max_members": 1, "max_projects": 1, "max_stories": 50, "max_docs": 10, "max_mockups": 5, "byoa_agents": 1, "kanban": true, "memos": true, "mcp_server": true, "agent_orchestration": false, "sso": false}'::jsonb),
  ('00000000-0000-0000-0000-000000000a02', 1, 12.00, 120.00,
   '{"max_members": null, "max_projects": null, "max_stories": null, "max_docs": null, "max_mockups": null, "byoa_agents": null, "kanban": true, "memos": true, "mcp_server": true, "agent_orchestration": true, "sso": false}'::jsonb),
  ('00000000-0000-0000-0000-000000000a03', 1, 29.00, 290.00,
   '{"max_members": null, "max_projects": null, "max_stories": null, "max_docs": null, "max_mockups": null, "byoa_agents": null, "kanban": true, "memos": true, "mcp_server": true, "agent_orchestration": true, "sso": true}'::jsonb)
ON CONFLICT (tier_id, version) DO NOTHING;

-- 3. subscriptions에 offering_snapshot_id FK 추가
ALTER TABLE public.subscriptions
  ADD COLUMN IF NOT EXISTS offering_snapshot_id uuid REFERENCES public.plan_offering_snapshots(id);

-- 4. 구독 생성 시 현행 스냅샷 자동 고정 트리거
CREATE OR REPLACE FUNCTION public.set_subscription_snapshot()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF NEW.offering_snapshot_id IS NULL THEN
    SELECT id INTO NEW.offering_snapshot_id
    FROM public.plan_offering_snapshots
    WHERE tier_id = NEW.tier_id AND effective_until IS NULL
    ORDER BY version DESC
    LIMIT 1;
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER trg_subscription_set_snapshot
  BEFORE INSERT ON public.subscriptions
  FOR EACH ROW EXECUTE FUNCTION public.set_subscription_snapshot();
