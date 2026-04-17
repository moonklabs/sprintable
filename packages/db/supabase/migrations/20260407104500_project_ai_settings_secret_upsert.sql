-- SID:467 follow-up — atomic project_ai_settings + org_integrations secret upsert

CREATE OR REPLACE FUNCTION public.upsert_project_ai_settings_with_secret(
  p_org_id uuid,
  p_project_id uuid,
  p_provider text,
  p_llm_config jsonb,
  p_encrypted_secret text,
  p_secret_last4 text,
  p_kms_provider text,
  p_updated_at timestamptz
)
RETURNS TABLE (
  id uuid,
  provider text,
  llm_config jsonb,
  created_at timestamptz,
  updated_at timestamptz
)
LANGUAGE plpgsql
AS $$
BEGIN
  INSERT INTO public.project_ai_settings (
    org_id,
    project_id,
    provider,
    api_key,
    llm_config,
    updated_at
  )
  VALUES (
    p_org_id,
    p_project_id,
    p_provider,
    NULL,
    COALESCE(p_llm_config, '{}'::jsonb),
    p_updated_at
  )
  ON CONFLICT (project_id) DO UPDATE SET
    org_id = EXCLUDED.org_id,
    provider = EXCLUDED.provider,
    api_key = NULL,
    llm_config = EXCLUDED.llm_config,
    updated_at = EXCLUDED.updated_at;

  INSERT INTO public.org_integrations (
    org_id,
    project_id,
    integration_type,
    provider,
    secret_last4,
    encrypted_secret,
    kms_provider,
    kms_status,
    rotation_requested_at,
    updated_at
  )
  VALUES (
    p_org_id,
    p_project_id,
    'byom_api_key',
    p_provider,
    p_secret_last4,
    p_encrypted_secret,
    p_kms_provider,
    'active',
    NULL,
    p_updated_at
  )
  ON CONFLICT (project_id, integration_type) DO UPDATE SET
    org_id = EXCLUDED.org_id,
    provider = EXCLUDED.provider,
    secret_last4 = EXCLUDED.secret_last4,
    encrypted_secret = EXCLUDED.encrypted_secret,
    kms_provider = EXCLUDED.kms_provider,
    kms_status = 'active',
    rotation_requested_at = NULL,
    updated_at = EXCLUDED.updated_at;

  RETURN QUERY
  SELECT s.id, s.provider, s.llm_config, s.created_at, s.updated_at
  FROM public.project_ai_settings s
  WHERE s.project_id = p_project_id;
END;
$$;
