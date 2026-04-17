import { beforeEach, describe, expect, it, vi } from 'vitest';

const { createSupabaseServerClient, getMyTeamMember, requireAgentOrchestration } = vi.hoisted(() => ({
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

function createQueryStub(rows: Array<Record<string, unknown>>) {
  const filters: Array<{ kind: 'eq' | 'in'; column: string; value: unknown }> = [];
  const query = {
    select: vi.fn(() => query),
    eq: vi.fn((column: string, value: unknown) => {
      filters.push({ kind: 'eq', column, value });
      return query;
    }),
    in: vi.fn((column: string, value: unknown[]) => {
      filters.push({ kind: 'in', column, value });
      return query;
    }),
    order: vi.fn(() => query),
    then: (resolve: (value: { data: Array<Record<string, unknown>>; error: null }) => void) => {
      const filtered = rows.filter((row) => filters.every((filter) => {
        const current = row[filter.column];
        if (filter.kind === 'eq') return current === filter.value;
        return Array.isArray(filter.value) && filter.value.includes(current);
      }));
      return Promise.resolve({ data: filtered, error: null }).then(resolve);
    },
  };

  return query;
}

describe('GET /api/v1/hitl-requests', () => {
  beforeEach(() => {
    createSupabaseServerClient.mockReset();
    getMyTeamMember.mockReset();
    requireAgentOrchestration.mockReset();
    requireAgentOrchestration.mockResolvedValue(null);
  });

  it('blocks HITL inbox reads when upgrade is required', async () => {
    createSupabaseServerClient.mockResolvedValue({
      auth: {
        getUser: vi.fn().mockResolvedValue({ data: { user: { id: 'user-1' } } }),
      },
      from: vi.fn(),
    });
    getMyTeamMember.mockResolvedValue({ id: 'human-1', org_id: 'org-1', project_id: 'project-1' });
    requireAgentOrchestration.mockResolvedValue(new Response(JSON.stringify({
      code: 'UPGRADE_REQUIRED',
      error: { code: 'UPGRADE_REQUIRED', message: 'Upgrade required' },
    }), { status: 403, headers: { 'Content-Type': 'application/json' } }));

    const response = await GET(new Request('http://localhost/api/v1/hitl-requests?status=pending'));

    expect(response.status).toBe(403);
  });

  it('returns pending HITL requests scoped to the current human member', async () => {
    const hitlRows = [
      {
        id: 'hitl-1',
        org_id: 'org-1',
        project_id: 'project-1',
        agent_id: 'agent-1',
        session_id: 'session-1',
        run_id: 'run-1',
        request_type: 'input',
        title: 'Need approval',
        prompt: 'Please confirm',
        requested_for: 'human-1',
        status: 'pending',
        response_text: null,
        responded_by: null,
        responded_at: null,
        expires_at: null,
        metadata: { memo_id: 'memo-1', hitl_memo_id: 'memo-hitl-1' },
        created_at: '2026-04-08T08:20:00.000Z',
        updated_at: '2026-04-08T08:20:00.000Z',
      },
      {
        id: 'hitl-2',
        org_id: 'org-1',
        project_id: 'project-1',
        agent_id: 'agent-2',
        session_id: 'session-2',
        run_id: 'run-2',
        request_type: 'approval',
        title: 'Different recipient',
        prompt: 'Skip me',
        requested_for: 'human-2',
        status: 'pending',
        response_text: null,
        responded_by: null,
        responded_at: null,
        expires_at: null,
        metadata: {},
        created_at: '2026-04-08T08:21:00.000Z',
        updated_at: '2026-04-08T08:21:00.000Z',
      },
      {
        id: 'hitl-3',
        org_id: 'org-1',
        project_id: 'project-1',
        agent_id: 'agent-1',
        session_id: 'session-3',
        run_id: 'run-3',
        request_type: 'approval',
        title: 'Resolved request',
        prompt: 'Done already',
        requested_for: 'human-1',
        status: 'resolved',
        response_text: 'approved',
        responded_by: 'human-1',
        responded_at: '2026-04-08T08:22:00.000Z',
        expires_at: null,
        metadata: {},
        created_at: '2026-04-08T08:21:30.000Z',
        updated_at: '2026-04-08T08:22:00.000Z',
      },
    ];

    const members = [
      { id: 'agent-1', name: 'Didi' },
      { id: 'human-1', name: 'Ortega' },
    ];

    createSupabaseServerClient.mockResolvedValue({
      auth: {
        getUser: vi.fn().mockResolvedValue({ data: { user: { id: 'user-1' } } }),
      },
      from: vi.fn((table: string) => {
        if (table === 'agent_hitl_requests') return createQueryStub(hitlRows);
        if (table === 'team_members') return createQueryStub(members);
        throw new Error(`Unexpected table: ${table}`);
      }),
    });
    getMyTeamMember.mockResolvedValue({ id: 'human-1', org_id: 'org-1', project_id: 'project-1' });

    const response = await GET(new Request('http://localhost/api/v1/hitl-requests?status=pending'));

    expect(response.status).toBe(200);
    expect(requireAgentOrchestration).toHaveBeenCalledWith(expect.anything(), 'org-1');
    const body = await response.json();
    expect(body.data).toHaveLength(1);
    expect(body.data[0]).toMatchObject({
      id: 'hitl-1',
      status: 'pending',
      source_memo_id: 'memo-1',
      hitl_memo_id: 'memo-hitl-1',
      agent_name: 'Didi',
      requested_for_name: 'Ortega',
    });
  });

  it('returns unauthorized when no auth user exists', async () => {
    createSupabaseServerClient.mockResolvedValue({
      auth: {
        getUser: vi.fn().mockResolvedValue({ data: { user: null } }),
      },
    });

    const response = await GET(new Request('http://localhost/api/v1/hitl-requests?status=pending'));

    expect(response.status).toBe(401);
  });
});
