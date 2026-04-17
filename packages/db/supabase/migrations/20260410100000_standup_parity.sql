-- 013: Standup parity, story links and feedback

ALTER TABLE public.standup_entries
  ADD COLUMN IF NOT EXISTS plan_story_ids uuid[] NOT NULL DEFAULT '{}'::uuid[];

COMMENT ON COLUMN public.standup_entries.plan_story_ids IS 'Linked sprint story ids for the standup plan';

CREATE TABLE IF NOT EXISTS public.standup_feedback (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id            uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  project_id        uuid NOT NULL REFERENCES public.projects(id) ON DELETE CASCADE,
  sprint_id         uuid REFERENCES public.sprints(id) ON DELETE SET NULL,
  standup_entry_id  uuid NOT NULL REFERENCES public.standup_entries(id) ON DELETE CASCADE,
  feedback_by_id    uuid NOT NULL REFERENCES public.team_members(id) ON DELETE CASCADE,
  review_type       text NOT NULL DEFAULT 'comment',
  feedback_text     text NOT NULL,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT standup_feedback_review_type_check
    CHECK (review_type IN ('comment', 'approve', 'request_changes'))
);

COMMENT ON TABLE public.standup_feedback IS '스탠드업 피드백';

CREATE INDEX IF NOT EXISTS idx_standup_feedback_project ON public.standup_feedback(project_id);
CREATE INDEX IF NOT EXISTS idx_standup_feedback_entry ON public.standup_feedback(standup_entry_id);
CREATE INDEX IF NOT EXISTS idx_standup_feedback_author ON public.standup_feedback(feedback_by_id);
CREATE INDEX IF NOT EXISTS idx_standup_feedback_sprint ON public.standup_feedback(sprint_id);

ALTER TABLE public.standup_feedback ENABLE ROW LEVEL SECURITY;

CREATE POLICY "standup_feedback_select" ON public.standup_feedback FOR SELECT
  USING (org_id IN (SELECT public.get_user_org_ids()));

CREATE POLICY "standup_feedback_insert" ON public.standup_feedback FOR INSERT
  WITH CHECK (org_id IN (SELECT public.get_user_org_ids()));

CREATE POLICY "standup_feedback_update" ON public.standup_feedback FOR UPDATE
  USING (org_id IN (SELECT public.get_user_org_ids()));

CREATE POLICY "standup_feedback_delete" ON public.standup_feedback FOR DELETE
  USING (org_id IN (SELECT public.get_user_org_ids()));

CREATE TRIGGER trg_standup_feedback_updated_at
  BEFORE UPDATE ON public.standup_feedback
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at();
