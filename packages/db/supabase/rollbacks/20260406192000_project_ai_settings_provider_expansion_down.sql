-- S446 rollback — restore project_ai_settings provider constraint

ALTER TABLE public.project_ai_settings
  DROP CONSTRAINT IF EXISTS project_ai_settings_provider_check;

ALTER TABLE public.project_ai_settings
  ADD CONSTRAINT project_ai_settings_provider_check
  CHECK (provider IN ('openai', 'anthropic'));
