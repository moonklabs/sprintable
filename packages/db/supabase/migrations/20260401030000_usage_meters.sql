-- SID:382 — Usage 미터링

-- AC1: usage_meters 테이블
CREATE TABLE IF NOT EXISTS public.usage_meters (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id        uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  meter_type    text NOT NULL CHECK (meter_type IN ('ai_calls', 'storage_mb', 'members', 'agents', 'stt_minutes')),
  current_value integer NOT NULL DEFAULT 0,
  limit_value   integer,  -- null = 무제한
  period_start  timestamptz NOT NULL,
  period_end    timestamptz NOT NULL,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  UNIQUE (org_id, meter_type, period_start)
);

CREATE INDEX idx_usage_meters_org ON public.usage_meters(org_id);
CREATE INDEX idx_usage_meters_period ON public.usage_meters(org_id, meter_type, period_end);

ALTER TABLE public.usage_meters ENABLE ROW LEVEL SECURITY;

CREATE POLICY "usage_meters_select" ON public.usage_meters FOR SELECT
  USING (org_id IN (SELECT public.get_user_org_ids()));

CREATE POLICY "usage_meters_insert" ON public.usage_meters FOR INSERT
  WITH CHECK (org_id IN (SELECT public.get_user_org_ids()));

CREATE POLICY "usage_meters_update" ON public.usage_meters FOR UPDATE
  USING (org_id IN (SELECT public.get_user_org_ids()));
