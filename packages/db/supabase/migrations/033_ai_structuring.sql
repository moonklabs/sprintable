-- SID:377 — AI 구조화 (전사 → 요약/결정/액션아이템)

-- 1. project_ai_settings: 프로젝트별 BYOM API key 관리
CREATE TABLE IF NOT EXISTS public.project_ai_settings (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id      uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  project_id  uuid NOT NULL REFERENCES public.projects(id) ON DELETE CASCADE,
  provider    text NOT NULL DEFAULT 'openai' CHECK (provider IN ('openai', 'anthropic')),
  api_key     text NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (project_id)
);

CREATE INDEX idx_project_ai_settings_project ON public.project_ai_settings(project_id);

ALTER TABLE public.project_ai_settings ENABLE ROW LEVEL SECURITY;

-- SELECT: admin만 (api_key 평문 노출 방지)
CREATE POLICY "project_ai_settings_select" ON public.project_ai_settings FOR SELECT
  USING (org_id IN (SELECT public.get_user_admin_org_ids()));

CREATE POLICY "project_ai_settings_insert" ON public.project_ai_settings FOR INSERT
  WITH CHECK (org_id IN (SELECT public.get_user_admin_org_ids()));

CREATE POLICY "project_ai_settings_update" ON public.project_ai_settings FOR UPDATE
  USING (org_id IN (SELECT public.get_user_admin_org_ids()));

CREATE POLICY "project_ai_settings_delete" ON public.project_ai_settings FOR DELETE
  USING (org_id IN (SELECT public.get_user_admin_org_ids()));

-- 2. ai_usage: 월간 AI 구조화 사용 횟수 추적
CREATE TABLE IF NOT EXISTS public.ai_usage (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id      uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  project_id  uuid NOT NULL REFERENCES public.projects(id) ON DELETE CASCADE,
  feature_key text NOT NULL DEFAULT 'ai_structuring',
  meeting_id  uuid REFERENCES public.meetings(id) ON DELETE SET NULL,
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX idx_ai_usage_org ON public.ai_usage(org_id);
CREATE INDEX idx_ai_usage_month ON public.ai_usage(org_id, feature_key, created_at);

ALTER TABLE public.ai_usage ENABLE ROW LEVEL SECURITY;

CREATE POLICY "ai_usage_select" ON public.ai_usage FOR SELECT
  USING (org_id IN (SELECT public.get_user_org_ids()));

CREATE POLICY "ai_usage_insert" ON public.ai_usage FOR INSERT
  WITH CHECK (org_id IN (SELECT public.get_user_org_ids()));

-- 3. plan_features seed: ai_structuring
-- Free tier: 월 5회 제한
INSERT INTO public.plan_features (tier_id, feature_key, enabled, limit_value)
SELECT t.id, 'ai_structuring', true, NULL
FROM public.plan_tiers t WHERE t.name = 'free'
ON CONFLICT (tier_id, feature_key) DO NOTHING;

INSERT INTO public.plan_features (tier_id, feature_key, enabled, limit_value)
SELECT t.id, 'ai_structuring_monthly_limit', true, 5
FROM public.plan_tiers t WHERE t.name = 'free'
ON CONFLICT (tier_id, feature_key) DO NOTHING;

-- Team/Pro/Enterprise: 무제한
INSERT INTO public.plan_features (tier_id, feature_key, enabled, limit_value)
SELECT t.id, 'ai_structuring', true, NULL
FROM public.plan_tiers t WHERE t.name IN ('team', 'pro', 'enterprise')
ON CONFLICT (tier_id, feature_key) DO NOTHING;

INSERT INTO public.plan_features (tier_id, feature_key, enabled, limit_value)
SELECT t.id, 'ai_structuring_monthly_limit', true, NULL
FROM public.plan_tiers t WHERE t.name IN ('team', 'pro', 'enterprise')
ON CONFLICT (tier_id, feature_key) DO NOTHING;
