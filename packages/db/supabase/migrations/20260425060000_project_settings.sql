-- E-COLLAB-TOOLS S8: project_settings 테이블 신설
-- 프로젝트별 설정 (스탠드업 마감 시간 등)

CREATE TABLE IF NOT EXISTS public.project_settings (
  project_id        uuid PRIMARY KEY REFERENCES public.projects(id) ON DELETE CASCADE,
  standup_deadline  time NOT NULL DEFAULT '09:00',
  created_at        timestamptz DEFAULT now() NOT NULL,
  updated_at        timestamptz DEFAULT now() NOT NULL
);

ALTER TABLE public.project_settings ENABLE ROW LEVEL SECURITY;

CREATE POLICY "project_settings_select" ON public.project_settings FOR SELECT
  USING (project_id IN (
    SELECT DISTINCT project_id FROM public.team_members
    WHERE user_id = auth.uid() AND is_active = true
  ));

CREATE POLICY "project_settings_upsert" ON public.project_settings FOR ALL
  USING (project_id IN (
    SELECT DISTINCT project_id FROM public.team_members
    WHERE user_id = auth.uid() AND is_active = true
      AND role IN ('owner', 'admin', 'po')
  ))
  WITH CHECK (project_id IN (
    SELECT DISTINCT project_id FROM public.team_members
    WHERE user_id = auth.uid() AND is_active = true
      AND role IN ('owner', 'admin', 'po')
  ));
