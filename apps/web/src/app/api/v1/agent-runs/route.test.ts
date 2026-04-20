import { beforeEach, describe, expect, it, vi } from 'vitest';

const {
  createSupabaseServerClient,
  getMyTeamMember,
  requireAgentOrchestration,
} = vi.hoisted(() => ({
  createSupabaseServerClient: vi.fn(),
  getMyTeamMember: vi.fn(),
  requireAgentOrchestration: vi.fn(),
}));

vi.mock('@/lib/supabase/server', () => ({ createSupabaseServerClient }));
vi.mock('@/lib/auth-helpers', async () => {
  const actual = await vi.importActual<typeof import('@/lib/auth-helpers')>('@/lib/auth-helpers');
  return { ...actual, getMyTeamMember };
});
vi.mock('@/lib/require-agent-orchestration', () => ({ requireAgentOrchestration }));

import { GET } from './route';

function createRunQueryStub(rows: Array<Record<string, unknown>>) {
  const filters: Record<string, unknown> = {};
  let limitValue = 0;

  const query = {
    select: vi.fn(() => query),
    eq: vi.fn((column: string, value: unknown) => {
      filters[column] = value;
      return query;
    }),
    order: vi.fn(() => query),
    limit: vi.fn((value: number) => {
      limitValue = value;
      return query;
    }),
    gte: vi.fn((column: string, value: unknown) => {
      filters[`gte:${column}`] = value;
      return query;
    }),
    lte: vi.fn((column: string, value: unknown) => {
      filters[`lte:${column}`] = value;
      return query;
    }),
    lt: vi.fn((column: string, value: unknown) => {
      filters[`lt:${column}`] = value;
      return query;
    }),
    then: (resolve: (value: { data: Array<Record<string, unknown>>; error: null }) => void) => {
      const filtered = rows.filter((row) => {
        return Object.entries(filters).every(([key, value]) => {
          if (key.startsWith('gte:')) return String(row[key.slice(4)] ?? '') >= String(value ?? '');
          if (key.startsWith('lte:')) return String(row[key.slice(4)] ?? '') <= String(value ?? '');
          if (key.startsWith('lt:')) return String(row[key.slice(3)] ?? '') < String(value ?? '');
          return row[key] === value;
        });
      });
      return Promise.resolve({ data: limitValue > 0 ? filtered.slice(0, limitValue) : filtered, error: null }).then(resolve);
    },
  };

  return query;
}

function createMembersQueryStub(rows: Array<Record<string, unknown>>) {
  const ids: string[] = [];

  const query = {
    select: vi.fn(() => query),
    in: vi.fn((_column: string, values: string[]) => {
      ids.splice(0, ids.length, ...values);
      return query;
    }),
    then: (resolve: (value: { data: Array<Record<string, unknown>>; error: null }) => void) => {
      const filtered = rows.filter((row) => ids.includes(String(row.id)));
      return Promise.resolve({ data: filtered, error: null }).then(resolve);
    },
  };

  return query;
}

describe('GET /api/v1/agent-runs', () => {
  beforeEach(() => {
    createSupabaseServerClient.mockReset();
    getMyTeamMember.mockReset();
    requireAgentOrchestration.mockReset();

    getMyTeamMember.mockResolvedValue({ id: 'member-1', org_id: 'org-1', project_id: 'project-1' });
    requireAgentOrchestration.mockResolvedValue(null);
  });

  it('blocks run history reads when upgrade is required', async () => {
    createSupabaseServerClient.mockResolvedValue({
      auth: { getUser: vi.fn().mockResolvedValue({ data: { user: { id: 'user-1' } } }) },
      from: vi.fn(),
    });
    requireAgentOrchestration.mockResolvedValue(new Response(JSON.stringify({
      code: 'UPGRADE_REQUIRED',
      error: { code: 'UPGRADE_REQUIRED', message: 'Upgrade required' },
    }), { status: 403, headers: { 'Content-Type': 'application/json' } }));

    const response = await GET(new Request('http://localhost/api/v1/agent-runs'));

    expect(response.status).toBe(403);
  });

  it('returns scoped run history with agent names when orchestration is enabled', async () => {
    const runRows = [
      {
        id: 'run-1',
        org_id: 'org-1',
        project_id: 'project-1',
        agent_id: 'agent-1',
        deployment_id: 'dep-1',
        session_id: 'session-1',
        memo_id: 'memo-1',
        story_id: null,
        trigger: 'manual',
        model: 'gpt-5',
        llm_provider: 'managed',
        llm_provider_key: 'openai',
        status: 'completed',
        duration_ms: 1200,
        llm_call_count: 2,
        input_tokens: 10,
        output_tokens: 30,
        cost_usd: 0.12,
        computed_cost_cents: 12,
        per_run_cap_cents: 100,
        billing_notes: ['managed_pricing_missing'],
        result_summary: 'done',
        last_error_code: null,
        started_at: '2026-04-11T00:00:00.000Z',
        finished_at: '2026-04-11T00:01:00.000Z',
        created_at: '2026-04-11T00:00:00.000Z',
      },
    ];
    const memberRows = [{ id: 'agent-1', name: 'Didi' }];

    createSupabaseServerClient.mockResolvedValue({
      auth: { getUser: vi.fn().mockResolvedValue({ data: { user: { id: 'user-1' } } }) },
      from: vi.fn((table: string) => {
        if (table === 'agent_runs') return createRunQueryStub(runRows);
        if (table === 'team_members') return createMembersQueryStub(memberRows);
        throw new Error(`Unexpected table: ${table}`);
      }),
    });

    const response = await GET(new Request('http://localhost/api/v1/agent-runs?status=completed&limit=5&from=2026-04-01T00:00:00.000Z'));

    expect(response.status).toBe(200);
    expect(requireAgentOrchestration).toHaveBeenCalledWith(expect.anything(), 'org-1');
    const body = await response.json();
    expect(body.data).toHaveLength(1);
    expect(body.data[0]).toMatchObject({
      id: 'run-1',
      agent_name: 'Didi',
      status: 'completed',
      session_id: 'session-1',
      llm_provider: 'managed',
      llm_provider_key: 'openai',
      computed_cost_cents: 12,
      billing_notes: ['managed_pricing_missing'],
    });
  });
});
