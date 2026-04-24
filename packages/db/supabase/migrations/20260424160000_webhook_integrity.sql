-- E-PLATFORM-FOUNDATION S10 — 웹훅 정합성

-- 1. notification_settings.channel 'web' → 'in_app' 마이그레이션
--    (Settings UI가 'web' 대신 'in_app'을 사용하도록 수정됨에 따른 기존 row 정리)
UPDATE public.notification_settings
   SET channel = 'in_app'
 WHERE channel = 'web';

-- 2. channel CHECK 제약 재정의 (in_app, email, webhook, slack, discord — 'web' 제거)
ALTER TABLE public.notification_settings
  DROP CONSTRAINT IF EXISTS notification_settings_channel_check;

ALTER TABLE public.notification_settings
  ADD CONSTRAINT notification_settings_channel_check
    CHECK (channel IN ('in_app', 'email', 'webhook', 'slack', 'discord'));
