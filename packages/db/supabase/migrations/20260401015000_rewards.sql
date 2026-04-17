-- 015: Rewards Ledger

-- 1. reward_ledger — 보상 원장
CREATE TABLE IF NOT EXISTS public.reward_ledger (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id      uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  project_id  uuid NOT NULL REFERENCES public.projects(id) ON DELETE CASCADE,
  member_id   uuid NOT NULL REFERENCES public.team_members(id) ON DELETE CASCADE,
  amount      numeric(12,2) NOT NULL,
  currency    text NOT NULL DEFAULT 'TJSB',
  reason      text NOT NULL,
  reference_type text,
  reference_id uuid,
  granted_by  uuid REFERENCES public.team_members(id) ON DELETE SET NULL,
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX idx_reward_ledger_org ON public.reward_ledger(org_id);
CREATE INDEX idx_reward_ledger_member ON public.reward_ledger(member_id);
CREATE INDEX idx_reward_ledger_project ON public.reward_ledger(project_id);

-- RLS
ALTER TABLE public.reward_ledger ENABLE ROW LEVEL SECURITY;

CREATE POLICY "rewards_select" ON public.reward_ledger FOR SELECT
  USING (org_id IN (SELECT public.get_user_org_ids()));

CREATE POLICY "rewards_insert" ON public.reward_ledger FOR INSERT
  WITH CHECK (org_id IN (SELECT public.get_user_admin_org_ids()));

COMMENT ON TABLE public.reward_ledger IS '리워드 원장 — 포상/벌금 기록';
