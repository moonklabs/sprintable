-- SID:387 — policy documents source-of-truth

CREATE TABLE IF NOT EXISTS public.policy_documents (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id           uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  project_id       uuid NOT NULL REFERENCES public.projects(id) ON DELETE CASCADE,
  sprint_id        uuid NOT NULL REFERENCES public.sprints(id) ON DELETE CASCADE,
  epic_id          uuid NOT NULL REFERENCES public.epics(id) ON DELETE CASCADE,
  title            text NOT NULL,
  content          text NOT NULL DEFAULT '',
  legacy_sprint_key text,
  legacy_epic_key   text,
  created_by       uuid REFERENCES public.team_members(id) ON DELETE SET NULL,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now(),
  deleted_at       timestamptz,
  UNIQUE (project_id, sprint_id, epic_id)
);

CREATE INDEX IF NOT EXISTS idx_policy_documents_project ON public.policy_documents(project_id);
CREATE INDEX IF NOT EXISTS idx_policy_documents_sprint ON public.policy_documents(sprint_id);
CREATE INDEX IF NOT EXISTS idx_policy_documents_epic ON public.policy_documents(epic_id);

ALTER TABLE public.policy_documents ENABLE ROW LEVEL SECURITY;

CREATE POLICY "policy_documents_select" ON public.policy_documents FOR SELECT
  USING (org_id IN (SELECT public.get_user_org_ids()) AND deleted_at IS NULL);
CREATE POLICY "policy_documents_insert" ON public.policy_documents FOR INSERT
  WITH CHECK (org_id IN (SELECT public.get_user_org_ids()));
CREATE POLICY "policy_documents_update" ON public.policy_documents FOR UPDATE
  USING (org_id IN (SELECT public.get_user_org_ids()));

CREATE TRIGGER trg_policy_documents_updated_at
  BEFORE UPDATE ON public.policy_documents
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at();
