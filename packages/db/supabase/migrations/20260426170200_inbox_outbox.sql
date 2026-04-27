-- Operator Cockpit Phase A — inbox_outbox for webhook delivery (D6 권장 채택)
-- resolve API는 outbox row insert 후 즉시 200 반환, 별도 worker가 retry exponential backoff.
-- 이 outbox 패턴은 outbox pattern (DB write + async delivery 둘을 atomic하게 보장하기 위한 표준 패턴).
-- See .omc/plans/2026-04-26-01-operator-cockpit-redesign.md — D6 webhook outbox 정책

-- ============================================================
-- inbox_outbox — agent webhook 전달 큐
-- ============================================================
CREATE TABLE IF NOT EXISTS public.inbox_outbox (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id          uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  inbox_item_id   uuid NOT NULL REFERENCES public.inbox_items(id) ON DELETE CASCADE,
  event_type      text NOT NULL CHECK (event_type IN ('resolved', 'dismissed', 'reassigned')),
  payload         jsonb NOT NULL,
    -- {item: {...}, choice, note?, resolved_by, ts}
  webhook_url     text,
    -- agent별 webhook URL. NULL이면 worker가 agent 설정에서 lookup.
  status          text NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'in_flight', 'delivered', 'failed', 'dead')),
  attempt_count   integer NOT NULL DEFAULT 0,
  last_attempt_at timestamptz,
  next_attempt_at timestamptz NOT NULL DEFAULT now(),
    -- exponential backoff: now → now+30s → now+5m → now+30m → now+3h → dead
  last_error      text,
  delivered_at    timestamptz,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE public.inbox_outbox IS 'Outbox pattern for agent webhook delivery. Worker polls status=pending AND next_attempt_at<=now().';

-- ============================================================
-- Indexes
-- ============================================================
CREATE INDEX idx_inbox_outbox_org_id          ON public.inbox_outbox(org_id);
CREATE INDEX idx_inbox_outbox_inbox_item_id   ON public.inbox_outbox(inbox_item_id);
CREATE INDEX idx_inbox_outbox_pending_due     ON public.inbox_outbox(next_attempt_at)
  WHERE status = 'pending' OR status = 'in_flight';
CREATE INDEX idx_inbox_outbox_status          ON public.inbox_outbox(status);

-- ============================================================
-- updated_at 자동 갱신 트리거
-- ============================================================
CREATE OR REPLACE FUNCTION public.touch_inbox_outbox_updated_at()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$;

CREATE TRIGGER trg_inbox_outbox_touch_updated_at
  BEFORE UPDATE ON public.inbox_outbox
  FOR EACH ROW EXECUTE FUNCTION public.touch_inbox_outbox_updated_at();

-- ============================================================
-- RLS — service_role only. 일반 사용자는 outbox에 접근 불가.
-- ============================================================
ALTER TABLE public.inbox_outbox ENABLE ROW LEVEL SECURITY;

-- admin SELECT for debugging/audit
CREATE POLICY "inbox_outbox_select_admin" ON public.inbox_outbox FOR SELECT
  USING (org_id IN (SELECT public.get_user_admin_org_ids()));

-- writes only via service_role (bypasses RLS by default)
-- 일반 사용자 INSERT/UPDATE/DELETE 정책 없음 = denied.
