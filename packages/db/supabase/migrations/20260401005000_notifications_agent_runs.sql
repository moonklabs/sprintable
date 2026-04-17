-- E-002:S5 — 보조 테이블: notifications + agent_runs + RLS

-- ============================================================
-- 1. notifications
-- ============================================================
CREATE TABLE IF NOT EXISTS public.notifications (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id          uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  user_id         uuid NOT NULL REFERENCES public.team_members(id) ON DELETE CASCADE,
  type            text NOT NULL DEFAULT 'info',
  title           text NOT NULL,
  body            text,
  is_read         boolean NOT NULL DEFAULT false,
  reference_type  text,
  reference_id    uuid,
  created_at      timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE public.notifications IS '알림';

CREATE INDEX idx_notifications_org_id ON public.notifications(org_id);
CREATE INDEX idx_notifications_user_id ON public.notifications(user_id);
CREATE INDEX idx_notifications_is_read ON public.notifications(is_read) WHERE is_read = false;

-- ============================================================
-- 2. agent_runs
-- ============================================================
CREATE TABLE IF NOT EXISTS public.agent_runs (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id          uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  agent_id        uuid NOT NULL REFERENCES public.team_members(id) ON DELETE CASCADE,
  story_id        uuid REFERENCES public.stories(id) ON DELETE SET NULL,
  memo_id         uuid REFERENCES public.memos(id) ON DELETE SET NULL,
  trigger         text NOT NULL DEFAULT 'manual',
  model           text,
  input_tokens    integer,
  output_tokens   integer,
  cost_usd        numeric(10, 6),
  status          text NOT NULL DEFAULT 'running' CHECK (status IN ('running', 'completed', 'failed')),
  result_summary  text,
  duration_ms     integer,
  created_at      timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE public.agent_runs IS '에이전트 실행 로그';

CREATE INDEX idx_agent_runs_org_id ON public.agent_runs(org_id);
CREATE INDEX idx_agent_runs_agent_id ON public.agent_runs(agent_id);
CREATE INDEX idx_agent_runs_story_id ON public.agent_runs(story_id) WHERE story_id IS NOT NULL;
CREATE INDEX idx_agent_runs_memo_id ON public.agent_runs(memo_id) WHERE memo_id IS NOT NULL;
CREATE INDEX idx_agent_runs_status ON public.agent_runs(status);

-- ============================================================
-- 3. agent_id 검증 트리거 (type=agent인 team_member만 허용)
-- ============================================================
CREATE OR REPLACE FUNCTION public.validate_agent_run_agent_id()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
DECLARE
  _type text;
BEGIN
  SELECT type INTO _type FROM public.team_members WHERE id = NEW.agent_id;
  IF _type IS NULL OR _type != 'agent' THEN
    RAISE EXCEPTION 'agent_runs.agent_id must reference a team_member with type=agent';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER trg_agent_runs_validate_agent
  BEFORE INSERT OR UPDATE ON public.agent_runs
  FOR EACH ROW EXECUTE FUNCTION public.validate_agent_run_agent_id();

-- ============================================================
-- 4. RLS — org_id 기반 격리
-- ============================================================

-- notifications: 본인 알림만 조회, org admin만 생성 + user_id 같은 org 검증
ALTER TABLE public.notifications ENABLE ROW LEVEL SECURITY;

CREATE POLICY "notifications_select_own" ON public.notifications FOR SELECT
  USING (
    org_id IN (SELECT public.get_user_org_ids())
    AND user_id IN (
      SELECT id FROM public.team_members
      WHERE user_id = auth.uid()
    )
  );
CREATE POLICY "notifications_update_own" ON public.notifications FOR UPDATE
  USING (
    user_id IN (
      SELECT id FROM public.team_members
      WHERE user_id = auth.uid()
    )
  );
CREATE POLICY "notifications_insert" ON public.notifications FOR INSERT
  WITH CHECK (
    org_id IN (SELECT public.get_user_admin_org_ids())
    AND EXISTS (
      SELECT 1 FROM public.team_members tm
      WHERE tm.id = user_id AND tm.org_id = org_id
    )
  );
CREATE POLICY "notifications_delete" ON public.notifications FOR DELETE
  USING (org_id IN (SELECT public.get_user_admin_org_ids()));

-- agent_runs: org 멤버 조회 가능, 생성은 service_role (에이전트)
ALTER TABLE public.agent_runs ENABLE ROW LEVEL SECURITY;

CREATE POLICY "agent_runs_select" ON public.agent_runs FOR SELECT
  USING (org_id IN (SELECT public.get_user_org_ids()));
CREATE POLICY "agent_runs_insert" ON public.agent_runs FOR INSERT
  WITH CHECK (org_id IN (SELECT public.get_user_admin_org_ids()));
CREATE POLICY "agent_runs_delete" ON public.agent_runs FOR DELETE
  USING (org_id IN (SELECT public.get_user_admin_org_ids()));
