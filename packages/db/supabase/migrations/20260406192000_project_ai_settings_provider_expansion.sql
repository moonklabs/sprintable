-- S446 — expand project_ai_settings provider support for LLM abstraction layer

ALTER TABLE public.project_ai_settings
  DROP CONSTRAINT IF EXISTS project_ai_settings_provider_check;

ALTER TABLE public.project_ai_settings
  ADD CONSTRAINT project_ai_settings_provider_check
  CHECK (provider IN ('openai', 'anthropic', 'google', 'groq', 'openai-compatible'));
