-- S458 [E-027:S2] memos.metadata — Slack 브릿지 등 외부 소스 메타데이터 저장용
ALTER TABLE public.memos
  ADD COLUMN IF NOT EXISTS metadata jsonb NOT NULL DEFAULT '{}'::jsonb;

COMMENT ON COLUMN public.memos.metadata IS '외부 소스 메타데이터 (source, channel_id, thread_ts, slack_ts, team_id 등)';
