-- E-SEC-HARDENING:S3 — agent_api_keys scope 접근 범위 제한
-- 정책(§7, §13 P0-4) 구현

ALTER TABLE public.agent_api_keys
  ADD COLUMN IF NOT EXISTS scope text[] DEFAULT '{read,write}';

COMMENT ON COLUMN public.agent_api_keys.scope IS 'API Key 권한 범위 (read, write, admin). NULL=["read","write"] 하위호환';
