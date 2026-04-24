-- org_usage: monthly resource counters per org
CREATE TABLE IF NOT EXISTS org_usage (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  period TEXT NOT NULL,  -- 'YYYY-MM' for monthly resources
  stories INT NOT NULL DEFAULT 0,
  memos INT NOT NULL DEFAULT 0,
  docs INT NOT NULL DEFAULT 0,
  api_calls INT NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now(),
  UNIQUE(org_id, period)
);

ALTER TABLE org_usage ENABLE ROW LEVEL SECURITY;

CREATE POLICY "org members can view usage"
  ON org_usage FOR SELECT
  USING (
    org_id IN (
      SELECT org_id FROM org_members WHERE user_id = auth.uid()
    )
  );

-- Atomic increment helper (service_role only)
CREATE OR REPLACE FUNCTION increment_org_usage(
  _org_id UUID,
  _period TEXT,
  _resource TEXT,
  _count INT DEFAULT 1
) RETURNS void LANGUAGE plpgsql SECURITY DEFINER AS $$
BEGIN
  INSERT INTO org_usage (org_id, period, stories, memos, docs, api_calls)
  VALUES (_org_id, _period, 0, 0, 0, 0)
  ON CONFLICT (org_id, period) DO NOTHING;

  IF _resource = 'stories' THEN
    UPDATE org_usage SET stories = stories + _count, updated_at = now()
    WHERE org_id = _org_id AND period = _period;
  ELSIF _resource = 'memos' THEN
    UPDATE org_usage SET memos = memos + _count, updated_at = now()
    WHERE org_id = _org_id AND period = _period;
  ELSIF _resource = 'docs' THEN
    UPDATE org_usage SET docs = docs + _count, updated_at = now()
    WHERE org_id = _org_id AND period = _period;
  ELSIF _resource = 'api_calls' THEN
    UPDATE org_usage SET api_calls = api_calls + _count, updated_at = now()
    WHERE org_id = _org_id AND period = _period;
  END IF;
END;
$$;

REVOKE EXECUTE ON FUNCTION increment_org_usage FROM PUBLIC;
GRANT EXECUTE ON FUNCTION increment_org_usage TO service_role;
