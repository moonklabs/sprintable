-- E-002:S3 — PM 코어 테이블: sprints, epics, stories, tasks + RLS

-- ============================================================
-- 1. sprints
-- ============================================================
CREATE TABLE IF NOT EXISTS public.sprints (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id      uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  project_id  uuid NOT NULL REFERENCES public.projects(id) ON DELETE CASCADE,
  title       text NOT NULL,
  status      text NOT NULL DEFAULT 'planning' CHECK (status IN ('planning', 'active', 'closed')),
  start_date  date,
  end_date    date,
  velocity    integer,
  team_size   integer,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE public.sprints IS '스프린트';

CREATE INDEX idx_sprints_project_id ON public.sprints(project_id);
CREATE INDEX idx_sprints_org_id ON public.sprints(org_id);

-- ============================================================
-- 2. epics
-- ============================================================
CREATE TABLE IF NOT EXISTS public.epics (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id      uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  project_id  uuid NOT NULL REFERENCES public.projects(id) ON DELETE CASCADE,
  title       text NOT NULL,
  status      text NOT NULL DEFAULT 'open',
  priority    text NOT NULL DEFAULT 'medium',
  description text,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE public.epics IS '에픽';

CREATE INDEX idx_epics_project_id ON public.epics(project_id);
CREATE INDEX idx_epics_org_id ON public.epics(org_id);

-- ============================================================
-- 3. stories
-- ============================================================
CREATE TABLE IF NOT EXISTS public.stories (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id        uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  project_id    uuid NOT NULL REFERENCES public.projects(id) ON DELETE CASCADE,
  epic_id       uuid REFERENCES public.epics(id) ON DELETE SET NULL,
  sprint_id     uuid REFERENCES public.sprints(id) ON DELETE SET NULL,
  assignee_id   uuid REFERENCES public.team_members(id) ON DELETE SET NULL,
  title         text NOT NULL,
  status        text NOT NULL DEFAULT 'backlog' CHECK (status IN ('backlog', 'ready-for-dev', 'in-progress', 'in-review', 'done')),
  priority      text NOT NULL DEFAULT 'medium',
  story_points  integer,
  description   text,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE public.stories IS '스토리';

CREATE INDEX idx_stories_sprint_id ON public.stories(sprint_id);
CREATE INDEX idx_stories_epic_id ON public.stories(epic_id);
CREATE INDEX idx_stories_assignee_id ON public.stories(assignee_id);
CREATE INDEX idx_stories_project_id ON public.stories(project_id);
CREATE INDEX idx_stories_org_id ON public.stories(org_id);

-- ============================================================
-- 4. tasks
-- ============================================================
CREATE TABLE IF NOT EXISTS public.tasks (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id        uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  story_id      uuid NOT NULL REFERENCES public.stories(id) ON DELETE CASCADE,
  assignee_id   uuid REFERENCES public.team_members(id) ON DELETE SET NULL,
  title         text NOT NULL,
  status        text NOT NULL DEFAULT 'todo' CHECK (status IN ('todo', 'in-progress', 'done')),
  story_points  integer,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE public.tasks IS '태스크';

CREATE INDEX idx_tasks_story_id ON public.tasks(story_id);
CREATE INDEX idx_tasks_assignee_id ON public.tasks(assignee_id);
CREATE INDEX idx_tasks_org_id ON public.tasks(org_id);

-- ============================================================
-- 5. RLS — org_id 기반 격리
-- ============================================================

-- sprints
ALTER TABLE public.sprints ENABLE ROW LEVEL SECURITY;

CREATE POLICY "sprints_select" ON public.sprints FOR SELECT
  USING (org_id IN (SELECT public.get_user_org_ids()));
CREATE POLICY "sprints_insert" ON public.sprints FOR INSERT
  WITH CHECK (org_id IN (SELECT public.get_user_admin_org_ids()));
CREATE POLICY "sprints_update" ON public.sprints FOR UPDATE
  USING (org_id IN (SELECT public.get_user_admin_org_ids()));
CREATE POLICY "sprints_delete" ON public.sprints FOR DELETE
  USING (org_id IN (SELECT public.get_user_admin_org_ids()));

-- epics
ALTER TABLE public.epics ENABLE ROW LEVEL SECURITY;

CREATE POLICY "epics_select" ON public.epics FOR SELECT
  USING (org_id IN (SELECT public.get_user_org_ids()));
CREATE POLICY "epics_insert" ON public.epics FOR INSERT
  WITH CHECK (org_id IN (SELECT public.get_user_org_ids()));
CREATE POLICY "epics_update" ON public.epics FOR UPDATE
  USING (org_id IN (SELECT public.get_user_org_ids()));
CREATE POLICY "epics_delete" ON public.epics FOR DELETE
  USING (org_id IN (SELECT public.get_user_admin_org_ids()));

-- stories
ALTER TABLE public.stories ENABLE ROW LEVEL SECURITY;

CREATE POLICY "stories_select" ON public.stories FOR SELECT
  USING (org_id IN (SELECT public.get_user_org_ids()));
CREATE POLICY "stories_insert" ON public.stories FOR INSERT
  WITH CHECK (org_id IN (SELECT public.get_user_org_ids()));
CREATE POLICY "stories_update" ON public.stories FOR UPDATE
  USING (org_id IN (SELECT public.get_user_org_ids()));
CREATE POLICY "stories_delete" ON public.stories FOR DELETE
  USING (org_id IN (SELECT public.get_user_admin_org_ids()));

-- tasks
ALTER TABLE public.tasks ENABLE ROW LEVEL SECURITY;

CREATE POLICY "tasks_select" ON public.tasks FOR SELECT
  USING (org_id IN (SELECT public.get_user_org_ids()));
CREATE POLICY "tasks_insert" ON public.tasks FOR INSERT
  WITH CHECK (org_id IN (SELECT public.get_user_org_ids()));
CREATE POLICY "tasks_update" ON public.tasks FOR UPDATE
  USING (org_id IN (SELECT public.get_user_org_ids()));
CREATE POLICY "tasks_delete" ON public.tasks FOR DELETE
  USING (org_id IN (SELECT public.get_user_admin_org_ids()));

-- ============================================================
-- 6. updated_at 자동 갱신 트리거
-- ============================================================
CREATE TRIGGER trg_sprints_updated_at
  BEFORE UPDATE ON public.sprints
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at();

CREATE TRIGGER trg_epics_updated_at
  BEFORE UPDATE ON public.epics
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at();

CREATE TRIGGER trg_stories_updated_at
  BEFORE UPDATE ON public.stories
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at();

CREATE TRIGGER trg_tasks_updated_at
  BEFORE UPDATE ON public.tasks
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at();
