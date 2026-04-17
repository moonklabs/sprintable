-- SID:375 — stories에 meeting_id 참조 추가
ALTER TABLE public.stories ADD COLUMN IF NOT EXISTS meeting_id uuid REFERENCES public.meetings(id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS idx_stories_meeting ON public.stories(meeting_id) WHERE meeting_id IS NOT NULL;
