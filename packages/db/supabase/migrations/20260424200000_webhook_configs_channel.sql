-- webhook_configs: channel 컬럼 추가 (URL heuristic 제거용)
ALTER TABLE public.webhook_configs
  ADD COLUMN IF NOT EXISTS channel text NOT NULL DEFAULT 'generic'
    CHECK (channel IN ('discord', 'slack', 'google', 'generic'));

-- 기존 레코드 channel 값 마이그레이션 (URL 패턴 기반)
UPDATE public.webhook_configs
  SET channel = CASE
    WHEN url ILIKE '%discord.com%' OR url ILIKE '%discordapp.com%' THEN 'discord'
    WHEN url ILIKE '%hooks.slack.com%'                             THEN 'slack'
    WHEN url ILIKE '%chat.googleapis.com%'                         THEN 'google'
    ELSE 'generic'
  END;
