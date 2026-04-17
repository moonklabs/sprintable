-- SID:523 — routing rule action config

ALTER TABLE public.agent_routing_rules
  ADD COLUMN IF NOT EXISTS action jsonb NOT NULL DEFAULT '{"auto_reply_mode":"process_and_report"}'::jsonb;

UPDATE public.agent_routing_rules
SET action = '{"auto_reply_mode":"process_and_report"}'::jsonb
WHERE action = '{}'::jsonb;

COMMENT ON COLUMN public.agent_routing_rules.action IS '라우팅 후처리 액션 (process_and_forward / process_and_report)';
