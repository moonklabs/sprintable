-- 014: Docs hub — docs, doc_revisions, doc_comments

-- 1. docs
CREATE TABLE IF NOT EXISTS public.docs (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id      uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  project_id  uuid NOT NULL REFERENCES public.projects(id) ON DELETE CASCADE,
  parent_id   uuid REFERENCES public.docs(id) ON DELETE SET NULL,
  title       text NOT NULL,
  slug        text NOT NULL,
  content     text NOT NULL DEFAULT '',
  icon        text,
  sort_order  integer NOT NULL DEFAULT 0,
  created_by  uuid REFERENCES public.team_members(id) ON DELETE SET NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  deleted_at  timestamptz,
  UNIQUE (project_id, slug)
);

CREATE INDEX idx_docs_project ON public.docs(project_id);
CREATE INDEX idx_docs_parent ON public.docs(parent_id);
CREATE INDEX idx_docs_slug ON public.docs(project_id, slug);

-- 2. doc_revisions
CREATE TABLE IF NOT EXISTS public.doc_revisions (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  doc_id      uuid NOT NULL REFERENCES public.docs(id) ON DELETE CASCADE,
  content     text NOT NULL,
  created_by  uuid REFERENCES public.team_members(id) ON DELETE SET NULL,
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX idx_doc_revisions_doc ON public.doc_revisions(doc_id);

-- 3. doc_comments
CREATE TABLE IF NOT EXISTS public.doc_comments (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  doc_id      uuid NOT NULL REFERENCES public.docs(id) ON DELETE CASCADE,
  content     text NOT NULL,
  created_by  uuid REFERENCES public.team_members(id) ON DELETE SET NULL,
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX idx_doc_comments_doc ON public.doc_comments(doc_id);

-- RLS
ALTER TABLE public.docs ENABLE ROW LEVEL SECURITY;
CREATE POLICY "docs_select" ON public.docs FOR SELECT
  USING (org_id IN (SELECT public.get_user_org_ids()) AND deleted_at IS NULL);
CREATE POLICY "docs_insert" ON public.docs FOR INSERT
  WITH CHECK (org_id IN (SELECT public.get_user_org_ids()));
CREATE POLICY "docs_update" ON public.docs FOR UPDATE
  USING (org_id IN (SELECT public.get_user_org_ids()));

ALTER TABLE public.doc_revisions ENABLE ROW LEVEL SECURITY;
CREATE POLICY "doc_revisions_select" ON public.doc_revisions FOR SELECT
  USING (doc_id IN (SELECT id FROM public.docs WHERE org_id IN (SELECT public.get_user_org_ids())));
CREATE POLICY "doc_revisions_insert" ON public.doc_revisions FOR INSERT
  WITH CHECK (doc_id IN (SELECT id FROM public.docs WHERE org_id IN (SELECT public.get_user_org_ids())));

ALTER TABLE public.doc_comments ENABLE ROW LEVEL SECURITY;
CREATE POLICY "doc_comments_select" ON public.doc_comments FOR SELECT
  USING (doc_id IN (SELECT id FROM public.docs WHERE org_id IN (SELECT public.get_user_org_ids())));
CREATE POLICY "doc_comments_insert" ON public.doc_comments FOR INSERT
  WITH CHECK (doc_id IN (SELECT id FROM public.docs WHERE org_id IN (SELECT public.get_user_org_ids())));

-- updated_at
CREATE TRIGGER trg_docs_updated_at
  BEFORE UPDATE ON public.docs
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at();

-- Auto-save revision on content update
CREATE OR REPLACE FUNCTION public.auto_save_doc_revision()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF NEW.content IS DISTINCT FROM OLD.content THEN
    INSERT INTO public.doc_revisions (doc_id, content, created_by)
    VALUES (NEW.id, OLD.content, NEW.created_by);
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER trg_docs_auto_revision
  BEFORE UPDATE ON public.docs
  FOR EACH ROW EXECUTE FUNCTION public.auto_save_doc_revision();
