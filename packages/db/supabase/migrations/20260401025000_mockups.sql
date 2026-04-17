-- SID:368 — 목업 DB 스키마

-- 1. mockup_pages
CREATE TABLE IF NOT EXISTS public.mockup_pages (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id      uuid NOT NULL REFERENCES public.projects(id) ON DELETE CASCADE,
  org_id          uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  slug            text NOT NULL,
  title           text NOT NULL,
  category        text DEFAULT 'general',
  viewport        text NOT NULL DEFAULT 'desktop' CHECK (viewport IN ('mobile', 'desktop')),
  version         integer NOT NULL DEFAULT 1,
  created_by      uuid REFERENCES public.team_members(id) ON DELETE SET NULL,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  deleted_at      timestamptz,
  UNIQUE (project_id, slug)
);

COMMENT ON TABLE public.mockup_pages IS '목업 페이지';

CREATE INDEX idx_mockup_pages_project ON public.mockup_pages(project_id);
CREATE INDEX idx_mockup_pages_org ON public.mockup_pages(org_id);

-- 2. mockup_components
CREATE TABLE IF NOT EXISTS public.mockup_components (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  page_id         uuid NOT NULL REFERENCES public.mockup_pages(id) ON DELETE CASCADE,
  parent_id       uuid REFERENCES public.mockup_components(id) ON DELETE CASCADE,
  component_type  text NOT NULL,
  props           jsonb NOT NULL DEFAULT '{}',
  spec_description text,
  sort_order      integer NOT NULL DEFAULT 0,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE public.mockup_components IS '목업 컴포넌트 트리';

CREATE INDEX idx_mockup_components_page ON public.mockup_components(page_id);
CREATE INDEX idx_mockup_components_parent ON public.mockup_components(parent_id);

-- 3. RLS
ALTER TABLE public.mockup_pages ENABLE ROW LEVEL SECURITY;
CREATE POLICY "mockup_pages_select" ON public.mockup_pages FOR SELECT
  USING (org_id IN (SELECT public.get_user_org_ids()) AND deleted_at IS NULL);
CREATE POLICY "mockup_pages_insert" ON public.mockup_pages FOR INSERT
  WITH CHECK (org_id IN (SELECT public.get_user_org_ids()));
CREATE POLICY "mockup_pages_update" ON public.mockup_pages FOR UPDATE
  USING (org_id IN (SELECT public.get_user_org_ids()));
CREATE POLICY "mockup_pages_delete" ON public.mockup_pages FOR DELETE
  USING (org_id IN (SELECT public.get_user_admin_org_ids()));

ALTER TABLE public.mockup_components ENABLE ROW LEVEL SECURITY;
CREATE POLICY "mockup_components_select" ON public.mockup_components FOR SELECT
  USING (page_id IN (SELECT id FROM public.mockup_pages WHERE org_id IN (SELECT public.get_user_org_ids())));
CREATE POLICY "mockup_components_insert" ON public.mockup_components FOR INSERT
  WITH CHECK (page_id IN (SELECT id FROM public.mockup_pages WHERE org_id IN (SELECT public.get_user_org_ids())));
CREATE POLICY "mockup_components_update" ON public.mockup_components FOR UPDATE
  USING (page_id IN (SELECT id FROM public.mockup_pages WHERE org_id IN (SELECT public.get_user_org_ids())));
CREATE POLICY "mockup_components_delete" ON public.mockup_components FOR DELETE
  USING (page_id IN (SELECT id FROM public.mockup_pages WHERE org_id IN (SELECT public.get_user_org_ids())));

-- 4. updated_at 트리거
CREATE TRIGGER trg_mockup_pages_updated_at
  BEFORE UPDATE ON public.mockup_pages
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at();

CREATE TRIGGER trg_mockup_components_updated_at
  BEFORE UPDATE ON public.mockup_components
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at();

-- 5. version 자동 증가 RPC
CREATE OR REPLACE FUNCTION public.increment_mockup_version(_page_id uuid)
RETURNS void
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
AS $$
  UPDATE public.mockup_pages SET version = version + 1 WHERE id = _page_id;
$$;
