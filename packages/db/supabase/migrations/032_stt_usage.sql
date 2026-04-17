-- SID:376 — STT 분 사용량 추적 (AC9: Free tier STT 분 제한)

CREATE TABLE IF NOT EXISTS public.stt_usage (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id      uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  meeting_id  uuid REFERENCES public.meetings(id) ON DELETE SET NULL,
  duration_sec integer NOT NULL DEFAULT 0,
  provider    text NOT NULL DEFAULT 'browser',
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX idx_stt_usage_org ON public.stt_usage(org_id);
CREATE INDEX idx_stt_usage_month ON public.stt_usage(org_id, created_at);

ALTER TABLE public.stt_usage ENABLE ROW LEVEL SECURITY;

CREATE POLICY "stt_usage_select" ON public.stt_usage FOR SELECT
  USING (org_id IN (SELECT public.get_user_org_ids()));

CREATE POLICY "stt_usage_insert" ON public.stt_usage FOR INSERT
  WITH CHECK (org_id IN (SELECT public.get_user_org_ids()));

-- AC9: Free tier STT 분 제한 feature seed
-- Free tier: stt_recording enabled, max_stt_minutes = 30분/월
-- plan_tiers의 free tier ID는 환경마다 다를 수 있으므로 subquery로 조회
INSERT INTO public.plan_features (tier_id, feature_key, enabled, limit_value)
SELECT
  t.id,
  'stt_recording',
  true,
  NULL  -- boolean gate (enabled만 체크)
FROM public.plan_tiers t WHERE t.name = 'free'
ON CONFLICT (tier_id, feature_key) DO NOTHING;

INSERT INTO public.plan_features (tier_id, feature_key, enabled, limit_value)
SELECT
  t.id,
  'max_stt_minutes',
  true,
  30  -- Free tier: 월 30분 제한
FROM public.plan_tiers t WHERE t.name = 'free'
ON CONFLICT (tier_id, feature_key) DO NOTHING;

-- Team/Pro tier: 무제한 (limit_value = NULL)
INSERT INTO public.plan_features (tier_id, feature_key, enabled, limit_value)
SELECT
  t.id,
  'stt_recording',
  true,
  NULL
FROM public.plan_tiers t WHERE t.name IN ('team', 'pro', 'enterprise')
ON CONFLICT (tier_id, feature_key) DO NOTHING;

INSERT INTO public.plan_features (tier_id, feature_key, enabled, limit_value)
SELECT
  t.id,
  'max_stt_minutes',
  true,
  NULL  -- 무제한
FROM public.plan_tiers t WHERE t.name IN ('team', 'pro', 'enterprise')
ON CONFLICT (tier_id, feature_key) DO NOTHING;
