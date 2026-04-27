-- E-PM-ENHANCE S7: story_activities 테이블 신설
-- 스토리 상태 변경 / 담당자 변경 이력 추적

CREATE TABLE IF NOT EXISTS public.story_activities (
  id          uuid        DEFAULT gen_random_uuid() PRIMARY KEY,
  story_id    uuid        NOT NULL REFERENCES public.stories(id) ON DELETE CASCADE,
  org_id      uuid        NOT NULL,
  actor_id    uuid        NOT NULL,
  action_type text        NOT NULL CHECK (action_type IN ('status_changed', 'assignee_changed', 'comment_added')),
  old_value   text,
  new_value   text,
  created_at  timestamptz DEFAULT now() NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_story_activities_story_id
  ON public.story_activities(story_id, created_at DESC);

ALTER TABLE public.story_activities ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "story_activities_select" ON public.story_activities;
CREATE POLICY "story_activities_select" ON public.story_activities FOR SELECT
  USING (org_id IN (SELECT public.get_user_org_ids()));

DROP POLICY IF EXISTS "story_activities_insert" ON public.story_activities;
CREATE POLICY "story_activities_insert" ON public.story_activities FOR INSERT
  WITH CHECK (org_id IN (SELECT public.get_user_org_ids()));
