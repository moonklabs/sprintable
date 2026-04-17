-- E-002:S2 — team_members: 사람+에이전트 통합 테이블 + RLS

-- ============================================================
-- 1. team_members
-- ============================================================
CREATE TABLE IF NOT EXISTS public.team_members (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id    uuid NOT NULL REFERENCES public.projects(id) ON DELETE CASCADE,
  org_id        uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  type          text NOT NULL CHECK (type IN ('human', 'agent')),
  user_id       uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  name          text NOT NULL,
  role          text NOT NULL DEFAULT 'member',
  avatar_url    text,
  agent_config  jsonb,
  webhook_url   text,
  is_active     boolean NOT NULL DEFAULT true,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),

  -- type=human이면 user_id 필수, type=agent이면 agent_config 필수
  CONSTRAINT chk_human_has_user_id
    CHECK (type != 'human' OR user_id IS NOT NULL),
  CONSTRAINT chk_agent_has_config
    CHECK (type != 'agent' OR agent_config IS NOT NULL)
);

COMMENT ON TABLE public.team_members IS '팀 멤버 (사람 + 에이전트 통합)';

CREATE INDEX idx_team_members_project_id ON public.team_members(project_id);
CREATE INDEX idx_team_members_org_id ON public.team_members(org_id);
CREATE INDEX idx_team_members_user_id ON public.team_members(user_id) WHERE user_id IS NOT NULL;

-- ============================================================
-- 2. RLS — org_id 기반 격리 (helper function 사용)
-- ============================================================
ALTER TABLE public.team_members ENABLE ROW LEVEL SECURITY;

CREATE POLICY "team_members_select_own_org"
  ON public.team_members FOR SELECT
  USING (org_id IN (SELECT public.get_user_org_ids()));

CREATE POLICY "team_members_insert_admin"
  ON public.team_members FOR INSERT
  WITH CHECK (org_id IN (SELECT public.get_user_admin_org_ids()));

CREATE POLICY "team_members_update_admin"
  ON public.team_members FOR UPDATE
  USING (org_id IN (SELECT public.get_user_admin_org_ids()));

CREATE POLICY "team_members_delete_admin"
  ON public.team_members FOR DELETE
  USING (org_id IN (SELECT public.get_user_admin_org_ids()));

-- ============================================================
-- 3. updated_at 자동 갱신 트리거
-- ============================================================
CREATE TRIGGER trg_team_members_updated_at
  BEFORE UPDATE ON public.team_members
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at();
