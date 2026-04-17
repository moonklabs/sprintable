-- SID:390 — persisted llm_config for project-level LLM routing

ALTER TABLE public.project_ai_settings
  ADD COLUMN IF NOT EXISTS llm_config jsonb NOT NULL DEFAULT '{}'::jsonb;

ALTER TABLE public.project_ai_settings
  DROP CONSTRAINT IF EXISTS project_ai_settings_llm_config_is_object;

ALTER TABLE public.project_ai_settings
  ADD CONSTRAINT project_ai_settings_llm_config_is_object
  CHECK (jsonb_typeof(llm_config) = 'object');

UPDATE public.project_ai_settings
SET llm_config = jsonb_strip_nulls(jsonb_build_object(
  'model', CASE
    WHEN provider = 'anthropic' THEN 'claude-sonnet-4'
    ELSE 'gpt-4o-mini'
  END,
  'timeoutMs', 30000,
  'maxRetries', 3
))
WHERE llm_config = '{}'::jsonb;
