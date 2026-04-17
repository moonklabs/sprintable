-- E-023:S8-2 — Hot query 인덱스 정합화

-- Memo dispatcher polling cursor:
--   status = 'open'
--   assigned_to IS NOT NULL
--   ORDER BY updated_at, id
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_memos_open_assigned_updated_cursor
  ON public.memos(updated_at, id)
  WHERE status = 'open' AND assigned_to IS NOT NULL;

-- Discord outbound reply polling cursor:
--   ORDER BY created_at, id
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_memo_replies_created_cursor
  ON public.memo_replies(created_at, id);

-- HITL reminder/timeout scan indexes are added with concurrent-safe apply.
-- Existing broad indexes are intentionally kept in place for this rollout and can be
-- cleaned up in a later low-traffic migration after verifying planner usage in production.

-- HITL reminder scan:
--   status = 'pending'
--   reminder_sent_at IS NULL
--   expires_at BETWEEN now() AND deadline
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_agent_hitl_requests_pending_reminder_v2
  ON public.agent_hitl_requests(expires_at)
  WHERE status = 'pending'
    AND reminder_sent_at IS NULL
    AND expires_at IS NOT NULL;

-- HITL timeout scan:
--   status = 'pending'
--   expired_at IS NULL
--   expires_at <= now()
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_agent_hitl_requests_pending_timeout_v2
  ON public.agent_hitl_requests(expires_at)
  WHERE status = 'pending'
    AND expired_at IS NULL
    AND expires_at IS NOT NULL;
