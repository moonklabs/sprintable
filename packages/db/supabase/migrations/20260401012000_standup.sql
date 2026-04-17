-- 012: Standup entries table

CREATE TABLE IF NOT EXISTS public.standup_entries (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id      uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  project_id  uuid NOT NULL REFERENCES public.projects(id) ON DELETE CASCADE,
  sprint_id   uuid REFERENCES public.sprints(id) ON DELETE SET NULL,
  author_id   uuid NOT NULL REFERENCES public.team_members(id) ON DELETE CASCADE,
  date        date NOT NULL,
  done        text,
  plan        text,
  blockers    text,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (project_id, author_id, date)
);

COMMENT ON TABLE public.standup_entries IS '데일리 스탠드업';

CREATE INDEX idx_standup_entries_project ON public.standup_entries(project_id);
CREATE INDEX idx_standup_entries_author ON public.standup_entries(author_id);
CREATE INDEX idx_standup_entries_date ON public.standup_entries(date);

-- RLS
ALTER TABLE public.standup_entries ENABLE ROW LEVEL SECURITY;

CREATE POLICY "standup_select" ON public.standup_entries FOR SELECT
  USING (org_id IN (SELECT public.get_user_org_ids()));

CREATE POLICY "standup_insert" ON public.standup_entries FOR INSERT
  WITH CHECK (org_id IN (SELECT public.get_user_org_ids()));

CREATE POLICY "standup_update" ON public.standup_entries FOR UPDATE
  USING (org_id IN (SELECT public.get_user_org_ids()));

-- updated_at trigger
CREATE TRIGGER trg_standup_entries_updated_at
  BEFORE UPDATE ON public.standup_entries
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at();
