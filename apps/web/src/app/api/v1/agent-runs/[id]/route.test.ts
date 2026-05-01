import { beforeEach, describe, expect, it, vi } from 'vitest';

const {
  createDbServerClient,
  getMyTeamMember,
  requireAgentOrchestration,
} = vi.hoisted(() => ({
  createDbServerClient: vi.fn(),
  getMyTeamMember: vi.fn(),
  requireAgentOrchestration: vi.fn(),
}));

vi.mock('@/lib/db/server', () => ({ createDbServerClient }));
vi.mock('@/lib/auth-helpers', async () => {
  const actual = await vi.importActual<typeof import('@/lib/auth-helpers')>('@/lib/auth-helpers');
  return { ...actual, getMyTeamMember };
});
vi.mock('@/lib/require-agent-orchestration', () => ({ requireAgentOrchestration }));

import { GET } from './route';

function createRunSingleStub(row: Record<string, unknown> | null) {
  const filters: Record<string, unknown> = {};
  const query = {
    select: vi.fn(() => query),
    eq: vi.fn((column: string, value: unknown) => {
      filters[column] = value;
      return query;
    }),
    single: vi.fn(async () => {
      if (!row) return { data: null, error: { code: 'PGRST116' } };
      const matches = Object.entries(filters).every(([key, value]) => row[key] === value);
      return matches ? { data: row, error: null } : { data: null, error: { code: 'PGRST116' } };
    }),
  };
  return query;
}

function createAuditListStub(rows: Array<Record<string, unknown>>) {
  const filters: Record<string, unknown> = {};
  let limitCount: number | null = null;
  const query = {
    select: vi.fn(() => query),
    eq: vi.fn((column: string, value: unknown) => {
      filters[column] = value;
      return query;
    }),
    order: vi.fn(() => query),
    limit: vi.fn((count: number) => {
      limitCount = count;
      return query;
    }),
    then(resolve: (value: { data: Array<Record<string, unknown>>; error: null }) => unknown) {
      const scoped = rows.filter((row) => Object.entries(filters).every(([key, value]) => row[key] === value));
      const data = limitCount == null ? scoped : scoped.slice(0, limitCount);
      return Promise.resolve({ data, error: null }).then(resolve);
    },
  };
  return query;
}

describe('GET /api/v1/agent-runs/[id]', () => {
  beforeEach(() => {
    createDbServerClient.mockReset();
    getMyTeamMember.mockReset();
    requireAgentOrchestration.mockReset();

    getMyTeamMember.mockResolvedValue({ id: 'member-1', org_id: 'org-1', project_id: 'project-1' });
    requireAgentOrchestration.mockResolvedValue(null);
  });

  it('blocks run detail reads when upgrade is required', async () => {
    createDbServerClient.mockResolvedValue({
      auth: { getUser: vi.fn().mockResolvedValue({ data: { user: { id: 'user-1' } } }) },
      from: vi.fn(),
    });
    requireAgentOrchestration.mockResolvedValue(new Response(JSON.stringify({
      code: 'UPGRADE_REQUIRED',
      error: { code: 'UPGRADE_REQUIRED', message: 'Upgrade required' },
    }), { status: 403, headers: { 'Content-Type': 'application/json' } }));

    const response = await GET(new Request('http://localhost/api/v1/agent-runs/run-1'), {
      params: Promise.resolve({ id: 'run-1' }),
    });

    expect(response.status).toBe(403);
  });

  it('returns a scoped run detail with tool audit trail when orchestration is enabled', async () => {
    const run = {
      id: 'run-1',
      org_id: 'org-1',
      project_id: 'project-1',
      agent_id: 'agent-1',
      session_id: 'session-1',
      model: 'gpt-5',
      llm_provider: 'managed',
      llm_provider_key: 'openai',
      computed_cost_cents: 12,
      billing_notes: ['managed_pricing_missing'],
      status: 'completed',
      result_summary: 'done',
      memory_diagnostics: {
        session: { queriedCount: 2, inScopeCount: 1, blockedCount: 1, injectedIds: ['sm-1'] },
        longTerm: { queriedCount: 1, inScopeCount: 1, blockedCount: 0, injectedIds: ['lm-1'] },
        totalInjected: 2,
        droppedByTokenBudget: 1,
      },
      restored_memory_count: 1,
    };
    const auditRows = [
      {
        id: 'audit-1',
        org_id: 'org-1',
        project_id: 'project-1',
        run_id: 'run-1',
        session_id: 'session-1',
        event_type: 'agent_tool.acl_denied',
        severity: 'security',
        summary: 'tool external.search_docs denied before execution',
        created_by: 'agent-1',
        created_at: '2026-04-12T03:00:00.000Z',
        payload: {
          tool_name: 'external.search_docs',
          outcome: 'denied',
          user_reason: 'This tool is not available in the current persona allowlist.',
          operator_reason: 'The tool name is missing from the effective persona/deployment allowlist.',
          next_action: 'Use an allowlisted tool or update the persona allowlist before retrying.',
          reason_code: 'tool_not_allowlisted',
        },
      },
      {
        id: 'audit-2',
        org_id: 'org-1',
        project_id: 'project-1',
        run_id: 'run-1',
        session_id: 'session-1',
        event_type: 'agent_tool.executed',
        severity: 'info',
        summary: 'builtin tool create_memo executed',
        created_by: 'agent-1',
        created_at: '2026-04-12T02:59:00.000Z',
        payload: {
          tool_name: 'create_memo',
          tool_source: 'builtin',
          outcome: 'allowed',
        },
      },
      {
        id: 'audit-3',
        org_id: 'org-1',
        project_id: 'project-1',
        run_id: 'run-1',
        session_id: 'session-1',
        event_type: 'agent_execution.failed',
        severity: 'error',
        summary: 'should be filtered out',
        created_by: 'agent-1',
        created_at: '2026-04-12T02:58:00.000Z',
        payload: {},
      },
    ];

    createDbServerClient.mockResolvedValue({
      auth: { getUser: vi.fn().mockResolvedValue({ data: { user: { id: 'user-1' } } }) },
      from: vi.fn((table: string) => {
        if (table === 'agent_runs') return createRunSingleStub(run);
        if (table === 'agent_audit_logs') return createAuditListStub(auditRows);
        if (table === 'team_members') {
          const membersQuery = {
            select: vi.fn(() => membersQuery),
            eq: vi.fn(() => membersQuery),
            single: vi.fn(async () => ({ data: { name: 'Didi' }, error: null })),
          };
          return membersQuery;
        }
        if (table === 'agent_sessions') {
          const sessionQuery = {
            select: vi.fn(() => sessionQuery),
            eq: vi.fn(() => sessionQuery),
            single: vi.fn(async () => ({ data: { context_snapshot: { memories: [{ content: 'Scoped memory' }] } }, error: null })),
          };
          return sessionQuery;
        }
        throw new Error(`Unexpected table: ${table}`);
      }),
    });

    const response = await GET(new Request('http://localhost/api/v1/agent-runs/run-1'), {
      params: Promise.resolve({ id: 'run-1' }),
    });

    expect(response.status).toBe(200);
    expect(requireAgentOrchestration).toHaveBeenCalledWith(expect.anything(), 'org-1');
    const body = await response.json();
    expect(body.data).toMatchObject({
      id: 'run-1',
      agent_name: 'Didi',
      status: 'completed',
      session_id: 'session-1',
      model: 'gpt-5',
      llm_provider: 'managed',
      llm_provider_key: 'openai',
      computed_cost_cents: 12,
      billing_notes: ['managed_pricing_missing'],
    });
    expect(body.data.tool_audit_trail).toEqual([
      expect.objectContaining({
        id: 'audit-1',
        event_type: 'agent_tool.acl_denied',
        actor_name: 'Didi',
        payload: expect.objectContaining({
          tool_name: 'external.search_docs',
          operator_reason: 'The tool name is missing from the effective persona/deployment allowlist.',
        }),
      }),
      expect.objectContaining({
        id: 'audit-2',
        event_type: 'agent_tool.executed',
        actor_name: 'Didi',
      }),
    ]);
    expect(body.data.continuity_debug).toEqual({
      sessionId: 'session-1',
      snapshotPresent: true,
      snapshotMemoryCount: 1,
      restoredFromSnapshot: true,
      memoryRetrievalDiagnostics: {
        session: { queriedCount: 2, inScopeCount: 1, blockedCount: 1, injectedIds: ['sm-1'] },
        longTerm: { queriedCount: 1, inScopeCount: 1, blockedCount: 0, injectedIds: ['lm-1'] },
        totalInjected: 2,
        droppedByTokenBudget: 1,
      },
    });
    expect(body.data.memory_compaction_policy).toEqual(expect.objectContaining({
      keepCriteria: expect.arrayContaining(['Keep memories with importance >= 20.']),
      deleteCriteria: expect.arrayContaining(['Delete lower-ranked memories once the per-type quota is exceeded.']),
    }));
  });
});
