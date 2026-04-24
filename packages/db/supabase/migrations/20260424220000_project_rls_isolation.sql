-- E-PM-ENHANCE S5: 프로젝트별 RLS 격리
-- auth.uid() → team_members → project_id 배열 반환 헬퍼 함수 + SELECT 정책에 project_id 조건 추가

-- 1. get_user_project_ids() 헬퍼 함수
CREATE OR REPLACE FUNCTION public.get_user_project_ids()
RETURNS SETOF uuid
LANGUAGE sql
STABLE SECURITY DEFINER
SET search_path = public
AS $$
  SELECT DISTINCT project_id
  FROM public.team_members
  WHERE user_id = auth.uid()
    AND is_active = true
    AND project_id IS NOT NULL;
$$;

-- 2. stories SELECT 정책: org_id + project_id 이중 조건
DROP POLICY IF EXISTS "stories_select_own_org_active" ON public.stories;
CREATE POLICY "stories_select_own_org_active" ON public.stories FOR SELECT
  USING (
    org_id IN (SELECT public.get_user_org_ids())
    AND project_id IN (SELECT public.get_user_project_ids())
    AND (deleted_at IS NULL)
  );

-- 3. tasks SELECT 정책: org_id + project_id 이중 조건
DROP POLICY IF EXISTS "tasks_select" ON public.tasks;
CREATE POLICY "tasks_select" ON public.tasks FOR SELECT
  USING (
    org_id IN (SELECT public.get_user_org_ids())
    AND story_id IN (
      SELECT id FROM public.stories
      WHERE project_id IN (SELECT public.get_user_project_ids())
        AND deleted_at IS NULL
    )
    AND deleted_at IS NULL
  );

-- 4. sprints SELECT 정책: org_id + project_id 이중 조건
DROP POLICY IF EXISTS "sprints_select_own_org_active" ON public.sprints;
CREATE POLICY "sprints_select_own_org_active" ON public.sprints FOR SELECT
  USING (
    org_id IN (SELECT public.get_user_org_ids())
    AND project_id IN (SELECT public.get_user_project_ids())
    AND (deleted_at IS NULL)
  );

-- 5. memos SELECT 정책: org_id + project_id 이중 조건
DROP POLICY IF EXISTS "memos_select_own_org_active" ON public.memos;
CREATE POLICY "memos_select_own_org_active" ON public.memos FOR SELECT
  USING (
    org_id IN (SELECT public.get_user_org_ids())
    AND project_id IN (SELECT public.get_user_project_ids())
    AND (deleted_at IS NULL)
  );

-- 6. docs SELECT 정책: org_id + project_id 이중 조건
DROP POLICY IF EXISTS "docs_select" ON public.docs;
CREATE POLICY "docs_select" ON public.docs FOR SELECT
  USING (
    org_id IN (SELECT public.get_user_org_ids())
    AND project_id IN (SELECT public.get_user_project_ids())
    AND deleted_at IS NULL
  );
