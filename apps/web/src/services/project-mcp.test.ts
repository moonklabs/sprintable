import { beforeEach, describe, expect, it, vi } from 'vitest';

const {
  encryptSecretForOrgMock,
  decryptSecretForOrgMock,
  encodeMcpOAuthStateMock,
} = vi.hoisted(() => ({
  encryptSecretForOrgMock: vi.fn(async (_orgId: string, secret: string) => `enc:${secret}`),
  decryptSecretForOrgMock: vi.fn(async (_orgId: string, encrypted: string) => encrypted.replace(/^enc:/, '')),
  encodeMcpOAuthStateMock: vi.fn(() => 'signed-state'),
}));

vi.mock('@/lib/kms', () => ({
  encryptSecretForOrg: encryptSecretForOrgMock,
  decryptSecretForOrg: decryptSecretForOrgMock,
}));

vi.mock('@/lib/mcp-oauth-state', () => ({
  encodeMcpOAuthState: encodeMcpOAuthStateMock,
}));

import {
  buildGitHubConnectUrl,
  buildMcpIntegrationType,
  buildMcpVaultRef,
  exchangeGitHubOAuthCode,
  listProjectApprovedMcpServerConfigs,
  listProjectApprovedMcpToolOptions,
  listProjectMcpConnectionSummaries,
  parseMcpVaultRef,
  resolveProjectMcpVaultToken,
  upsertProjectMcpConnection,
  validateProjectMcpConnections,
} from './project-mcp';

const ORG_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const PROJECT_ID = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const MEMBER_ID = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';

function createSupabaseStub(options?: {
  approvedServers?: unknown[];
  integrations?: Array<Record<string, unknown>>;
}) {
  const state = {
    upserts: [] as unknown[],
    updates: [] as unknown[],
    inserts: [] as unknown[],
    approvedServers: options?.approvedServers ?? [
      {
        id: '11111111-1111-4111-8111-111111111111',
        server_key: 'github',
        display_name: 'GitHub',
        provider: 'github',
        auth_strategy: 'oauth',
        gateway_url_env: 'GITHUB_MCP_GATEWAY_URL',
        token_header_name: 'X-GitHub-Token',
        token_scheme: 'plain',
        oauth_authorize_url: 'https://github.com/login/oauth/authorize',
        oauth_token_url: 'https://github.com/login/oauth/access_token',
        oauth_client_id_env: 'GITHUB_MCP_CLIENT_ID',
        oauth_client_secret_env: 'GITHUB_MCP_CLIENT_SECRET',
        oauth_redirect_uri_env: 'GITHUB_MCP_REDIRECT_URI',
        oauth_scopes: ['repo', 'read:user'],
        tool_cache_ttl_seconds: 3600,
        is_active: true,
      },
      {
        id: '22222222-2222-4222-8222-222222222222',
        server_key: 'linear',
        display_name: 'Linear',
        provider: 'linear',
        auth_strategy: 'api_key',
        gateway_url_env: 'LINEAR_MCP_GATEWAY_URL',
        token_header_name: 'Authorization',
        token_scheme: 'bearer',
        oauth_authorize_url: null,
        oauth_token_url: null,
        oauth_client_id_env: null,
        oauth_client_secret_env: null,
        oauth_redirect_uri_env: null,
        oauth_scopes: [],
        tool_cache_ttl_seconds: 1800,
        is_active: true,
      },
      {
        id: '33333333-3333-4333-8333-333333333333',
        server_key: 'jira',
        display_name: 'Jira',
        provider: 'jira',
        auth_strategy: 'api_token',
        gateway_url_env: 'JIRA_MCP_GATEWAY_URL',
        token_header_name: 'Authorization',
        token_scheme: 'bearer',
        oauth_authorize_url: null,
        oauth_token_url: null,
        oauth_client_id_env: null,
        oauth_client_secret_env: null,
        oauth_redirect_uri_env: null,
        oauth_scopes: [],
        tool_cache_ttl_seconds: 1800,
        is_active: true,
      },
    ],
    integrations: options?.integrations ?? [],
  };

  const supabase = {
    from(table: string) {
      if (table === 'approved_mcp_servers') {
        return {
          select() { return this; },
          eq() { return this; },
          order: async () => ({ data: state.approvedServers, error: null }),
        };
      }

      if (table === 'org_integrations') {
        let selectedColumns = '*';
        const filters: Record<string, unknown> = {};
        let mode: 'select' | 'upsert' | 'update' | 'delete' = 'select';
        let updatePayload: Record<string, unknown> | null = null;

        const builder = {
          select(columns: string) {
            selectedColumns = columns;
            mode = 'select';
            return builder;
          },
          order() { return builder; },
          like(column: string, value: string) {
            filters[column] = value;
            return builder;
          },
          eq(column: string, value: unknown) {
            filters[column] = value;
            return builder;
          },
          maybeSingle: async () => {
            const row = state.integrations.find((entry) => Object.entries(filters).every(([key, value]) => entry[key] === value)) ?? null;
            if (!row) return { data: null, error: null };
            if (selectedColumns === 'org_id, encrypted_secret') {
              return { data: { org_id: row.org_id, encrypted_secret: row.encrypted_secret }, error: null };
            }
            return { data: row, error: null };
          },
          upsert(payload: Record<string, unknown>) {
            mode = 'upsert';
            state.upserts.push(payload);
            return Promise.resolve({ data: null, error: null });
          },
          update(payload: Record<string, unknown>) {
            mode = 'update';
            updatePayload = payload;
            state.updates.push(payload);
            return builder;
          },
          delete() {
            mode = 'delete';
            return builder;
          },
          single: async () => ({ data: null, error: null }),
          then(resolve: (value: { data: unknown[] | null; error: null }) => unknown) {
            if (mode === 'update' && filters.id && updatePayload) {
              const target = state.integrations.find((entry) => entry.id === filters.id);
              if (target) Object.assign(target, updatePayload);
            }
            if (mode === 'delete') {
              return Promise.resolve({ data: null, error: null }).then(resolve);
            }

            const rows = state.integrations.filter((entry) => {
              return Object.entries(filters).every(([key, value]) => {
                if (key === 'integration_type' && typeof value === 'string' && value.endsWith('%')) {
                  return String(entry.integration_type).startsWith(value.slice(0, -1));
                }
                return entry[key] === value;
              });
            });
            return Promise.resolve({ data: rows, error: null }).then(resolve);
          },
        };

        return builder;
      }

      if (table === 'mcp_connection_requests') {
        let payload: Record<string, unknown> | null = null;
        return {
          insert(next: Record<string, unknown>) {
            payload = next;
            state.inserts.push(next);
            return this;
          },
          select() { return this; },
          single: async () => ({ data: { id: 'request-1', ...(payload ?? {}) }, error: null }),
        };
      }

      throw new Error(`Unexpected table: ${table}`);
    },
  };

  return { supabase, state };
}

describe('project-mcp service', () => {
  beforeEach(() => {
    process.env.GITHUB_MCP_GATEWAY_URL = 'https://github-mcp.example.com/rpc';
    process.env.LINEAR_MCP_GATEWAY_URL = 'https://linear-mcp.example.com/rpc';
    process.env.JIRA_MCP_GATEWAY_URL = 'https://jira-mcp.example.com/rpc';
    process.env.GITHUB_MCP_CLIENT_ID = 'github-client-id';
    process.env.GITHUB_MCP_CLIENT_SECRET = 'github-client-secret';
    process.env.GITHUB_MCP_REDIRECT_URI = 'https://sprintable.app/api/integrations/mcp/github/callback';

    encryptSecretForOrgMock.mockClear();
    decryptSecretForOrgMock.mockClear();
    encodeMcpOAuthStateMock.mockClear();
    encodeMcpOAuthStateMock.mockReturnValue('signed-state');
  });

  it('builds OAuth connect URLs for approved servers and returns connection summaries', async () => {
    const { supabase } = createSupabaseStub({
      integrations: [
        {
          id: '44444444-4444-4444-8444-444444444444',
          org_id: ORG_ID,
          project_id: PROJECT_ID,
          integration_type: buildMcpIntegrationType('linear'),
          provider: 'linear',
          secret_last4: '1234',
          encrypted_secret: 'enc:linear-secret',
          kms_provider: 'local',
          kms_status: 'active',
          config: { label: 'Moonklabs Linear' },
          status: 'active',
          validated_at: '2026-04-09T00:00:00.000Z',
          last_error: null,
          tool_cache: ['linear.search_issues'],
          tool_cache_expires_at: '2026-04-09T01:00:00.000Z',
          updated_at: '2026-04-09T00:00:00.000Z',
        },
      ],
    });

    const summaries = await listProjectMcpConnectionSummaries(supabase as never, {
      orgId: ORG_ID,
      projectId: PROJECT_ID,
      origin: 'https://sprintable.app',
      actorId: MEMBER_ID,
    });

    expect(summaries.find((item) => item.serverKey === 'github')).toMatchObject({
      connectUrl: expect.stringContaining('signed-state'),
      connected: false,
    });
    expect(summaries.find((item) => item.serverKey === 'linear')).toMatchObject({
      connected: true,
      maskedSecret: '****1234',
      toolNames: ['linear.search_issues'],
      label: 'Moonklabs Linear',
    });
  });

  it('stores manual provider connections with encrypted secret and cached tool names', async () => {
    const { supabase, state } = createSupabaseStub();
    const fetchFn = vi.fn(async () => new Response(JSON.stringify({
      jsonrpc: '2.0',
      id: '1',
      result: { tools: [{ name: 'linear.search_issues' }, { name: 'linear.create_issue' }] },
    }), { status: 200, headers: { 'Content-Type': 'application/json' } }));

    const result = await upsertProjectMcpConnection(supabase as never, {
      orgId: ORG_ID,
      projectId: PROJECT_ID,
      actorId: MEMBER_ID,
      serverKey: 'linear',
      secret: 'linear-secret',
      label: 'Moonklabs Linear',
      fetchFn,
    });

    expect(encryptSecretForOrgMock).toHaveBeenCalledWith(ORG_ID, 'linear-secret');
    expect(state.upserts[0]).toMatchObject({
      integration_type: buildMcpIntegrationType('linear'),
      encrypted_secret: 'enc:linear-secret',
      secret_last4: 'cret',
      tool_cache: ['linear.search_issues', 'linear.create_issue'],
    });
    expect(result.toolNames).toEqual(['linear.search_issues', 'linear.create_issue']);
  });

  it('exchanges GitHub OAuth code and stores the validated token', async () => {
    const { supabase, state } = createSupabaseStub();
    const fetchFn = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ access_token: 'gho_1234' }), { status: 200, headers: { 'Content-Type': 'application/json' } }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ login: 'octocat' }), { status: 200, headers: { 'Content-Type': 'application/json' } }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ jsonrpc: '2.0', id: '1', result: { tools: [] } }), { status: 200, headers: { 'Content-Type': 'application/json' } }));

    const result = await exchangeGitHubOAuthCode(supabase as never, {
      code: 'oauth-code',
      origin: 'https://sprintable.app',
      orgId: ORG_ID,
      projectId: PROJECT_ID,
      actorId: MEMBER_ID,
      fetchFn,
    });

    expect(result).toMatchObject({
      serverKey: 'github',
      label: 'octocat',
      toolNames: expect.arrayContaining(['github.list_issues']),
    });
    expect(state.upserts[0]).toMatchObject({ integration_type: buildMcpIntegrationType('github') });
  });

  it('resolves active approved MCP configs and vault tokens for runtime execution', async () => {
    const { supabase } = createSupabaseStub({
      integrations: [
        {
          id: '55555555-5555-4555-8555-555555555555',
          org_id: ORG_ID,
          project_id: PROJECT_ID,
          integration_type: buildMcpIntegrationType('linear'),
          provider: 'linear',
          secret_last4: '1234',
          encrypted_secret: 'enc:linear-secret',
          kms_provider: 'local',
          kms_status: 'active',
          config: { label: 'Moonklabs Linear' },
          status: 'active',
          validated_at: '2026-04-09T00:00:00.000Z',
          last_error: null,
          tool_cache: ['linear.search_issues'],
          tool_cache_expires_at: '2026-04-09T01:00:00.000Z',
          updated_at: '2026-04-09T00:00:00.000Z',
        },
      ],
    });

    const configs = await listProjectApprovedMcpServerConfigs(supabase as never, PROJECT_ID);
    const toolOptions = await listProjectApprovedMcpToolOptions(supabase as never, PROJECT_ID);
    const token = await resolveProjectMcpVaultToken(supabase as never, PROJECT_ID, buildMcpVaultRef('linear'));

    expect(configs).toEqual([
      expect.objectContaining({
        name: 'Linear',
        url: 'https://linear-mcp.example.com/rpc',
        auth: expect.objectContaining({ token_ref: 'vault:mcp_connection:linear' }),
      }),
    ]);
    expect(toolOptions).toEqual([{ name: 'linear.search_issues', serverName: 'Linear', groupKind: 'mcp' }]);
    expect(token).toBe('linear-secret');
    expect(parseMcpVaultRef(buildMcpVaultRef('linear'))).toBe('linear');
  });

  it('marks broken connections as error during validation', async () => {
    const { supabase, state } = createSupabaseStub({
      integrations: [
        {
          id: '66666666-6666-4666-8666-666666666666',
          org_id: ORG_ID,
          project_id: PROJECT_ID,
          integration_type: buildMcpIntegrationType('jira'),
          provider: 'jira',
          secret_last4: '1234',
          encrypted_secret: 'enc:jira-secret',
          kms_provider: 'local',
          kms_status: 'active',
          config: { label: 'Moonklabs Jira' },
          status: 'active',
          validated_at: null,
          last_error: null,
          tool_cache: ['jira.search_issues'],
          tool_cache_expires_at: null,
          updated_at: '2026-04-09T00:00:00.000Z',
        },
      ],
    });
    const fetchFn = vi.fn(async () => new Response(JSON.stringify({ error: { message: 'token invalid' } }), { status: 401, headers: { 'Content-Type': 'application/json' } }));

    const result = await validateProjectMcpConnections(supabase as never, {
      projectId: PROJECT_ID,
      fetchFn,
    });

    expect(result.ok).toBe(false);
    expect(result.errors[0]).toContain('Jira');
    expect(state.updates[0]).toMatchObject({ status: 'error', last_error: expect.stringContaining('token') });
  });

  it('builds the GitHub connect URL with signed state', () => {
    const url = buildGitHubConnectUrl({
      id: '11111111-1111-4111-8111-111111111111',
      server_key: 'github',
      display_name: 'GitHub',
      provider: 'github',
      auth_strategy: 'oauth',
      gateway_url_env: 'GITHUB_MCP_GATEWAY_URL',
      token_header_name: 'X-GitHub-Token',
      token_scheme: 'plain',
      oauth_authorize_url: 'https://github.com/login/oauth/authorize',
      oauth_token_url: 'https://github.com/login/oauth/access_token',
      oauth_client_id_env: 'GITHUB_MCP_CLIENT_ID',
      oauth_client_secret_env: 'GITHUB_MCP_CLIENT_SECRET',
      oauth_redirect_uri_env: 'GITHUB_MCP_REDIRECT_URI',
      oauth_scopes: ['repo'],
      tool_cache_ttl_seconds: 3600,
      is_active: true,
    }, {
      origin: 'https://sprintable.app',
      orgId: ORG_ID,
      projectId: PROJECT_ID,
      actorId: MEMBER_ID,
    });

    expect(url).toContain('client_id=github-client-id');
    expect(url).toContain('state=signed-state');
  });
});
