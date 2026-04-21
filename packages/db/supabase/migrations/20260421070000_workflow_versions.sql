-- E-WORKFLOW-VIZ:S1 — workflow_versions 버전 이력 테이블

-- ============================================================
-- 1. workflow_versions 테이블
-- ============================================================
CREATE TABLE IF NOT EXISTS public.workflow_versions (
  id              uuid        NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  org_id          uuid        NOT NULL,
  project_id      uuid        NOT NULL,
  version         integer     NOT NULL,
  snapshot        jsonb       NOT NULL DEFAULT '[]',
  change_summary  jsonb       NOT NULL DEFAULT '{}',
  created_by      uuid        REFERENCES public.team_members(id) ON DELETE SET NULL,
  created_at      timestamptz NOT NULL DEFAULT now(),

  UNIQUE (project_id, version)
);

COMMENT ON TABLE public.workflow_versions IS '워크플로우 라우팅 규칙 버전 이력';
COMMENT ON COLUMN public.workflow_versions.snapshot IS '저장 시점의 agent_routing_rules 전체 배열 (JSONB)';
COMMENT ON COLUMN public.workflow_versions.change_summary IS '변경 요약: added_rules, removed_rules, changed_rules 카운트';

CREATE INDEX idx_workflow_versions_project_id ON public.workflow_versions(project_id, version DESC);
CREATE INDEX idx_workflow_versions_org_id ON public.workflow_versions(org_id);

-- ============================================================
-- 2. RLS
-- ============================================================
ALTER TABLE public.workflow_versions ENABLE ROW LEVEL SECURITY;

-- org 멤버는 읽기 가능
CREATE POLICY "workflow_versions_select_org_member"
  ON public.workflow_versions
  FOR SELECT
  TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM public.team_members tm
      WHERE tm.org_id = workflow_versions.org_id
        AND tm.user_id = auth.uid()
        AND tm.deleted_at IS NULL
    )
  );

-- org admin만 insert 가능 (service_role 포함)
CREATE POLICY "workflow_versions_insert_org_admin"
  ON public.workflow_versions
  FOR INSERT
  TO authenticated
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM public.team_members tm
      WHERE tm.org_id = workflow_versions.org_id
        AND tm.user_id = auth.uid()
        AND tm.role = 'admin'
        AND tm.deleted_at IS NULL
    )
  );

-- service_role bypass (agent writes)
CREATE POLICY "workflow_versions_service_role_all"
  ON public.workflow_versions
  FOR ALL
  TO service_role
  USING (true)
  WITH CHECK (true);

-- ============================================================
-- 3. next_workflow_version() — project 내 auto-increment
-- ============================================================
CREATE OR REPLACE FUNCTION public.next_workflow_version(p_project_id uuid)
RETURNS integer
LANGUAGE sql
VOLATILE
AS $$
  SELECT COALESCE(MAX(version), 0) + 1
  FROM public.workflow_versions
  WHERE project_id = p_project_id;
$$;

COMMENT ON FUNCTION public.next_workflow_version IS 'project_id 기준 다음 버전 번호 반환';
