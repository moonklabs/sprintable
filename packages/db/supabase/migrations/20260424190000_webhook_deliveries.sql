-- webhook_deliveries: 아웃바운드 웹훅 발송 이력 + 재시도 추적
CREATE TABLE IF NOT EXISTS public.webhook_deliveries (
  id                uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id            uuid        NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  webhook_config_id uuid        REFERENCES public.webhook_configs(id) ON DELETE SET NULL,
  event_type        text        NOT NULL,
  payload           jsonb       NOT NULL DEFAULT '{}',
  status            text        NOT NULL DEFAULT 'pending'
                                CHECK (status IN ('pending', 'success', 'failed')),
  attempts          integer     NOT NULL DEFAULT 0,
  last_error        text,
  created_at        timestamptz NOT NULL DEFAULT now(),
  delivered_at      timestamptz
);

COMMENT ON TABLE public.webhook_deliveries IS '아웃바운드 웹훅 발송 이력';

CREATE INDEX idx_webhook_deliveries_org_id        ON public.webhook_deliveries(org_id);
CREATE INDEX idx_webhook_deliveries_config_id     ON public.webhook_deliveries(webhook_config_id) WHERE webhook_config_id IS NOT NULL;
CREATE INDEX idx_webhook_deliveries_status        ON public.webhook_deliveries(status) WHERE status != 'success';

-- RLS: 같은 org의 admin(owner/admin)만 조회 가능
ALTER TABLE public.webhook_deliveries ENABLE ROW LEVEL SECURITY;

CREATE POLICY "webhook_deliveries_select_admin"
  ON public.webhook_deliveries FOR SELECT
  USING (org_id IN (SELECT public.get_user_admin_org_ids()));
