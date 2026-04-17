-- SID:367 — 프로젝트별 웹훅

-- 1. webhook_configs에 project_id 추가
ALTER TABLE public.webhook_configs
  ADD COLUMN IF NOT EXISTS project_id uuid REFERENCES public.projects(id) ON DELETE CASCADE;

-- 2. 기존 UNIQUE(member_id) → UNIQUE(org_id, member_id, project_id)
ALTER TABLE public.webhook_configs DROP CONSTRAINT IF EXISTS webhook_configs_member_id_key;
CREATE UNIQUE INDEX IF NOT EXISTS idx_webhook_configs_unique
  ON public.webhook_configs (org_id, member_id, project_id)
  WHERE project_id IS NOT NULL;
-- project_id가 null인 기존 row는 default 웹훅으로 유지
CREATE UNIQUE INDEX IF NOT EXISTS idx_webhook_configs_default
  ON public.webhook_configs (org_id, member_id)
  WHERE project_id IS NULL;
