-- SID:365 — Docs 리비전 50개 제한 + RLS deleted_at 자동 필터

-- 1. 리비전 50개 제한 RPC
CREATE OR REPLACE FUNCTION public.trim_doc_revisions(_doc_id uuid, _keep integer DEFAULT 50)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  DELETE FROM public.doc_revisions
  WHERE doc_id = _doc_id
    AND id NOT IN (
      SELECT id FROM public.doc_revisions
      WHERE doc_id = _doc_id
      ORDER BY created_at DESC
      LIMIT _keep
    );
END;
$$;

-- 2. RLS SELECT 정책에 deleted_at IS NULL 조건 추가 (7개 테이블)
-- 기존 정책 DROP + 새 정책 CREATE

-- organizations
DROP POLICY IF EXISTS "org_select_own" ON public.organizations;
CREATE POLICY "org_select_own_active" ON public.organizations FOR SELECT
  USING (id IN (SELECT public.get_user_org_ids()) AND (deleted_at IS NULL));

-- projects
DROP POLICY IF EXISTS "projects_select_own_org" ON public.projects;
CREATE POLICY "projects_select_own_org_active" ON public.projects FOR SELECT
  USING (org_id IN (SELECT public.get_user_org_ids()) AND (deleted_at IS NULL));

-- sprints
DROP POLICY IF EXISTS "sprints_select" ON public.sprints;
CREATE POLICY "sprints_select_own_org_active" ON public.sprints FOR SELECT
  USING (org_id IN (SELECT public.get_user_org_ids()) AND (deleted_at IS NULL));

-- epics
DROP POLICY IF EXISTS "epics_select" ON public.epics;
CREATE POLICY "epics_select_own_org_active" ON public.epics FOR SELECT
  USING (org_id IN (SELECT public.get_user_org_ids()) AND (deleted_at IS NULL));

-- stories
DROP POLICY IF EXISTS "stories_select" ON public.stories;
CREATE POLICY "stories_select_own_org_active" ON public.stories FOR SELECT
  USING (org_id IN (SELECT public.get_user_org_ids()) AND (deleted_at IS NULL));

-- memos
DROP POLICY IF EXISTS "memos_select" ON public.memos;
CREATE POLICY "memos_select_own_org_active" ON public.memos FOR SELECT
  USING (org_id IN (SELECT public.get_user_org_ids()) AND (deleted_at IS NULL));

-- agent_runs
DROP POLICY IF EXISTS "agent_runs_select" ON public.agent_runs;
CREATE POLICY "agent_runs_select_own_org_active" ON public.agent_runs FOR SELECT
  USING (org_id IN (SELECT public.get_user_org_ids()) AND (deleted_at IS NULL));

-- TODO: admin이 삭제된 데이터 조회하는 별도 API 필요 시
-- service_role 사용 또는 BYPASSRLS 정책 추가

-- 3. docs slug partial unique index (soft delete 후 같은 slug 생성 허용)
-- constraint-backed unique → constraint DROP + partial index CREATE
ALTER TABLE public.docs DROP CONSTRAINT IF EXISTS docs_project_id_slug_key;
CREATE UNIQUE INDEX IF NOT EXISTS docs_project_slug_active ON public.docs (project_id, slug)
  WHERE deleted_at IS NULL;
