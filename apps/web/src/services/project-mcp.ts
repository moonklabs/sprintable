// eslint-disable-next-line @typescript-eslint/no-explicit-any
type SupabaseClient = any;

import { z } from 'zod';
import { decryptSecretForOrg, encryptSecretForOrg } from '@/lib/kms';
import { encodeMcpOAuthState } from '@/lib/mcp-oauth-state';
import { GITHUB_MCP_TOOL_NAMES } from '@/lib/github-mcp';

const MCP_INTEGRATION_PREFIX = 'mcp_server:';
const MCP_VAULT_REF_PREFIX = 'vault:mcp_connection:';
const TOOL_LIST_TIMEOUT_MS = 10_000;

const approvedMcpServerSchema = z.object({
  id: z.string().uuid(),
  server_key: z.string().min(1),
  display_name: z.string().min(1),
  provider: z.enum(['github', 'linear', 'jira']),
  auth_strategy: z.enum(['oauth', 'api_key', 'api_token']),
  gateway_url_env: z.string().min(1),
  token_header_name: z.string().min(1),
  token_scheme: z.enum(['bearer', 'plain']),
  oauth_authorize_url: z.string().url().nullable().optional(),
  oauth_token_url: z.string().url().nullable().optional(),
  oauth_client_id_env: z.string().nullable().optional(),
  oauth_client_secret_env: z.string().nullable().optional(),
  oauth_redirect_uri_env: z.string().nullable().optional(),
  oauth_scopes: z.array(z.string()).optional().default([]),
  tool_cache_ttl_seconds: z.number().int().positive(),
  is_active: z.boolean(),
});

const orgIntegrationSchema = z.object({
  id: z.string().uuid(),
  org_id: z.string().uuid(),
  project_id: z.string().uuid(),
  integration_type: z.string().min(1),
  provider: z.string().min(1),
  secret_last4: z.string().nullable().optional(),
  encrypted_secret: z.string().nullable().optional(),
  kms_provider: z.string().nullable().optional(),
  kms_status: z.string().nullable().optional(),
  config: z.record(z.string(), z.unknown()).optional().default({}),
  status: z.enum(['active', 'error', 'pending_oauth']).optional().default('active'),
  validated_at: z.string().nullable().optional(),
  last_error: z.string().nullable().optional(),
  tool_cache: z.array(z.string()).or(z.array(z.object({ name: z.string() }))).optional().default([]),
  tool_cache_expires_at: z.string().nullable().optional(),
});

const mcpToolsListSchema = z.object({
  result: z.object({
    tools: z.array(z.object({ name: z.string().min(1) })).optional().default([]),
  }).optional(),
  error: z.object({ message: z.string().optional() }).optional(),
}).passthrough();

const githubTokenExchangeSchema = z.object({
  access_token: z.string().min(1),
  token_type: z.string().optional(),
  scope: z.string().optional(),
});

const githubViewerSchema = z.object({
  login: z.string().min(1),
});

export type ApprovedMcpServerRecord = z.infer<typeof approvedMcpServerSchema>;
export type OrgMcpIntegrationRecord = z.infer<typeof orgIntegrationSchema>;

export interface ProjectMcpConnectionSummary {
  serverKey: string;
  displayName: string;
  provider: 'github' | 'linear' | 'jira';
  authStrategy: 'oauth' | 'api_key' | 'api_token';
  connected: boolean;
  connectUrl: string | null;
  maskedSecret: string | null;
  label: string | null;
  status: 'active' | 'error' | 'pending_oauth' | 'disconnected';
  toolNames: string[];
  validatedAt: string | null;
  lastError: string | null;
}

export type ExternalMcpServerConfig = {
  kind: 'generic';
  name: string;
  url: string;
  allowed_tools: string[];
  auth?: {
    token_ref: string;
    header_name?: string;
    scheme?: 'bearer' | 'plain';
  };
} | {
  kind: 'github';
  name: 'github';
  url: string;
  allowed_tools: string[];
  auth: {
    token_ref: string;
    header_name?: string;
    scheme?: 'bearer' | 'plain';
  };
};

export function buildMcpIntegrationType(serverKey: string) {
  return `${MCP_INTEGRATION_PREFIX}${serverKey}`;
}

export function buildMcpVaultRef(serverKey: string) {
  return `${MCP_VAULT_REF_PREFIX}${serverKey}`;
}

export function parseMcpVaultRef(tokenRef: string) {
  if (!tokenRef.startsWith(MCP_VAULT_REF_PREFIX)) return null;
  const serverKey = tokenRef.slice(MCP_VAULT_REF_PREFIX.length).trim();
  return serverKey || null;
}

function parseToolCache(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  const names = raw
    .map((entry) => {
      if (typeof entry === 'string') return entry.trim();
      if (entry && typeof entry === 'object' && typeof (entry as { name?: unknown }).name === 'string') {
        return String((entry as { name: string }).name).trim();
      }
      return '';
    })
    .filter(Boolean);

  return [...new Set(names)];
}

function maskSecret(secretLast4?: string | null) {
  return secretLast4 ? `****${secretLast4}` : null;
}

function getConnectionLabel(record: OrgMcpIntegrationRecord) {
  const raw = record.config?.label;
  return typeof raw === 'string' && raw.trim() ? raw.trim() : null;
}

function resolveGatewayUrl(server: ApprovedMcpServerRecord) {
  const envName = server.gateway_url_env.trim();
  const value = process.env[envName]?.trim();
  if (!value) {
    throw new Error(`mcp_gateway_env_missing:${envName}`);
  }
  return value;
}

function resolveOptionalEnv(envName?: string | null) {
  const key = envName?.trim();
  if (!key) return null;
  const value = process.env[key]?.trim();
  return value || null;
}

function getOAuthRedirectUri(server: ApprovedMcpServerRecord, origin: string) {
  return resolveOptionalEnv(server.oauth_redirect_uri_env) ?? `${origin}/api/integrations/mcp/github/callback`;
}

function buildAuthHeader(server: ApprovedMcpServerRecord, secret: string) {
  const headerName = server.token_header_name || 'Authorization';
  const scheme = server.token_scheme || 'bearer';
  return {
    [headerName]: scheme === 'bearer' ? `Bearer ${secret}` : secret,
  };
}

async function loadApprovedServers(supabase: SupabaseClient) {
  const { data, error } = await supabase
    .from('approved_mcp_servers')
    .select('*')
    .eq('is_active', true)
    .order('display_name', { ascending: true });

  if (error) throw error;
  return (data ?? []).map((row) => approvedMcpServerSchema.parse(row));
}

async function loadProjectMcpIntegrations(supabase: SupabaseClient, projectId: string) {
  const { data, error } = await supabase
    .from('org_integrations')
    .select('id, org_id, project_id, integration_type, provider, secret_last4, encrypted_secret, kms_provider, kms_status, config, status, validated_at, last_error, tool_cache, tool_cache_expires_at')
    .eq('project_id', projectId)
    .like('integration_type', `${MCP_INTEGRATION_PREFIX}%`)
    .order('updated_at', { ascending: false });

  if (error) throw error;

  return (data ?? []).map((row) => {
    const parsed = orgIntegrationSchema.parse({
      ...row,
      tool_cache: parseToolCache(row.tool_cache),
      config: row.config ?? {},
    });
    return {
      ...parsed,
      tool_cache: parseToolCache(row.tool_cache),
      config: (row.config as Record<string, unknown> | null) ?? {},
    } satisfies OrgMcpIntegrationRecord;
  });
}

function findIntegrationForServer(integrations: OrgMcpIntegrationRecord[], serverKey: string) {
  return integrations.find((integration) => integration.integration_type === buildMcpIntegrationType(serverKey)) ?? null;
}

async function fetchToolsList(
  server: ApprovedMcpServerRecord,
  secret: string,
  fetchFn: typeof fetch = fetch,
): Promise<string[]> {
  const response = await fetchFn(resolveGatewayUrl(server), {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...buildAuthHeader(server, secret),
    },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: globalThis.crypto.randomUUID(),
      method: 'tools/list',
      params: {},
    }),
    signal: AbortSignal.timeout(TOOL_LIST_TIMEOUT_MS),
  });

  const json = await response.json().catch(() => null);
  if (!response.ok) {
    const message = json && typeof json === 'object' && typeof (json as { error?: { message?: string } }).error?.message === 'string'
      ? (json as { error: { message: string } }).error.message
      : `external_mcp_http_${response.status}`;
    throw new Error(message);
  }

  const parsed = mcpToolsListSchema.parse(json ?? {});
  if (parsed.error?.message) {
    throw new Error(parsed.error.message);
  }

  const toolNames = parseToolCache(parsed.result?.tools ?? []);
  if (toolNames.length === 0 && server.provider === 'github') {
    return [...GITHUB_MCP_TOOL_NAMES];
  }
  if (toolNames.length === 0) {
    throw new Error('mcp_tools_list_empty');
  }
  return toolNames;
}

async function updateIntegrationCache(
  supabase: SupabaseClient,
  integrationId: string,
  input: {
    status: 'active' | 'error' | 'pending_oauth';
    toolNames?: string[];
    validatedAt?: string | null;
    toolCacheExpiresAt?: string | null;
    lastError?: string | null;
    config?: Record<string, unknown>;
    encryptedSecret?: string;
    secretLast4?: string;
    provider?: string;
  },
) {
  const patch: Record<string, unknown> = {
    status: input.status,
    validated_at: input.validatedAt ?? null,
    tool_cache_expires_at: input.toolCacheExpiresAt ?? null,
    last_error: input.lastError ?? null,
    updated_at: new Date().toISOString(),
  };

  if (input.toolNames) patch.tool_cache = input.toolNames;
  if (input.config) patch.config = input.config;
  if (input.encryptedSecret) patch.encrypted_secret = input.encryptedSecret;
  if (input.secretLast4) patch.secret_last4 = input.secretLast4;
  if (input.provider) patch.provider = input.provider;
  patch.rotation_requested_at = null;
  patch.kms_status = 'active';

  const { error } = await supabase
    .from('org_integrations')
    .update(patch)
    .eq('id', integrationId);

  if (error) throw error;
}

export async function listProjectMcpConnectionSummaries(
  supabase: SupabaseClient,
  input: { orgId: string; projectId: string; origin: string; actorId: string },
): Promise<ProjectMcpConnectionSummary[]> {
  const [servers, integrations] = await Promise.all([
    loadApprovedServers(supabase),
    loadProjectMcpIntegrations(supabase, input.projectId),
  ]);

  return servers.map((server) => {
    const integration = findIntegrationForServer(integrations, server.server_key);
    return {
      serverKey: server.server_key,
      displayName: server.display_name,
      provider: server.provider,
      authStrategy: server.auth_strategy,
      connected: Boolean(integration?.encrypted_secret),
      connectUrl: server.auth_strategy === 'oauth'
        ? buildGitHubConnectUrl(server, {
            origin: input.origin,
            orgId: input.orgId,
            projectId: input.projectId,
            actorId: input.actorId,
          })
        : null,
      maskedSecret: maskSecret(integration?.secret_last4),
      label: integration ? getConnectionLabel(integration) : null,
      status: integration?.status ?? 'disconnected',
      toolNames: integration ? parseToolCache(integration.tool_cache) : [],
      validatedAt: integration?.validated_at ?? null,
      lastError: integration?.last_error ?? null,
    };
  });
}

async function saveProjectMcpConnection(
  supabase: SupabaseClient,
  server: ApprovedMcpServerRecord,
  input: {
    orgId: string;
    projectId: string;
    actorId: string;
    secret: string;
    label?: string | null;
    fetchFn?: typeof fetch;
  },
) {
  const now = new Date();
  const validatedAt = now.toISOString();
  const toolNames = await fetchToolsList(server, input.secret, input.fetchFn);
  const encryptedSecret = await encryptSecretForOrg(input.orgId, input.secret);
  const config = {
    label: input.label?.trim() || server.display_name,
  };

  const { error } = await supabase
    .from('org_integrations')
    .upsert({
      org_id: input.orgId,
      project_id: input.projectId,
      integration_type: buildMcpIntegrationType(server.server_key),
      provider: server.provider,
      secret_last4: input.secret.slice(-4),
      encrypted_secret: encryptedSecret,
      kms_provider: process.env.KMS_PROVIDER ?? 'local',
      kms_status: 'active',
      rotation_requested_at: null,
      config,
      status: 'active',
      validated_at: validatedAt,
      last_error: null,
      tool_cache: toolNames,
      tool_cache_expires_at: new Date(now.getTime() + server.tool_cache_ttl_seconds * 1000).toISOString(),
      updated_at: validatedAt,
    }, { onConflict: 'project_id,integration_type' });

  if (error) throw error;

  return {
    serverKey: server.server_key,
    displayName: server.display_name,
    label: config.label,
    toolNames,
    maskedSecret: `****${input.secret.slice(-4)}`,
    validatedAt,
  };
}

export async function upsertProjectMcpConnection(
  supabase: SupabaseClient,
  input: {
    orgId: string;
    projectId: string;
    actorId: string;
    serverKey: string;
    secret: string;
    label?: string | null;
    fetchFn?: typeof fetch;
  },
) {
  const [server] = (await loadApprovedServers(supabase)).filter((entry) => entry.server_key === input.serverKey);
  if (!server) throw new Error('approved_mcp_server_not_found');
  if (server.auth_strategy === 'oauth') throw new Error('oauth_connection_requires_callback');

  return saveProjectMcpConnection(supabase, server, input);
}

export async function exchangeGitHubOAuthCode(
  supabase: SupabaseClient,
  input: {
    code: string;
    origin: string;
    orgId: string;
    projectId: string;
    actorId: string;
    fetchFn?: typeof fetch;
  },
) {
  const server = (await loadApprovedServers(supabase)).find((entry) => entry.server_key === 'github');
  if (!server) throw new Error('approved_mcp_server_not_found');

  const clientId = resolveOptionalEnv(server.oauth_client_id_env);
  const clientSecret = resolveOptionalEnv(server.oauth_client_secret_env);
  const redirectUri = getOAuthRedirectUri(server, input.origin);
  if (!clientId || !clientSecret) {
    throw new Error('github_mcp_oauth_not_configured');
  }

  const tokenResponse = await (input.fetchFn ?? fetch)(server.oauth_token_url ?? 'https://github.com/login/oauth/access_token', {
    method: 'POST',
    headers: {
      Accept: 'application/json',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      client_id: clientId,
      client_secret: clientSecret,
      code: input.code,
      redirect_uri: redirectUri,
    }),
    signal: AbortSignal.timeout(TOOL_LIST_TIMEOUT_MS),
  });

  const tokenJson = await tokenResponse.json().catch(() => null);
  if (!tokenResponse.ok) {
    throw new Error(`github_oauth_http_${tokenResponse.status}`);
  }

  const tokenPayload = githubTokenExchangeSchema.parse(tokenJson ?? {});
  const accessToken = tokenPayload.access_token;

  const viewerResponse = await (input.fetchFn ?? fetch)('https://api.github.com/user', {
    method: 'GET',
    headers: {
      Accept: 'application/vnd.github+json',
      Authorization: `Bearer ${accessToken}`,
      'User-Agent': 'Sprintable-MCP-Connection',
    },
    signal: AbortSignal.timeout(TOOL_LIST_TIMEOUT_MS),
  });
  const viewerJson = await viewerResponse.json().catch(() => null);
  if (!viewerResponse.ok) {
    throw new Error(`github_viewer_http_${viewerResponse.status}`);
  }

  const viewer = githubViewerSchema.parse(viewerJson ?? {});

  return saveProjectMcpConnection(supabase, server, {
    orgId: input.orgId,
    projectId: input.projectId,
    actorId: input.actorId,
    secret: accessToken,
    label: viewer.login,
    fetchFn: input.fetchFn,
  });
}

export async function deleteProjectMcpConnection(
  supabase: SupabaseClient,
  input: { projectId: string; serverKey: string },
) {
  const { error } = await supabase
    .from('org_integrations')
    .delete()
    .eq('project_id', input.projectId)
    .eq('integration_type', buildMcpIntegrationType(input.serverKey));

  if (error) throw error;
}

export async function createMcpConnectionReviewRequest(
  supabase: SupabaseClient,
  input: {
    orgId: string;
    projectId: string;
    actorId: string;
    serverName: string;
    serverUrl: string;
    notes?: string | null;
  },
) {
  const { data, error } = await supabase
    .from('mcp_connection_requests')
    .insert({
      org_id: input.orgId,
      project_id: input.projectId,
      requested_by: input.actorId,
      server_name: input.serverName,
      server_url: input.serverUrl,
      notes: input.notes?.trim() || null,
      status: 'pending',
    })
    .select('id, server_name, server_url, notes, status, created_at')
    .single();

  if (error) throw error;
  return data;
}

export async function listProjectApprovedMcpServerConfigs(
  supabase: SupabaseClient,
  projectId: string,
): Promise<ExternalMcpServerConfig[]> {
  const [servers, integrations] = await Promise.all([
    loadApprovedServers(supabase),
    loadProjectMcpIntegrations(supabase, projectId),
  ]);

  const configs: ExternalMcpServerConfig[] = [];

  integrations
    .filter((integration) => integration.status === 'active' && parseToolCache(integration.tool_cache).length > 0)
    .forEach((integration) => {
      const serverKey = integration.integration_type.slice(MCP_INTEGRATION_PREFIX.length);
      const server = servers.find((entry) => entry.server_key === serverKey);
      if (!server) return;

      if (server.provider === 'github') {
        configs.push({
          kind: 'github',
          name: 'github',
          url: resolveGatewayUrl(server),
          allowed_tools: parseToolCache(integration.tool_cache),
          auth: {
            token_ref: buildMcpVaultRef(server.server_key),
            header_name: server.token_header_name,
            scheme: server.token_scheme,
          },
        });
        return;
      }

      configs.push({
        kind: 'generic',
        name: server.display_name,
        url: resolveGatewayUrl(server),
        allowed_tools: parseToolCache(integration.tool_cache),
        auth: {
          token_ref: buildMcpVaultRef(server.server_key),
          header_name: server.token_header_name,
          scheme: server.token_scheme,
        },
      });
    });

  return configs;
}

export async function resolveProjectMcpVaultToken(
  supabase: SupabaseClient,
  projectId: string,
  tokenRef: string,
): Promise<string> {
  const serverKey = parseMcpVaultRef(tokenRef);
  if (!serverKey) {
    throw new Error(`invalid_mcp_vault_ref:${tokenRef}`);
  }

  const { data, error } = await supabase
    .from('org_integrations')
    .select('org_id, encrypted_secret')
    .eq('project_id', projectId)
    .eq('integration_type', buildMcpIntegrationType(serverKey))
    .maybeSingle();

  if (error) throw error;
  if (!data?.org_id || !data.encrypted_secret) {
    throw new Error(`missing_mcp_vault_secret:${serverKey}`);
  }

  return decryptSecretForOrg(data.org_id as string, data.encrypted_secret as string);
}

export async function validateProjectMcpConnections(
  supabase: SupabaseClient,
  input: {
    projectId: string;
    fetchFn?: typeof fetch;
  },
) {
  const [servers, integrations] = await Promise.all([
    loadApprovedServers(supabase),
    loadProjectMcpIntegrations(supabase, input.projectId),
  ]);

  const errors: string[] = [];

  for (const integration of integrations) {
    const serverKey = integration.integration_type.slice(MCP_INTEGRATION_PREFIX.length);
    const server = servers.find((entry) => entry.server_key === serverKey);
    if (!server || !integration.encrypted_secret) continue;

    try {
      const secret = await decryptSecretForOrg(integration.org_id, integration.encrypted_secret);
      const toolNames = await fetchToolsList(server, secret, input.fetchFn);
      const now = new Date();
      await updateIntegrationCache(supabase, integration.id, {
        status: 'active',
        toolNames,
        validatedAt: now.toISOString(),
        toolCacheExpiresAt: new Date(now.getTime() + server.tool_cache_ttl_seconds * 1000).toISOString(),
        lastError: null,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : 'mcp_validation_failed';
      errors.push(`${server.display_name}: ${message}`);
      await updateIntegrationCache(supabase, integration.id, {
        status: 'error',
        validatedAt: new Date().toISOString(),
        lastError: message,
      });
    }
  }

  return {
    ok: errors.length === 0,
    errors,
  };
}

export async function listProjectApprovedMcpToolOptions(
  supabase: SupabaseClient,
  projectId: string,
): Promise<Array<{ name: string; serverName: string; groupKind: 'mcp' | 'github' }>> {
  const [servers, integrations] = await Promise.all([
    loadApprovedServers(supabase),
    loadProjectMcpIntegrations(supabase, projectId),
  ]);

  const options = integrations.flatMap((integration) => {
    if (integration.status !== 'active') return [];
    const serverKey = integration.integration_type.slice(MCP_INTEGRATION_PREFIX.length);
    const server = servers.find((entry) => entry.server_key === serverKey);
    if (!server) return [];

    return parseToolCache(integration.tool_cache).map((name) => ({
      name,
      serverName: server.display_name,
      groupKind: server.provider === 'github' ? 'github' as const : 'mcp' as const,
    }));
  });

  const deduped = new Map<string, { name: string; serverName: string; groupKind: 'mcp' | 'github' }>();
  options.forEach((option) => {
    if (!deduped.has(option.name)) deduped.set(option.name, option);
  });
  return [...deduped.values()];
}

export function buildGitHubConnectUrl(
  server: ApprovedMcpServerRecord,
  input: { origin: string; orgId: string; projectId: string; actorId: string },
) {
  const clientId = resolveOptionalEnv(server.oauth_client_id_env);
  if (!clientId) return null;

  const authorizeUrl = server.oauth_authorize_url ?? 'https://github.com/login/oauth/authorize';
  const redirectUri = getOAuthRedirectUri(server, input.origin);
  const state = encodeMcpOAuthState({
    orgId: input.orgId,
    projectId: input.projectId,
    actorId: input.actorId,
    serverKey: server.server_key,
    issuedAt: Math.floor(Date.now() / 1000),
  });

  const params = new URLSearchParams({
    client_id: clientId,
    redirect_uri: redirectUri,
    scope: (server.oauth_scopes ?? []).join(' '),
    state,
  });

  return `${authorizeUrl}?${params.toString()}`;
}
