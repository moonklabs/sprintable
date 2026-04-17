-- SID:E-031:S6 — project-scoped HITL trigger/policy persistence

CREATE TABLE IF NOT EXISTS public.agent_hitl_policies (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  project_id uuid NOT NULL REFERENCES public.projects(id) ON DELETE CASCADE,
  config jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_by uuid REFERENCES public.team_members(id) ON DELETE SET NULL,
  updated_by uuid REFERENCES public.team_members(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (project_id)
);

ALTER TABLE public.agent_hitl_policies
  DROP CONSTRAINT IF EXISTS agent_hitl_policies_config_is_object;

ALTER TABLE public.agent_hitl_policies
  ADD CONSTRAINT agent_hitl_policies_config_is_object
  CHECK (jsonb_typeof(config) = 'object');

CREATE INDEX IF NOT EXISTS idx_agent_hitl_policies_org_project
  ON public.agent_hitl_policies(org_id, project_id);

ALTER TABLE public.agent_hitl_policies ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "agent_hitl_policies_select" ON public.agent_hitl_policies;
CREATE POLICY "agent_hitl_policies_select" ON public.agent_hitl_policies FOR SELECT
  USING (org_id IN (SELECT public.get_user_admin_org_ids()));

DROP POLICY IF EXISTS "agent_hitl_policies_insert" ON public.agent_hitl_policies;
CREATE POLICY "agent_hitl_policies_insert" ON public.agent_hitl_policies FOR INSERT
  WITH CHECK (org_id IN (SELECT public.get_user_admin_org_ids()));

DROP POLICY IF EXISTS "agent_hitl_policies_update" ON public.agent_hitl_policies;
CREATE POLICY "agent_hitl_policies_update" ON public.agent_hitl_policies FOR UPDATE
  USING (org_id IN (SELECT public.get_user_admin_org_ids()))
  WITH CHECK (org_id IN (SELECT public.get_user_admin_org_ids()));

DROP POLICY IF EXISTS "agent_hitl_policies_delete" ON public.agent_hitl_policies;
CREATE POLICY "agent_hitl_policies_delete" ON public.agent_hitl_policies FOR DELETE
  USING (org_id IN (SELECT public.get_user_admin_org_ids()));
