-- S460 [E-027:S4] Slack OAuth token storage for messaging bridge tools
CREATE TABLE IF NOT EXISTS public.messaging_bridge_org_auths (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id           uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  platform         text NOT NULL
                    CHECK (platform IN ('slack', 'discord', 'teams', 'telegram')),
  access_token_ref text NOT NULL
                    CHECK (access_token_ref ~ '^(env|vault):[^[:space:]]+$'),
  expires_at       timestamptz,
  created_by       uuid REFERENCES public.team_members(id) ON DELETE SET NULL,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now(),

  UNIQUE (org_id, platform)
);

COMMENT ON TABLE public.messaging_bridge_org_auths IS '조직 단위 메시징 브릿지 OAuth 토큰 참조';
COMMENT ON COLUMN public.messaging_bridge_org_auths.access_token_ref IS '실제 토큰이 아닌 env:/vault: 참조만 저장';
COMMENT ON COLUMN public.messaging_bridge_org_auths.expires_at IS 'OAuth access token 만료 시각';

CREATE INDEX IF NOT EXISTS idx_bridge_org_auths_org_platform
  ON public.messaging_bridge_org_auths(org_id, platform);

ALTER TABLE public.messaging_bridge_org_auths ENABLE ROW LEVEL SECURITY;

CREATE POLICY "bridge_org_auths_select" ON public.messaging_bridge_org_auths FOR SELECT
  USING (org_id IN (SELECT public.get_user_org_ids()));

CREATE POLICY "bridge_org_auths_insert" ON public.messaging_bridge_org_auths FOR INSERT
  WITH CHECK (org_id IN (SELECT public.get_user_admin_org_ids()));

CREATE POLICY "bridge_org_auths_update" ON public.messaging_bridge_org_auths FOR UPDATE
  USING (org_id IN (SELECT public.get_user_admin_org_ids()))
  WITH CHECK (org_id IN (SELECT public.get_user_admin_org_ids()));

CREATE POLICY "bridge_org_auths_delete" ON public.messaging_bridge_org_auths FOR DELETE
  USING (org_id IN (SELECT public.get_user_admin_org_ids()));
