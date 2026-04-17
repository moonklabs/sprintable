-- SID:465 — track BYOM org integrations and KMS rotation state

CREATE TABLE IF NOT EXISTS public.org_integrations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  project_id uuid NOT NULL REFERENCES public.projects(id) ON DELETE CASCADE,
  integration_type text NOT NULL DEFAULT 'byom_api_key',
  provider text NOT NULL CHECK (provider IN ('openai', 'anthropic', 'google', 'groq', 'openai-compatible')),
  secret_last4 text,
  kms_status text NOT NULL DEFAULT 'active' CHECK (kms_status IN ('active', 'rotation_requested')),
  rotation_requested_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (project_id, integration_type)
);

CREATE INDEX IF NOT EXISTS idx_org_integrations_org_project
  ON public.org_integrations(org_id, project_id);

ALTER TABLE public.org_integrations ENABLE ROW LEVEL SECURITY;

CREATE POLICY "org_integrations_select"
  ON public.org_integrations FOR SELECT
  USING (org_id IN (SELECT public.get_user_admin_org_ids()));

CREATE POLICY "org_integrations_insert"
  ON public.org_integrations FOR INSERT
  WITH CHECK (org_id IN (SELECT public.get_user_admin_org_ids()));

CREATE POLICY "org_integrations_update"
  ON public.org_integrations FOR UPDATE
  USING (org_id IN (SELECT public.get_user_admin_org_ids()));

CREATE POLICY "org_integrations_delete"
  ON public.org_integrations FOR DELETE
  USING (org_id IN (SELECT public.get_user_admin_org_ids()));
