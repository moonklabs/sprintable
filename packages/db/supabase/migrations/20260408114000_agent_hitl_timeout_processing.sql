-- SID:530 — HITL timeout scanner + reminder claim columns

ALTER TABLE public.agent_hitl_requests
  ADD COLUMN IF NOT EXISTS reminder_sent_at timestamptz,
  ADD COLUMN IF NOT EXISTS expired_at timestamptz;

COMMENT ON COLUMN public.agent_hitl_requests.reminder_sent_at IS '1시간 전 알림 발송 시각';
COMMENT ON COLUMN public.agent_hitl_requests.expired_at IS 'HITL timeout 자동 처리 시각';

CREATE INDEX IF NOT EXISTS idx_agent_hitl_requests_pending_reminder
  ON public.agent_hitl_requests(status, reminder_sent_at, expires_at)
  WHERE deleted_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_agent_hitl_requests_pending_timeout
  ON public.agent_hitl_requests(status, expired_at, expires_at)
  WHERE deleted_at IS NULL;
