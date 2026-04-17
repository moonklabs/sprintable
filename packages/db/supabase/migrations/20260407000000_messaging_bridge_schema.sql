-- S457 [E-027:S1] 메시징 브릿지 DB 스키마
-- messaging_bridge_channels + messaging_bridge_users 테이블 생성

CREATE OR REPLACE FUNCTION public.messaging_bridge_config_uses_secret_refs(_config jsonb)
RETURNS boolean
LANGUAGE plpgsql
IMMUTABLE
AS $$
DECLARE
  _entry record;
  _ref text;
BEGIN
  IF _config IS NULL OR jsonb_typeof(_config) <> 'object' THEN
    RETURN false;
  END IF;

  FOR _entry IN SELECT key, value FROM jsonb_each(_config)
  LOOP
    IF jsonb_typeof(_entry.value) <> 'string' THEN
      RETURN false;
    END IF;

    _ref := trim(both '"' from _entry.value::text);
    IF _ref !~ '^(env|vault):[^[:space:]]+$' THEN
      RETURN false;
    END IF;
  END LOOP;

  RETURN true;
END;
$$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'uq_projects_id_org'
  ) THEN
    ALTER TABLE public.projects
      ADD CONSTRAINT uq_projects_id_org UNIQUE (id, org_id);
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'uq_team_members_id_org'
  ) THEN
    ALTER TABLE public.team_members
      ADD CONSTRAINT uq_team_members_id_org UNIQUE (id, org_id);
  END IF;
END $$;

-- ============================================================
-- 1. messaging_bridge_channels
-- ============================================================
CREATE TABLE IF NOT EXISTS public.messaging_bridge_channels (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id          uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  project_id      uuid NOT NULL,
  platform        text NOT NULL
                    CHECK (platform IN ('slack', 'discord', 'teams', 'telegram')),
  channel_id      text NOT NULL,
  channel_name    text,
  config          jsonb NOT NULL DEFAULT '{}'::jsonb,
  is_active       boolean NOT NULL DEFAULT true,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT chk_messaging_bridge_channels_config_secret_refs
    CHECK (public.messaging_bridge_config_uses_secret_refs(config)),
  CONSTRAINT fk_messaging_bridge_channels_project_scope
    FOREIGN KEY (project_id, org_id)
    REFERENCES public.projects(id, org_id)
    ON DELETE CASCADE,

  UNIQUE (platform, channel_id)
);

COMMENT ON TABLE  public.messaging_bridge_channels IS '메시징 브릿지 채널 매핑';
COMMENT ON COLUMN public.messaging_bridge_channels.platform   IS '메시징 플랫폼 (slack, discord, teams, telegram)';
COMMENT ON COLUMN public.messaging_bridge_channels.channel_id IS '플랫폼 고유 채널 식별자';
COMMENT ON COLUMN public.messaging_bridge_channels.config     IS '채널별 설정 — 모든 값은 env:/vault: 시크릿 참조만 허용';

CREATE INDEX IF NOT EXISTS idx_bridge_channels_org_project
  ON public.messaging_bridge_channels(org_id, project_id);
CREATE INDEX IF NOT EXISTS idx_bridge_channels_platform
  ON public.messaging_bridge_channels(platform, is_active)
  WHERE is_active = true;

-- RLS
ALTER TABLE public.messaging_bridge_channels ENABLE ROW LEVEL SECURITY;

CREATE POLICY "bridge_channels_select" ON public.messaging_bridge_channels FOR SELECT
  USING (org_id IN (SELECT public.get_user_org_ids()));

CREATE POLICY "bridge_channels_insert" ON public.messaging_bridge_channels FOR INSERT
  WITH CHECK (org_id IN (SELECT public.get_user_admin_org_ids()));

CREATE POLICY "bridge_channels_update" ON public.messaging_bridge_channels FOR UPDATE
  USING (org_id IN (SELECT public.get_user_admin_org_ids()))
  WITH CHECK (org_id IN (SELECT public.get_user_admin_org_ids()));

CREATE POLICY "bridge_channels_delete" ON public.messaging_bridge_channels FOR DELETE
  USING (org_id IN (SELECT public.get_user_admin_org_ids()));

-- ============================================================
-- 2. messaging_bridge_users
-- ============================================================
CREATE TABLE IF NOT EXISTS public.messaging_bridge_users (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id           uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  team_member_id   uuid NOT NULL,
  platform         text NOT NULL
                     CHECK (platform IN ('slack', 'discord', 'teams', 'telegram')),
  platform_user_id text NOT NULL,
  display_name     text,
  is_active        boolean NOT NULL DEFAULT true,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT fk_messaging_bridge_users_team_member_scope
    FOREIGN KEY (team_member_id, org_id)
    REFERENCES public.team_members(id, org_id)
    ON DELETE CASCADE,

  UNIQUE (platform, platform_user_id)
);

COMMENT ON TABLE  public.messaging_bridge_users IS '메시징 브릿지 사용자 매핑';
COMMENT ON COLUMN public.messaging_bridge_users.platform         IS '메시징 플랫폼';
COMMENT ON COLUMN public.messaging_bridge_users.platform_user_id IS '플랫폼 고유 사용자 식별자';

CREATE INDEX IF NOT EXISTS idx_bridge_users_org
  ON public.messaging_bridge_users(org_id);
CREATE INDEX IF NOT EXISTS idx_bridge_users_team_member
  ON public.messaging_bridge_users(team_member_id);
CREATE INDEX IF NOT EXISTS idx_bridge_users_platform_lookup
  ON public.messaging_bridge_users(platform, platform_user_id)
  WHERE is_active = true;

-- RLS
ALTER TABLE public.messaging_bridge_users ENABLE ROW LEVEL SECURITY;

CREATE POLICY "bridge_users_select" ON public.messaging_bridge_users FOR SELECT
  USING (org_id IN (SELECT public.get_user_org_ids()));

CREATE POLICY "bridge_users_insert" ON public.messaging_bridge_users FOR INSERT
  WITH CHECK (org_id IN (SELECT public.get_user_admin_org_ids()));

CREATE POLICY "bridge_users_update" ON public.messaging_bridge_users FOR UPDATE
  USING (org_id IN (SELECT public.get_user_admin_org_ids()))
  WITH CHECK (org_id IN (SELECT public.get_user_admin_org_ids()));

CREATE POLICY "bridge_users_delete" ON public.messaging_bridge_users FOR DELETE
  USING (org_id IN (SELECT public.get_user_admin_org_ids()));
