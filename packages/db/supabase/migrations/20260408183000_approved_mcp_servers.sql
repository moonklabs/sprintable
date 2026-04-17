-- SID:426 — approved external MCP server connections

ALTER TABLE public.org_integrations
  DROP CONSTRAINT IF EXISTS org_integrations_provider_check;

ALTER TABLE public.org_integrations
  ADD CONSTRAINT org_integrations_provider_check
  CHECK (provider IN (
    'openai',
    'anthropic',
    'google',
    'groq',
    'openai-compatible',
    'github',
    'linear',
    'jira'
  ));

ALTER TABLE public.org_integrations
  ADD COLUMN IF NOT EXISTS config jsonb NOT NULL DEFAULT '{}'::jsonb,
  ADD COLUMN IF NOT EXISTS status text NOT NULL DEFAULT 'active'
    CHECK (status IN ('active', 'error', 'pending_oauth')),
  ADD COLUMN IF NOT EXISTS validated_at timestamptz,
  ADD COLUMN IF NOT EXISTS last_error text,
  ADD COLUMN IF NOT EXISTS tool_cache jsonb NOT NULL DEFAULT '[]'::jsonb,
  ADD COLUMN IF NOT EXISTS tool_cache_expires_at timestamptz;

ALTER TABLE public.org_integrations
  DROP CONSTRAINT IF EXISTS org_integrations_config_is_object;

ALTER TABLE public.org_integrations
  ADD CONSTRAINT org_integrations_config_is_object
  CHECK (jsonb_typeof(config) = 'object');

ALTER TABLE public.org_integrations
  DROP CONSTRAINT IF EXISTS org_integrations_tool_cache_is_array;

ALTER TABLE public.org_integrations
  ADD CONSTRAINT org_integrations_tool_cache_is_array
  CHECK (jsonb_typeof(tool_cache) = 'array');

CREATE TABLE IF NOT EXISTS public.approved_mcp_servers (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  server_key text NOT NULL UNIQUE,
  display_name text NOT NULL,
  provider text NOT NULL CHECK (provider IN ('github', 'linear', 'jira')),
  auth_strategy text NOT NULL CHECK (auth_strategy IN ('oauth', 'api_key', 'api_token')),
  gateway_url_env text NOT NULL,
  token_header_name text NOT NULL DEFAULT 'Authorization',
  token_scheme text NOT NULL DEFAULT 'bearer' CHECK (token_scheme IN ('bearer', 'plain')),
  oauth_authorize_url text,
  oauth_token_url text,
  oauth_client_id_env text,
  oauth_client_secret_env text,
  oauth_redirect_uri_env text,
  oauth_scopes text[] NOT NULL DEFAULT '{}'::text[],
  tool_cache_ttl_seconds integer NOT NULL DEFAULT 3600 CHECK (tool_cache_ttl_seconds > 0),
  is_active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_approved_mcp_servers_active
  ON public.approved_mcp_servers(is_active, provider);

INSERT INTO public.approved_mcp_servers (
  server_key,
  display_name,
  provider,
  auth_strategy,
  gateway_url_env,
  token_header_name,
  token_scheme,
  oauth_authorize_url,
  oauth_token_url,
  oauth_client_id_env,
  oauth_client_secret_env,
  oauth_redirect_uri_env,
  oauth_scopes,
  tool_cache_ttl_seconds,
  is_active
)
VALUES
  (
    'github',
    'GitHub',
    'github',
    'oauth',
    'GITHUB_MCP_GATEWAY_URL',
    'X-GitHub-Token',
    'plain',
    'https://github.com/login/oauth/authorize',
    'https://github.com/login/oauth/access_token',
    'GITHUB_MCP_CLIENT_ID',
    'GITHUB_MCP_CLIENT_SECRET',
    'GITHUB_MCP_REDIRECT_URI',
    ARRAY['repo', 'read:org'],
    3600,
    true
  ),
  (
    'linear',
    'Linear',
    'linear',
    'api_key',
    'LINEAR_MCP_GATEWAY_URL',
    'Authorization',
    'bearer',
    NULL,
    NULL,
    NULL,
    NULL,
    NULL,
    ARRAY[]::text[],
    3600,
    true
  ),
  (
    'jira',
    'Jira',
    'jira',
    'api_token',
    'JIRA_MCP_GATEWAY_URL',
    'Authorization',
    'bearer',
    NULL,
    NULL,
    NULL,
    NULL,
    NULL,
    ARRAY[]::text[],
    3600,
    true
  )
ON CONFLICT (server_key) DO UPDATE SET
  display_name = EXCLUDED.display_name,
  provider = EXCLUDED.provider,
  auth_strategy = EXCLUDED.auth_strategy,
  gateway_url_env = EXCLUDED.gateway_url_env,
  token_header_name = EXCLUDED.token_header_name,
  token_scheme = EXCLUDED.token_scheme,
  oauth_authorize_url = EXCLUDED.oauth_authorize_url,
  oauth_token_url = EXCLUDED.oauth_token_url,
  oauth_client_id_env = EXCLUDED.oauth_client_id_env,
  oauth_client_secret_env = EXCLUDED.oauth_client_secret_env,
  oauth_redirect_uri_env = EXCLUDED.oauth_redirect_uri_env,
  oauth_scopes = EXCLUDED.oauth_scopes,
  tool_cache_ttl_seconds = EXCLUDED.tool_cache_ttl_seconds,
  is_active = EXCLUDED.is_active,
  updated_at = now();

CREATE TABLE IF NOT EXISTS public.mcp_connection_requests (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  project_id uuid NOT NULL REFERENCES public.projects(id) ON DELETE CASCADE,
  requested_by uuid NOT NULL REFERENCES public.team_members(id) ON DELETE CASCADE,
  server_name text NOT NULL,
  server_url text NOT NULL,
  notes text,
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'rejected')),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_mcp_connection_requests_project
  ON public.mcp_connection_requests(org_id, project_id, status, created_at DESC);
