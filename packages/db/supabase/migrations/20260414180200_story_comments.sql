-- S10:E-034 — Story comments support
-- Adds story_comments table for collaborative discussion on stories

-- ============================================================
-- 1. story_comments
-- ============================================================
CREATE TABLE IF NOT EXISTS public.story_comments (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  story_id      uuid NOT NULL REFERENCES public.stories(id) ON DELETE CASCADE,
  org_id        uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  project_id    uuid NOT NULL REFERENCES public.projects(id) ON DELETE CASCADE,
  content       text NOT NULL,
  created_by    uuid NOT NULL REFERENCES public.team_members(id) ON DELETE CASCADE,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  deleted_at    timestamptz
);

COMMENT ON TABLE public.story_comments IS '스토리 댓글';

CREATE INDEX idx_story_comments_story_id ON public.story_comments(story_id, created_at DESC);
CREATE INDEX idx_story_comments_org_id ON public.story_comments(org_id);
CREATE INDEX idx_story_comments_created_by ON public.story_comments(created_by);

-- ============================================================
-- 2. RLS policies
-- ============================================================
ALTER TABLE public.story_comments ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "story_comments_select" ON public.story_comments;
CREATE POLICY "story_comments_select" ON public.story_comments FOR SELECT
  USING (org_id IN (SELECT public.get_user_org_ids()) AND deleted_at IS NULL);

DROP POLICY IF EXISTS "story_comments_insert" ON public.story_comments;
CREATE POLICY "story_comments_insert" ON public.story_comments FOR INSERT
  WITH CHECK (org_id IN (SELECT public.get_user_org_ids()));

DROP POLICY IF EXISTS "story_comments_update" ON public.story_comments;
CREATE POLICY "story_comments_update" ON public.story_comments FOR UPDATE
  USING (org_id IN (SELECT public.get_user_org_ids()))
  WITH CHECK (org_id IN (SELECT public.get_user_org_ids()));

DROP POLICY IF EXISTS "story_comments_delete" ON public.story_comments;
CREATE POLICY "story_comments_delete" ON public.story_comments FOR DELETE
  USING (org_id IN (SELECT public.get_user_admin_org_ids()));

-- ============================================================
-- 3. Triggers
-- ============================================================
CREATE OR REPLACE FUNCTION public.update_story_comments_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_story_comments_updated_at ON public.story_comments;
CREATE TRIGGER trg_story_comments_updated_at
  BEFORE UPDATE ON public.story_comments
  FOR EACH ROW EXECUTE FUNCTION public.update_story_comments_updated_at();
