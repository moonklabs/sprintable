-- S10:E-034 — Story activity tracking
-- Adds story_activities table for tracking story changes

-- ============================================================
-- 1. story_activities
-- ============================================================
CREATE TABLE IF NOT EXISTS public.story_activities (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  story_id      uuid NOT NULL REFERENCES public.stories(id) ON DELETE CASCADE,
  org_id        uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  project_id    uuid NOT NULL REFERENCES public.projects(id) ON DELETE CASCADE,
  activity_type text NOT NULL, -- 'status_changed', 'assignee_changed', 'created', 'updated', etc.
  old_value     text,
  new_value     text,
  created_by    uuid NOT NULL REFERENCES public.team_members(id) ON DELETE CASCADE,
  created_at    timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE public.story_activities IS '스토리 활동 로그';

CREATE INDEX idx_story_activities_story_id ON public.story_activities(story_id, created_at DESC);
CREATE INDEX idx_story_activities_org_id ON public.story_activities(org_id);
CREATE INDEX idx_story_activities_type ON public.story_activities(activity_type);

-- ============================================================
-- 2. RLS policies
-- ============================================================
ALTER TABLE public.story_activities ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "story_activities_select" ON public.story_activities;
CREATE POLICY "story_activities_select" ON public.story_activities FOR SELECT
  USING (org_id IN (SELECT public.get_user_org_ids()));

DROP POLICY IF EXISTS "story_activities_insert" ON public.story_activities;
CREATE POLICY "story_activities_insert" ON public.story_activities FOR INSERT
  WITH CHECK (org_id IN (SELECT public.get_user_org_ids()));

DROP POLICY IF EXISTS "story_activities_delete" ON public.story_activities;
CREATE POLICY "story_activities_delete" ON public.story_activities FOR DELETE
  USING (org_id IN (SELECT public.get_user_admin_org_ids()));

-- ============================================================
-- 3. Automatic activity logging trigger
-- ============================================================
CREATE OR REPLACE FUNCTION public.log_story_activity()
RETURNS TRIGGER AS $$
DECLARE
  current_user_id uuid;
BEGIN
  -- Get current user's team_member id
  SELECT id INTO current_user_id
  FROM public.team_members
  WHERE user_id = auth.uid()
    AND org_id = COALESCE(NEW.org_id, OLD.org_id)
  LIMIT 1;

  IF current_user_id IS NULL THEN
    RETURN COALESCE(NEW, OLD);
  END IF;

  IF (TG_OP = 'INSERT') THEN
    INSERT INTO public.story_activities (story_id, org_id, project_id, activity_type, new_value, created_by)
    VALUES (NEW.id, NEW.org_id, NEW.project_id, 'created', NEW.title, current_user_id);
  ELSIF (TG_OP = 'UPDATE') THEN
    -- Track status changes
    IF OLD.status IS DISTINCT FROM NEW.status THEN
      INSERT INTO public.story_activities (story_id, org_id, project_id, activity_type, old_value, new_value, created_by)
      VALUES (NEW.id, NEW.org_id, NEW.project_id, 'status_changed', OLD.status, NEW.status, current_user_id);
    END IF;

    -- Track assignee changes
    IF OLD.assignee_id IS DISTINCT FROM NEW.assignee_id THEN
      INSERT INTO public.story_activities (story_id, org_id, project_id, activity_type, old_value, new_value, created_by)
      VALUES (NEW.id, NEW.org_id, NEW.project_id, 'assignee_changed',
              COALESCE(OLD.assignee_id::text, ''),
              COALESCE(NEW.assignee_id::text, ''),
              current_user_id);
    END IF;

    -- Track title changes
    IF OLD.title IS DISTINCT FROM NEW.title THEN
      INSERT INTO public.story_activities (story_id, org_id, project_id, activity_type, old_value, new_value, created_by)
      VALUES (NEW.id, NEW.org_id, NEW.project_id, 'title_changed', OLD.title, NEW.title, current_user_id);
    END IF;

    -- Track epic changes
    IF OLD.epic_id IS DISTINCT FROM NEW.epic_id THEN
      INSERT INTO public.story_activities (story_id, org_id, project_id, activity_type, old_value, new_value, created_by)
      VALUES (NEW.id, NEW.org_id, NEW.project_id, 'epic_changed',
              COALESCE(OLD.epic_id::text, ''),
              COALESCE(NEW.epic_id::text, ''),
              current_user_id);
    END IF;

    -- Track sprint changes
    IF OLD.sprint_id IS DISTINCT FROM NEW.sprint_id THEN
      INSERT INTO public.story_activities (story_id, org_id, project_id, activity_type, old_value, new_value, created_by)
      VALUES (NEW.id, NEW.org_id, NEW.project_id, 'sprint_changed',
              COALESCE(OLD.sprint_id::text, ''),
              COALESCE(NEW.sprint_id::text, ''),
              current_user_id);
    END IF;
  END IF;

  RETURN COALESCE(NEW, OLD);
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

DROP TRIGGER IF EXISTS trg_log_story_activity ON public.stories;
CREATE TRIGGER trg_log_story_activity
  AFTER INSERT OR UPDATE ON public.stories
  FOR EACH ROW EXECUTE FUNCTION public.log_story_activity();
