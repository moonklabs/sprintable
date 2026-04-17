import { describe, expect, it, vi, beforeEach } from 'vitest';

const {
  createSupabaseAdminClientMock,
  listProjectApprovedMcpServerConfigsMock,
  parseMcpVaultRefMock,
  resolveProjectMcpVaultTokenMock,
} = vi.hoisted(() => ({
  createSupabaseAdminClientMock: vi.fn(() => ({ tag: 'admin' })),
  listProjectApprovedMcpServerConfigsMock: vi.fn<(...args: unknown[]) => Promise<Array<{
    kind: 'generic' | 'github';
    name: string;
    url: string;
    allowed_tools: string[];
    auth?: { token_ref: string; header_name?: string; scheme?: 'bearer' | 'plain' };
  }>>>(async () => []),
  parseMcpVaultRefMock: vi.fn((tokenRef: string) => tokenRef.startsWith('vault:mcp_connection:') ? tokenRef.slice('vault:mcp_connection:'.length) : null),
  resolveProjectMcpVaultTokenMock: vi.fn<(...args: unknown[]) => Promise<string>>(),
}));

vi.mock('@/lib/supabase/admin', () => ({
  createSupabaseAdminClient: createSupabaseAdminClientMock,
}));

vi.mock('./project-mcp', () => ({
  listProjectApprovedMcpServerConfigs: listProjectApprovedMcpServerConfigsMock,
  parseMcpVaultRef: parseMcpVaultRefMock,
  resolveProjectMcpVaultToken: resolveProjectMcpVaultTokenMock,
}));

import { AgentToolExecutionEngine } from './agent-tool-execution-engine';
import { AgentBuiltinToolService } from './agent-builtin-tools';
import { GITHUB_MCP_TOOL_NAMES } from '@/lib/github-mcp';

function createSupabaseStub(llmConfig?: unknown) {
  return {
    from(table: string) {
      if (table !== 'project_ai_settings') throw new Error(`Unexpected table: ${table}`);
      return {
        select() { return this; },
        eq() { return this; },
        maybeSingle: async () => ({ data: llmConfig ? { llm_config: llmConfig } : null, error: null }),
      };
    },
  };
}

function createContext() {
  return {
    memo: {
      id: 'memo-1',
      org_id: 'org-1',
      project_id: 'project-1',
      title: 'Current memo',
      content: 'Current memo body',
      memo_type: 'task',
      status: 'open',
      assigned_to: 'agent-1',
      created_by: 'human-1',
      created_at: '2026-04-06T10:00:00.000Z',
      updated_at: '2026-04-06T10:00:00.000Z',
    },
    agent: {
      id: 'agent-1',
      org_id: 'org-1',
      project_id: 'project-1',
      name: 'Didi',
    },
    runId: 'run-1',
    sessionId: 'session-1',
  };
}

function allowlistedToolNames(...externalToolNames: string[]) {
  return ['create_memo', ...externalToolNames];
}

describe('AgentToolExecutionEngine', () => {
  beforeEach(() => {
    createSupabaseAdminClientMock.mockClear();
    listProjectApprovedMcpServerConfigsMock.mockReset();
    listProjectApprovedMcpServerConfigsMock.mockResolvedValue([]);
    parseMcpVaultRefMock.mockClear();
    parseMcpVaultRefMock.mockImplementation((tokenRef: string) => tokenRef.startsWith('vault:mcp_connection:') ? tokenRef.slice('vault:mcp_connection:'.length) : null);
    resolveProjectMcpVaultTokenMock.mockReset();
  });

  it('routes builtin tools through the builtin service and records duration metadata', async () => {
    const builtinToolService = {
      execute: vi.fn(async () => ({ memo_id: 'memo-1', ok: true })),
    } as unknown as AgentBuiltinToolService;
    const engine = new AgentToolExecutionEngine(createSupabaseStub() as never, { builtinToolService });

    const registry = await engine.loadRegistry('project-1', ['create_memo']);
    const result = await engine.execute('create_memo', { title: 'hello', content: 'world' }, createContext(), registry);

    expect(builtinToolService.execute).toHaveBeenCalledWith('create_memo', { title: 'hello', content: 'world' }, createContext());
    expect(result.source).toBe('builtin');
    expect(result.payload).toEqual(expect.objectContaining({ source: 'builtin', memo_id: 'memo-1', ok: true }));
    expect(result.durationMs).toBeGreaterThanOrEqual(0);
  });

  it('loads approved external tools into the available tool list', async () => {
    listProjectApprovedMcpServerConfigsMock.mockResolvedValue([
      {
        kind: 'generic',
        name: 'Docs',
        url: 'https://mcp.example.com/rpc',
        allowed_tools: ['external.search_docs', 'external.fetch_doc'],
      },
    ]);

    const engine = new AgentToolExecutionEngine(createSupabaseStub() as never);
    const registry = await engine.loadRegistry('project-1', allowlistedToolNames('external.search_docs', 'external.fetch_doc'));

    expect(registry.availableToolNames).toEqual(['create_memo', 'external.search_docs', 'external.fetch_doc']);
  });

  it('filters project-approved external tools out of the registry when the persona allowlist excludes them', async () => {
    listProjectApprovedMcpServerConfigsMock.mockResolvedValue([
      {
        kind: 'generic',
        name: 'Docs',
        url: 'https://mcp.example.com/rpc',
        allowed_tools: ['external.search_docs', 'external.fetch_doc'],
      },
    ]);

    const engine = new AgentToolExecutionEngine(createSupabaseStub() as never);
    const registry = await engine.loadRegistry('project-1', ['create_memo']);

    expect(registry.availableToolNames).toEqual(['create_memo']);
    expect(registry.externalServers).toEqual([]);
  });

  it('ignores legacy ai-settings MCP config so approved connections stay the only source of truth', async () => {
    listProjectApprovedMcpServerConfigsMock.mockResolvedValue([
      {
        kind: 'generic',
        name: 'Linear Approved',
        url: 'https://approved-linear.example.com/rpc',
        allowed_tools: ['linear.search_issues'],
        auth: { token_ref: 'vault:mcp_connection:linear', header_name: 'Authorization', scheme: 'bearer' },
      },
    ]);
    resolveProjectMcpVaultTokenMock.mockResolvedValue('linear-secret');

    const fetchFn = vi.fn(async () => new Response(JSON.stringify({
      jsonrpc: '2.0',
      id: '1',
      result: { content: [{ type: 'text', text: 'Approved linear ok' }] },
    }), { status: 200, headers: { 'Content-Type': 'application/json' } }));

    const engine = new AgentToolExecutionEngine(createSupabaseStub({
      mcp_servers: [{
        name: 'legacy-linear',
        url: 'https://legacy-linear.example.com/rpc',
        allowed_tools: ['linear.search_issues'],
        auth: { token_ref: 'MCP_TOKEN_LEGACY' },
      }],
    }) as never, { fetchFn });

    const registry = await engine.loadRegistry('project-1', allowlistedToolNames('linear.search_issues'));
    const result = await engine.execute('linear.search_issues', { query: 'S426' }, createContext(), registry);

    expect(registry.externalServers).toHaveLength(1);
    expect(registry.externalServers[0]?.name).toBe('Linear Approved');
    expect(fetchFn).toHaveBeenCalledWith('https://approved-linear.example.com/rpc', expect.any(Object));
    expect(result.payload).toEqual(expect.objectContaining({ tool_name: 'linear.search_issues' }));
  });

  it('calls a generic approved external MCP server with auth.token_ref and summarizes the result to 4,096 tokens', async () => {
    process.env.MCP_TOKEN_DOCS = 'secret-token';
    process.env.MCP_ALLOWED_TOKEN_REFS = 'MCP_TOKEN_DOCS';
    listProjectApprovedMcpServerConfigsMock.mockResolvedValue([
      {
        kind: 'generic',
        name: 'Docs',
        url: 'https://mcp.example.com/rpc',
        allowed_tools: ['external.search_docs'],
        auth: { token_ref: 'MCP_TOKEN_DOCS' },
      },
    ]);

    const fetchFn = vi.fn(async () => new Response(JSON.stringify({
      jsonrpc: '2.0',
      id: '1',
      result: {
        content: [{ type: 'text', text: 'A'.repeat(20_000) }],
      },
    }), { status: 200, headers: { 'Content-Type': 'application/json' } }));

    const auditLogger = vi.fn(async () => undefined);
    const engine = new AgentToolExecutionEngine(createSupabaseStub() as never, { fetchFn, auditLogger });

    const registry = await engine.loadRegistry('project-1', allowlistedToolNames('external.search_docs'));
    const result = await engine.execute('external.search_docs', { query: 'agent runtime' }, createContext(), registry);

    expect(fetchFn).toHaveBeenCalledWith('https://mcp.example.com/rpc', expect.objectContaining({
      method: 'POST',
      headers: expect.objectContaining({ Authorization: 'Bearer secret-token' }),
    }));
    expect(result.source).toBe('external');
    expect(result.payload).toEqual(expect.objectContaining({
      source: 'external',
      server_name: 'Docs',
      tool_name: 'external.search_docs',
      summary_tokens: expect.any(Number),
    }));
    expect(String(result.payload.summary).length).toBeLessThanOrEqual(4096 * 4);
    expect(auditLogger).toHaveBeenCalledWith('agent_tool.external_executed', 'info', expect.objectContaining({
      tool_name: 'external.search_docs',
      tool_source: 'external',
      outcome: 'allowed',
    }));

    delete process.env.MCP_TOKEN_DOCS;
    delete process.env.MCP_ALLOWED_TOKEN_REFS;
  });

  it('blocks tools outside the approved external allowlist', async () => {
    listProjectApprovedMcpServerConfigsMock.mockResolvedValue([
      {
        kind: 'generic',
        name: 'Docs',
        url: 'https://mcp.example.com/rpc',
        allowed_tools: ['external.search_docs'],
      },
    ]);

    const auditLogger = vi.fn(async () => undefined);
    const engine = new AgentToolExecutionEngine(createSupabaseStub() as never, { auditLogger });

    const registry = await engine.loadRegistry('project-1', allowlistedToolNames('external.search_docs'));
    const result = await engine.execute('external.delete_everything', {}, createContext(), registry);

    expect(result.payload).toEqual({
      source: 'external',
      duration_ms: 0,
      error: 'tool_acl_denied',
      reason_code: 'tool_not_allowlisted',
      reason: 'This tool is not available in the current persona allowlist.',
      user_reason: 'This tool is not available in the current persona allowlist.',
      next_action: 'Use an allowlisted tool or update the persona allowlist before retrying.',
    });
    expect(auditLogger).toHaveBeenCalledWith('agent_tool.acl_denied', 'security', expect.objectContaining({
      tool_name: 'external.delete_everything',
      reason_code: 'tool_not_allowlisted',
      tool_source: 'external',
      outcome: 'denied',
      operator_reason: 'The tool name is missing from the effective persona/deployment allowlist.',
    }));
  });

  it('blocks execution of a project-approved external tool when the persona allowlist excludes it', async () => {
    listProjectApprovedMcpServerConfigsMock.mockResolvedValue([
      {
        kind: 'generic',
        name: 'Docs',
        url: 'https://mcp.example.com/rpc',
        allowed_tools: ['external.search_docs'],
      },
    ]);

    const auditLogger = vi.fn(async () => undefined);
    const engine = new AgentToolExecutionEngine(createSupabaseStub() as never, { auditLogger });
    const registry = await engine.loadRegistry('project-1', ['create_memo']);
    const result = await engine.execute('external.search_docs', { query: 'agent runtime' }, createContext(), registry);

    expect(registry.availableToolNames).toEqual(['create_memo']);
    expect(result.payload).toEqual({
      source: 'external',
      duration_ms: 0,
      error: 'tool_acl_denied',
      reason_code: 'tool_not_allowlisted',
      reason: 'This tool is not available in the current persona allowlist.',
      user_reason: 'This tool is not available in the current persona allowlist.',
      next_action: 'Use an allowlisted tool or update the persona allowlist before retrying.',
    });
    expect(auditLogger).toHaveBeenCalledWith('agent_tool.acl_denied', 'security', expect.objectContaining({
      tool_name: 'external.search_docs',
      reason_code: 'tool_not_allowlisted',
      tool_source: 'external',
      outcome: 'denied',
      operator_reason: 'The tool name is missing from the effective persona/deployment allowlist.',
    }));
  });

  it('denies tool execution when the current project falls outside the deployment scope', async () => {
    const auditLogger = vi.fn(async () => undefined);
    const engine = new AgentToolExecutionEngine(createSupabaseStub() as never, { auditLogger });

    const registry = await engine.loadRegistry('project-1', ['create_memo'], {
      allowedProjectIds: ['project-2'],
      agentId: 'agent-1',
    });
    const result = await engine.execute('create_memo', { title: 'hello', content: 'world' }, createContext(), registry);

    expect(registry.availableToolNames).toEqual([]);
    expect(result.payload).toEqual({
      source: 'builtin',
      duration_ms: 0,
      error: 'tool_acl_denied',
      reason_code: 'project_not_allowlisted',
      reason: 'This tool is unavailable because the current project is outside the deployment scope.',
      user_reason: 'This tool is unavailable because the current project is outside the deployment scope.',
      next_action: 'Update the deployment project scope or run the request inside an allowed project.',
    });
    expect(auditLogger).toHaveBeenCalledWith('agent_tool.acl_denied', 'security', expect.objectContaining({
      tool_name: 'create_memo',
      reason_code: 'project_not_allowlisted',
      tool_source: 'builtin',
      outcome: 'denied',
      operator_reason: 'Deployment scope excludes the current project, so the runtime denied the tool before execution.',
      acl_boundary: expect.objectContaining({
        allowed_project_ids: ['project-2'],
        project_in_scope: false,
      }),
    }));
  });

  it('denies tool execution when the registry agent scope does not match the current agent', async () => {
    const auditLogger = vi.fn(async () => undefined);
    const engine = new AgentToolExecutionEngine(createSupabaseStub() as never, { auditLogger });

    const registry = await engine.loadRegistry('project-1', ['create_memo'], {
      agentId: 'agent-2',
    });
    const result = await engine.execute('create_memo', { title: 'hello', content: 'world' }, createContext(), registry);

    expect(result.payload).toEqual({
      source: 'builtin',
      duration_ms: 0,
      error: 'tool_acl_denied',
      reason_code: 'agent_scope_mismatch',
      reason: 'This tool is unavailable because the active registry does not belong to the current agent.',
      user_reason: 'This tool is unavailable because the active registry does not belong to the current agent.',
      next_action: 'Check the deployment/persona binding and regenerate the registry for the correct agent.',
    });
    expect(auditLogger).toHaveBeenCalledWith('agent_tool.acl_denied', 'security', expect.objectContaining({
      tool_name: 'create_memo',
      reason_code: 'agent_scope_mismatch',
      tool_source: 'builtin',
      outcome: 'denied',
      operator_reason: 'The effective tool registry was scoped to a different agent than the run owner.',
      acl_boundary: expect.objectContaining({ agent_id: 'agent-2' }),
    }));
  });

  it('denies allowlisted external tools when the project has no approved server mapping', async () => {
    const auditLogger = vi.fn(async () => undefined);
    const engine = new AgentToolExecutionEngine(createSupabaseStub() as never, { auditLogger });

    const registry = await engine.loadRegistry('project-1', allowlistedToolNames('external.search_docs'));
    const result = await engine.execute('external.search_docs', { query: 'agent runtime' }, createContext(), registry);

    expect(result.payload).toEqual({
      source: 'external',
      duration_ms: 0,
      error: 'tool_acl_denied',
      reason_code: 'project_tool_not_registered',
      reason: 'This tool is not approved for the current project.',
      user_reason: 'This tool is not approved for the current project.',
      next_action: 'Approve the MCP connection or add the tool to the project-level allowed_tools mapping.',
    });
    expect(auditLogger).toHaveBeenCalledWith('agent_tool.acl_denied', 'security', expect.objectContaining({
      tool_name: 'external.search_docs',
      reason_code: 'project_tool_not_registered',
      tool_source: 'external',
      outcome: 'denied',
      operator_reason: 'No approved MCP server mapping exists for this tool in the current project.',
    }));
  });

  it('fails closed when multiple approved external servers advertise the same tool name', async () => {
    listProjectApprovedMcpServerConfigsMock.mockResolvedValue([
      {
        kind: 'generic',
        name: 'Docs A',
        url: 'https://docs-a.example.com/rpc',
        allowed_tools: ['external.search_docs'],
      },
      {
        kind: 'generic',
        name: 'Docs B',
        url: 'https://docs-b.example.com/rpc',
        allowed_tools: ['external.search_docs'],
      },
    ]);

    const auditLogger = vi.fn(async () => undefined);
    const engine = new AgentToolExecutionEngine(createSupabaseStub() as never, { auditLogger });
    const registry = await engine.loadRegistry('project-1', allowlistedToolNames('external.search_docs'));
    const result = await engine.execute('external.search_docs', { query: 'agent runtime' }, createContext(), registry);

    expect(result.payload).toEqual({
      source: 'external',
      duration_ms: 0,
      error: 'tool_name mapped to multiple external MCP servers',
      user_reason: 'This tool could not run because multiple external servers matched the same tool name.',
      next_action: 'Narrow the project-approved MCP mappings so the tool name resolves to exactly one external server.',
    });
    expect(auditLogger).toHaveBeenCalledWith('agent_tool.ambiguous_external_mapping', 'security', expect.objectContaining({
      tool_name: 'external.search_docs',
      tool_source: 'external',
      outcome: 'failed',
      operator_reason: 'The project-approved MCP mapping is ambiguous because more than one external server advertises this tool name.',
      server_names: ['Docs A', 'Docs B'],
    }));
  });

  it('returns a timeout error when an approved external server does not answer within 10 seconds', async () => {
    process.env.MCP_TOKEN_DOCS = 'secret-token';
    process.env.MCP_ALLOWED_TOKEN_REFS = 'MCP_TOKEN_DOCS';
    listProjectApprovedMcpServerConfigsMock.mockResolvedValue([
      {
        kind: 'generic',
        name: 'Docs',
        url: 'https://mcp.example.com/rpc',
        allowed_tools: ['external.search_docs'],
        auth: { token_ref: 'MCP_TOKEN_DOCS' },
      },
    ]);

    const fetchFn = vi.fn((_input: RequestInfo | URL, init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')));
    }));

    vi.useFakeTimers();
    const auditLogger = vi.fn(async () => undefined);
    const engine = new AgentToolExecutionEngine(createSupabaseStub() as never, { fetchFn, auditLogger });

    const registry = await engine.loadRegistry('project-1', allowlistedToolNames('external.search_docs'));
    const executionPromise = engine.execute('external.search_docs', { query: 'slow' }, createContext(), registry);
    await vi.advanceTimersByTimeAsync(10_001);
    const result = await executionPromise;

    expect(result.payload).toEqual(expect.objectContaining({ error: 'external_mcp_timeout' }));
    expect(auditLogger).toHaveBeenCalledWith('agent_tool.external_failed', 'warn', expect.objectContaining({
      error: 'external_mcp_timeout',
      tool_source: 'external',
      outcome: 'failed',
    }));

    vi.useRealTimers();
    delete process.env.MCP_TOKEN_DOCS;
    delete process.env.MCP_ALLOWED_TOKEN_REFS;
  });

  it('loads the approved GitHub MCP toolset', async () => {
    listProjectApprovedMcpServerConfigsMock.mockResolvedValue([
      {
        kind: 'github',
        name: 'github',
        url: 'https://github-mcp.example.com/rpc',
        allowed_tools: [...GITHUB_MCP_TOOL_NAMES],
        auth: { token_ref: 'vault:mcp_connection:github', header_name: 'X-GitHub-Token', scheme: 'plain' },
      },
    ]);

    const engine = new AgentToolExecutionEngine(createSupabaseStub() as never);
    const registry = await engine.loadRegistry('project-1', allowlistedToolNames(...GITHUB_MCP_TOOL_NAMES));

    expect(registry.availableToolNames).toEqual(['create_memo', ...GITHUB_MCP_TOOL_NAMES]);
  });

  it('resolves approved MCP vault refs during external tool execution', async () => {
    resolveProjectMcpVaultTokenMock.mockResolvedValue('linear-secret');
    listProjectApprovedMcpServerConfigsMock.mockResolvedValue([
      {
        kind: 'generic',
        name: 'Linear',
        url: 'https://linear-mcp.example.com/rpc',
        allowed_tools: ['linear.search_issues'],
        auth: { token_ref: 'vault:mcp_connection:linear', header_name: 'Authorization', scheme: 'bearer' },
      },
    ]);

    const fetchFn = vi.fn(async () => new Response(JSON.stringify({
      jsonrpc: '2.0',
      id: '1',
      result: { content: [{ type: 'text', text: 'Linear search ok' }] },
    }), { status: 200, headers: { 'Content-Type': 'application/json' } }));

    const engine = new AgentToolExecutionEngine(createSupabaseStub() as never, { fetchFn });
    const registry = await engine.loadRegistry('project-1', allowlistedToolNames('linear.search_issues'));
    const result = await engine.execute('linear.search_issues', { query: 'S426' }, createContext(), registry);

    expect(resolveProjectMcpVaultTokenMock).toHaveBeenCalledWith({ tag: 'admin' }, 'project-1', 'vault:mcp_connection:linear');
    expect(fetchFn).toHaveBeenCalledWith('https://linear-mcp.example.com/rpc', expect.objectContaining({
      headers: expect.objectContaining({ Authorization: 'Bearer linear-secret' }),
    }));
    expect(result.payload).toEqual(expect.objectContaining({ tool_name: 'linear.search_issues' }));
  });

  it('calls the approved GitHub MCP gateway with X-GitHub-Token header injection', async () => {
    resolveProjectMcpVaultTokenMock.mockResolvedValue('gho_secret');
    listProjectApprovedMcpServerConfigsMock.mockResolvedValue([
      {
        kind: 'github',
        name: 'github',
        url: 'https://github-mcp.example.com/rpc',
        allowed_tools: [...GITHUB_MCP_TOOL_NAMES],
        auth: { token_ref: 'vault:mcp_connection:github', header_name: 'X-GitHub-Token', scheme: 'plain' },
      },
    ]);

    const fetchFn = vi.fn(async () => new Response(JSON.stringify({
      jsonrpc: '2.0',
      id: '1',
      result: { content: [{ type: 'text', text: 'Listed issues successfully' }] },
    }), { status: 200, headers: { 'Content-Type': 'application/json' } }));

    const engine = new AgentToolExecutionEngine(createSupabaseStub() as never, { fetchFn });
    const registry = await engine.loadRegistry('project-1', allowlistedToolNames('github.list_issues'));
    const result = await engine.execute('github.list_issues', {
      owner: 'moonklabs',
      repo: 'sprintable',
      state: 'open',
    }, createContext(), registry);

    expect(fetchFn).toHaveBeenCalledWith('https://github-mcp.example.com/rpc', expect.objectContaining({
      headers: expect.objectContaining({ 'X-GitHub-Token': 'gho_secret' }),
    }));
    expect(result.payload).toEqual(expect.objectContaining({
      source: 'external',
      server_name: 'github',
      tool_name: 'github.list_issues',
    }));
  });

  it('validates GitHub MCP tool arguments before the gateway call', async () => {
    resolveProjectMcpVaultTokenMock.mockResolvedValue('gho_secret');
    listProjectApprovedMcpServerConfigsMock.mockResolvedValue([
      {
        kind: 'github',
        name: 'github',
        url: 'https://github-mcp.example.com/rpc',
        allowed_tools: [...GITHUB_MCP_TOOL_NAMES],
        auth: { token_ref: 'vault:mcp_connection:github', header_name: 'X-GitHub-Token', scheme: 'plain' },
      },
    ]);

    const fetchFn = vi.fn();
    const engine = new AgentToolExecutionEngine(createSupabaseStub() as never, { fetchFn });

    const registry = await engine.loadRegistry('project-1', allowlistedToolNames('github.comment_issue'));
    const result = await engine.execute('github.comment_issue', {
      owner: 'moonklabs',
      repo: 'sprintable',
      body: 'missing number',
    }, createContext(), registry);

    expect(fetchFn).not.toHaveBeenCalled();
    expect(String(result.payload.error)).toContain('issue_number');
  });

  it('maps GitHub rate-limit errors into a stable runtime error', async () => {
    resolveProjectMcpVaultTokenMock.mockResolvedValue('gho_secret');
    listProjectApprovedMcpServerConfigsMock.mockResolvedValue([
      {
        kind: 'github',
        name: 'github',
        url: 'https://github-mcp.example.com/rpc',
        allowed_tools: [...GITHUB_MCP_TOOL_NAMES],
        auth: { token_ref: 'vault:mcp_connection:github', header_name: 'X-GitHub-Token', scheme: 'plain' },
      },
    ]);

    const fetchFn = vi.fn(async () => new Response(JSON.stringify({
      jsonrpc: '2.0',
      id: '1',
      error: { message: 'API rate limit exceeded' },
    }), { status: 429, headers: { 'Content-Type': 'application/json' } }));

    const engine = new AgentToolExecutionEngine(createSupabaseStub() as never, { fetchFn });
    const registry = await engine.loadRegistry('project-1', allowlistedToolNames('github.list_pull_requests'));
    const result = await engine.execute('github.list_pull_requests', {
      owner: 'moonklabs',
      repo: 'sprintable',
    }, createContext(), registry);

    expect(result.payload).toEqual(expect.objectContaining({ error: 'github_mcp_rate_limited' }));
  });

  it('maps GitHub permission and gateway errors into stable runtime errors', async () => {
    resolveProjectMcpVaultTokenMock.mockResolvedValue('gho_secret');
    listProjectApprovedMcpServerConfigsMock.mockResolvedValue([
      {
        kind: 'github',
        name: 'github',
        url: 'https://github-mcp.example.com/rpc',
        allowed_tools: [...GITHUB_MCP_TOOL_NAMES],
        auth: { token_ref: 'vault:mcp_connection:github', header_name: 'X-GitHub-Token', scheme: 'plain' },
      },
    ]);

    const permissionFetch = vi.fn(async () => new Response(JSON.stringify({
      jsonrpc: '2.0',
      id: '1',
      error: { message: 'Resource not accessible by integration' },
    }), { status: 403, headers: { 'Content-Type': 'application/json' } }));

    const gatewayFetch = vi.fn(async () => new Response('Bad gateway', { status: 502 }));

    const permissionEngine = new AgentToolExecutionEngine(createSupabaseStub() as never, { fetchFn: permissionFetch });
    const gatewayEngine = new AgentToolExecutionEngine(createSupabaseStub() as never, { fetchFn: gatewayFetch });

    const permissionRegistry = await permissionEngine.loadRegistry('project-1', allowlistedToolNames('github.merge_pull_request'));
    const gatewayRegistry = await gatewayEngine.loadRegistry('project-1', allowlistedToolNames('github.get_pull_request'));

    const permissionResult = await permissionEngine.execute('github.merge_pull_request', {
      owner: 'moonklabs',
      repo: 'sprintable',
      pull_number: 12,
    }, createContext(), permissionRegistry);
    const gatewayResult = await gatewayEngine.execute('github.get_pull_request', {
      owner: 'moonklabs',
      repo: 'sprintable',
      pull_number: 12,
    }, createContext(), gatewayRegistry);

    expect(permissionResult.payload).toEqual(expect.objectContaining({ error: 'github_mcp_permission_denied' }));
    expect(gatewayResult.payload).toEqual(expect.objectContaining({ error: 'github_mcp_gateway_unavailable' }));
  });
});
