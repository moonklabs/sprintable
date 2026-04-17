-- 029: 결제 PG 어댑터 컬럼 추가

ALTER TABLE public.subscriptions
  ADD COLUMN IF NOT EXISTS payment_provider text CHECK (payment_provider IN ('paddle', 'toss')),
  ADD COLUMN IF NOT EXISTS provider_subscription_id text,
  ADD COLUMN IF NOT EXISTS canceled_at timestamptz,
  ADD COLUMN IF NOT EXISTS grace_period_end timestamptz;

CREATE INDEX IF NOT EXISTS idx_subscriptions_provider_sub
  ON public.subscriptions(payment_provider, provider_subscription_id);

-- plan_tiers에 PG price ID 매핑 (서버 사이드 검증용)
ALTER TABLE public.plan_tiers
  ADD COLUMN IF NOT EXISTS paddle_price_id text,
  ADD COLUMN IF NOT EXISTS toss_product_id text;

-- price ↔ tier 매핑 테이블 (여러 PG의 여러 price ↔ 1개 tier 매핑)
CREATE TABLE IF NOT EXISTS public.price_tier_map (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  provider    text NOT NULL CHECK (provider IN ('paddle', 'toss')),
  price_id    text NOT NULL,
  tier_id     uuid NOT NULL REFERENCES public.plan_tiers(id) ON DELETE CASCADE,
  interval    text NOT NULL DEFAULT 'monthly' CHECK (interval IN ('monthly', 'yearly')),
  UNIQUE (provider, price_id)
);

CREATE INDEX IF NOT EXISTS idx_price_tier_map_lookup
  ON public.price_tier_map(provider, price_id);

ALTER TABLE public.price_tier_map ENABLE ROW LEVEL SECURITY;
CREATE POLICY "price_tier_map_select" ON public.price_tier_map FOR SELECT USING (true);
