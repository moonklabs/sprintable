-- SID:467 — encrypted BYOM storage with KMS-backed envelopes

ALTER TABLE public.project_ai_settings
  ALTER COLUMN api_key DROP NOT NULL;

ALTER TABLE public.org_integrations
  ADD COLUMN IF NOT EXISTS encrypted_secret text,
  ADD COLUMN IF NOT EXISTS kms_provider text NOT NULL DEFAULT 'local'
    CHECK (kms_provider IN ('local', 'gcp', 'vault'));

CREATE INDEX IF NOT EXISTS idx_org_integrations_project_type
  ON public.org_integrations(project_id, integration_type);
