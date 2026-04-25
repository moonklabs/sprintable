-- E-PLATFORM-SECURE S6: api_key_logs 테이블 신설

CREATE TABLE IF NOT EXISTS public.api_key_logs (
  id           uuid        DEFAULT gen_random_uuid() PRIMARY KEY,
  api_key_id   uuid        NOT NULL REFERENCES public.agent_api_keys(id) ON DELETE CASCADE,
  org_id       uuid        NOT NULL,
  endpoint     text        NOT NULL,
  ip_address   text,
  status_code  int,
  created_at   timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_api_key_logs_key_id
  ON public.api_key_logs(api_key_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_api_key_logs_org_id
  ON public.api_key_logs(org_id, created_at DESC);

ALTER TABLE public.api_key_logs ENABLE ROW LEVEL SECURITY;

CREATE POLICY "api_key_logs_select_admin" ON public.api_key_logs FOR SELECT
  USING (org_id IN (
    SELECT DISTINCT org_id FROM public.team_members
    WHERE user_id = auth.uid() AND is_active = true
      AND role IN ('owner', 'admin')
  ));
