-- E-SEC-HARDENING:S2 — agent_api_keys expires_at 만료 정책
-- 정책(§8 보안 현황, §13 P0-3) 구현

ALTER TABLE public.agent_api_keys
  ADD COLUMN IF NOT EXISTS expires_at timestamptz;

COMMENT ON COLUMN public.agent_api_keys.expires_at IS '키 만료 시각 (NULL=무기한, 기본 발급 90일)';
