-- 016: Notification settings + webhook config

-- 1. notification_settings — 멤버별 알림 설정
CREATE TABLE IF NOT EXISTS public.notification_settings (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id      uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  member_id   uuid NOT NULL REFERENCES public.team_members(id) ON DELETE CASCADE,
  channel     text NOT NULL DEFAULT 'in_app' CHECK (channel IN ('in_app', 'email', 'webhook', 'slack', 'discord')),
  event_type  text NOT NULL,
  enabled     boolean NOT NULL DEFAULT true,
  UNIQUE (member_id, channel, event_type)
);

CREATE INDEX idx_notification_settings_member ON public.notification_settings(member_id);

-- 2. webhook_configs — 에이전트/멤버별 웹훅 설정
CREATE TABLE IF NOT EXISTS public.webhook_configs (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id      uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  member_id   uuid NOT NULL REFERENCES public.team_members(id) ON DELETE CASCADE,
  url         text NOT NULL,
  secret      text,
  events      text[] NOT NULL DEFAULT '{}',
  is_active   boolean NOT NULL DEFAULT true,
  created_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (member_id)
);

CREATE INDEX idx_webhook_configs_member ON public.webhook_configs(member_id);

-- RLS
ALTER TABLE public.notification_settings ENABLE ROW LEVEL SECURITY;
CREATE POLICY "notif_settings_select" ON public.notification_settings FOR SELECT
  USING (org_id IN (SELECT public.get_user_org_ids()));
CREATE POLICY "notif_settings_insert" ON public.notification_settings FOR INSERT
  WITH CHECK (org_id IN (SELECT public.get_user_org_ids()));
CREATE POLICY "notif_settings_update" ON public.notification_settings FOR UPDATE
  USING (org_id IN (SELECT public.get_user_org_ids()));
CREATE POLICY "notif_settings_delete" ON public.notification_settings FOR DELETE
  USING (org_id IN (SELECT public.get_user_org_ids()));

ALTER TABLE public.webhook_configs ENABLE ROW LEVEL SECURITY;
CREATE POLICY "webhook_configs_select" ON public.webhook_configs FOR SELECT
  USING (org_id IN (SELECT public.get_user_org_ids()));
CREATE POLICY "webhook_configs_insert" ON public.webhook_configs FOR INSERT
  WITH CHECK (org_id IN (SELECT public.get_user_admin_org_ids()));
CREATE POLICY "webhook_configs_update" ON public.webhook_configs FOR UPDATE
  USING (org_id IN (SELECT public.get_user_admin_org_ids()));

-- 시드: 기본 알림 이벤트 타입
-- story_assigned, story_status_changed, memo_assigned, memo_replied, sprint_started, sprint_closed
