-- 009: Soft delete — 7개 테이블에 deleted_at 추가

-- 1. organizations
ALTER TABLE public.organizations ADD COLUMN IF NOT EXISTS deleted_at timestamptz;

-- 2. projects
ALTER TABLE public.projects ADD COLUMN IF NOT EXISTS deleted_at timestamptz;

-- 3. team_members
ALTER TABLE public.team_members ADD COLUMN IF NOT EXISTS deleted_at timestamptz;

-- 4. sprints
ALTER TABLE public.sprints ADD COLUMN IF NOT EXISTS deleted_at timestamptz;

-- 5. epics
ALTER TABLE public.epics ADD COLUMN IF NOT EXISTS deleted_at timestamptz;

-- 6. stories
ALTER TABLE public.stories ADD COLUMN IF NOT EXISTS deleted_at timestamptz;

-- 7. tasks
ALTER TABLE public.tasks ADD COLUMN IF NOT EXISTS deleted_at timestamptz;

-- RLS 수정: 모든 SELECT 정책에 deleted_at IS NULL 추가
-- organizations
DROP POLICY IF EXISTS "org_select_own" ON public.organizations;
CREATE POLICY "org_select_own" ON public.organizations FOR SELECT
  USING (id IN (SELECT public.get_user_org_ids()) AND deleted_at IS NULL);

-- projects
DROP POLICY IF EXISTS "projects_select_own_org" ON public.projects;
CREATE POLICY "projects_select_own_org" ON public.projects FOR SELECT
  USING (org_id IN (SELECT public.get_user_org_ids()) AND deleted_at IS NULL);

-- team_members
DROP POLICY IF EXISTS "team_members_select_own_org" ON public.team_members;
CREATE POLICY "team_members_select_own_org" ON public.team_members FOR SELECT
  USING (org_id IN (SELECT public.get_user_org_ids()) AND deleted_at IS NULL);

-- sprints
DROP POLICY IF EXISTS "sprints_select" ON public.sprints;
CREATE POLICY "sprints_select" ON public.sprints FOR SELECT
  USING (org_id IN (SELECT public.get_user_org_ids()) AND deleted_at IS NULL);

-- epics
DROP POLICY IF EXISTS "epics_select" ON public.epics;
CREATE POLICY "epics_select" ON public.epics FOR SELECT
  USING (org_id IN (SELECT public.get_user_org_ids()) AND deleted_at IS NULL);

-- stories
DROP POLICY IF EXISTS "stories_select" ON public.stories;
CREATE POLICY "stories_select" ON public.stories FOR SELECT
  USING (org_id IN (SELECT public.get_user_org_ids()) AND deleted_at IS NULL);

-- tasks
DROP POLICY IF EXISTS "tasks_select" ON public.tasks;
CREATE POLICY "tasks_select" ON public.tasks FOR SELECT
  USING (org_id IN (SELECT public.get_user_org_ids()) AND deleted_at IS NULL);
