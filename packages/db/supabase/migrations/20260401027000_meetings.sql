-- SID:374 — 회의록

-- meeting_type enum
DO $$ BEGIN
  CREATE TYPE public.meeting_type AS ENUM ('standup', 'retro', 'general', 'review');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

CREATE TABLE IF NOT EXISTS public.meetings (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id      uuid NOT NULL REFERENCES public.projects(id) ON DELETE CASCADE,
  title           text NOT NULL,
  meeting_type    public.meeting_type NOT NULL DEFAULT 'general',
  date            timestamptz NOT NULL DEFAULT now(),
  duration_min    integer,
  participants    jsonb NOT NULL DEFAULT '[]',
  raw_transcript  text,
  ai_summary      text,
  decisions       jsonb NOT NULL DEFAULT '[]',
  action_items    jsonb NOT NULL DEFAULT '[]',
  created_by      uuid REFERENCES public.team_members(id),
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  deleted_at      timestamptz
);

CREATE INDEX idx_meetings_project ON public.meetings(project_id);
CREATE INDEX idx_meetings_date ON public.meetings(date DESC);
CREATE INDEX idx_meetings_deleted ON public.meetings(deleted_at) WHERE deleted_at IS NULL;

ALTER TABLE public.meetings ENABLE ROW LEVEL SECURITY;

CREATE POLICY "meetings_select" ON public.meetings FOR SELECT
  USING (deleted_at IS NULL AND project_id IN (
    SELECT project_id FROM public.team_members WHERE user_id = auth.uid()
  ));

CREATE POLICY "meetings_insert" ON public.meetings FOR INSERT
  WITH CHECK (project_id IN (
    SELECT project_id FROM public.team_members WHERE user_id = auth.uid()
  ));

CREATE POLICY "meetings_update" ON public.meetings FOR UPDATE
  USING (deleted_at IS NULL AND project_id IN (
    SELECT project_id FROM public.team_members WHERE user_id = auth.uid()
  ));

CREATE POLICY "meetings_delete" ON public.meetings FOR DELETE
  USING (deleted_at IS NULL AND project_id IN (
    SELECT project_id FROM public.team_members WHERE user_id = auth.uid()
  ));
