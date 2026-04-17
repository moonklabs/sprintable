-- SID:372 — 시나리오 + 버전 히스토리

-- 1. mockup_scenarios
CREATE TABLE IF NOT EXISTS public.mockup_scenarios (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  page_id     uuid NOT NULL REFERENCES public.mockup_pages(id) ON DELETE CASCADE,
  name        text NOT NULL,
  override_props jsonb NOT NULL DEFAULT '{}',
  is_default  boolean NOT NULL DEFAULT false,
  sort_order  integer NOT NULL DEFAULT 0,
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX idx_mockup_scenarios_page ON public.mockup_scenarios(page_id);

ALTER TABLE public.mockup_scenarios ENABLE ROW LEVEL SECURITY;
CREATE POLICY "scenarios_select" ON public.mockup_scenarios FOR SELECT
  USING (page_id IN (SELECT id FROM public.mockup_pages WHERE org_id IN (SELECT public.get_user_org_ids())));
CREATE POLICY "scenarios_insert" ON public.mockup_scenarios FOR INSERT
  WITH CHECK (page_id IN (SELECT id FROM public.mockup_pages WHERE org_id IN (SELECT public.get_user_org_ids())));
CREATE POLICY "scenarios_update" ON public.mockup_scenarios FOR UPDATE
  USING (page_id IN (SELECT id FROM public.mockup_pages WHERE org_id IN (SELECT public.get_user_org_ids())));
CREATE POLICY "scenarios_delete" ON public.mockup_scenarios FOR DELETE
  USING (page_id IN (SELECT id FROM public.mockup_pages WHERE org_id IN (SELECT public.get_user_org_ids())));

-- backfill: 기존 mockup_pages에 default scenario 생성
INSERT INTO public.mockup_scenarios (page_id, name, override_props, is_default, sort_order)
SELECT p.id, 'default', '{}', true, 0
FROM public.mockup_pages p
WHERE NOT EXISTS (
  SELECT 1 FROM public.mockup_scenarios s WHERE s.page_id = p.id AND s.is_default = true
);

-- 2. mockup_versions
CREATE TABLE IF NOT EXISTS public.mockup_versions (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  page_id     uuid NOT NULL REFERENCES public.mockup_pages(id) ON DELETE CASCADE,
  version     integer NOT NULL,
  snapshot    jsonb NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE(page_id, version)
);

CREATE INDEX idx_mockup_versions_page ON public.mockup_versions(page_id);

ALTER TABLE public.mockup_versions ENABLE ROW LEVEL SECURITY;
CREATE POLICY "versions_select" ON public.mockup_versions FOR SELECT
  USING (page_id IN (SELECT id FROM public.mockup_pages WHERE org_id IN (SELECT public.get_user_org_ids())));
CREATE POLICY "versions_insert" ON public.mockup_versions FOR INSERT
  WITH CHECK (page_id IN (SELECT id FROM public.mockup_pages WHERE org_id IN (SELECT public.get_user_org_ids())));
