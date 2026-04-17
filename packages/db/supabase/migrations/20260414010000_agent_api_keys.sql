-- E-024:S6 — agent_api_keys: 에이전트 API Key 인증
-- 정책(§14.3 BYOA 인증) 구현

-- ============================================================
-- 1. agent_api_keys
-- ============================================================
CREATE TABLE IF NOT EXISTS public.agent_api_keys (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  team_member_id  uuid NOT NULL REFERENCES public.team_members(id) ON DELETE CASCADE,
  key_prefix      text NOT NULL,  -- 로그/UI 표시용 (예: "sk_live_abcd")
  key_hash        text NOT NULL,  -- SHA-256 해시
  created_at      timestamptz NOT NULL DEFAULT now(),
  revoked_at      timestamptz,
  last_used_at    timestamptz,

  -- type=agent인 team_member만 API Key 발급 가능
  CONSTRAINT chk_api_key_for_agent_only
    CHECK (
      EXISTS (
        SELECT 1 FROM public.team_members tm
        WHERE tm.id = team_member_id AND tm.type = 'agent'
      )
    )
);

COMMENT ON TABLE public.agent_api_keys IS '에이전트 API Key (§14.3 BYOA 인증)';
COMMENT ON COLUMN public.agent_api_keys.key_prefix IS '키 앞 12자 (로그/UI 표시용, 평문)';
COMMENT ON COLUMN public.agent_api_keys.key_hash IS 'SHA-256 해시값';

CREATE INDEX idx_agent_api_keys_team_member_id ON public.agent_api_keys(team_member_id);
CREATE INDEX idx_agent_api_keys_key_hash ON public.agent_api_keys(key_hash) WHERE revoked_at IS NULL;

-- ============================================================
-- 2. RLS — admin만 발급/revoke 가능
-- ============================================================
ALTER TABLE public.agent_api_keys ENABLE ROW LEVEL SECURITY;

-- SELECT: 본인 org의 키 목록 조회 가능 (admin만)
CREATE POLICY "agent_api_keys_select_admin"
  ON public.agent_api_keys FOR SELECT
  USING (
    EXISTS (
      SELECT 1 FROM public.team_members tm
      WHERE tm.id = team_member_id
        AND tm.org_id IN (SELECT public.get_user_admin_org_ids())
    )
  );

-- INSERT: admin만 발급 가능
CREATE POLICY "agent_api_keys_insert_admin"
  ON public.agent_api_keys FOR INSERT
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM public.team_members tm
      WHERE tm.id = team_member_id
        AND tm.org_id IN (SELECT public.get_user_admin_org_ids())
    )
  );

-- UPDATE: admin만 revoke (revoked_at, last_used_at 업데이트) 가능
CREATE POLICY "agent_api_keys_update_admin"
  ON public.agent_api_keys FOR UPDATE
  USING (
    EXISTS (
      SELECT 1 FROM public.team_members tm
      WHERE tm.id = team_member_id
        AND tm.org_id IN (SELECT public.get_user_admin_org_ids())
    )
  );
