-- org_subscriptions: tracks Polar billing state per org
CREATE TABLE IF NOT EXISTS org_subscriptions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id UUID NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  polar_customer_id TEXT NOT NULL,
  polar_subscription_id TEXT,
  tier TEXT NOT NULL DEFAULT 'free',
  billing_cycle TEXT,
  status TEXT NOT NULL DEFAULT 'active',
  current_period_start TIMESTAMPTZ,
  current_period_end TIMESTAMPTZ,
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now(),
  UNIQUE(org_id)
);

-- service_role owns webhooks, RLS not needed for internal writes
ALTER TABLE org_subscriptions ENABLE ROW LEVEL SECURITY;

-- org members can read their own org's subscription
CREATE POLICY "org members can view subscription"
  ON org_subscriptions FOR SELECT
  USING (
    org_id IN (
      SELECT org_id FROM org_members WHERE user_id = auth.uid()
    )
  );
