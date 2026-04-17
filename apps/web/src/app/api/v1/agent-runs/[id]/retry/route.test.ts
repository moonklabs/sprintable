import { beforeEach, describe, expect, it, vi } from 'vitest';

const {
  createSupabaseServerClient,
  getMyTeamMember,
  requireOrgAdmin,
  requireAgentOrchestration,
  executeRetry,
} = vi.hoisted(() => ({
  createSupabaseServerClient: vi.fn(),
  getMyTeamMember: vi.fn(),
  requireOrgAdmin: vi.fn(),
  requireAgentOrchestration: vi.fn(),
  executeRetry: vi.fn(),
}));

vi.mock('@/lib/supabase/server', () => ({ createSupabaseServerClient }));
vi.mock('@/lib/auth-helpers', async () => {
  const actual = await vi.importActual<typeof import('@/lib/auth-helpers')>('@/lib/auth-helpers');
  return { ...actual, getMyTeamMember };
});
vi.mock('@/lib/admin-check', () => ({ requireOrgAdmin }));
vi.mock('@/lib/require-agent-orchestration', () => ({ requireAgentOrchestration }));
vi.mock('@/services/agent-retry', async () => {
  const actual = await vi.importActual<typeof import('@/services/agent-retry')>('@/services/agent-retry');
  return {
    ...actual,
    AgentRetryService: class {
      executeRetry = executeRetry;
    },
  };
});

import { POST } from './route';

function createRunLookupStub(run: Record<string, unknown> | null) {
  const filters: Record<string, unknown> = {};
  const query = {
    select: vi.fn(() => query),
    eq: vi.fn((column: string, value: unknown) => {
      filters[column] = value;
      return query;
    }),
    single: vi.fn(async () => {
      if (!run) return { data: null, error: { code: 'PGRST116' } };
      const matches = Object.entries(filters).every(([key, value]) => run[key] === value);
      return matches ? { data: run, error: null } : { data: null, error: { code: 'PGRST116' } };
    }),
  };
  return query;
}

describe('POST /api/v1/agent-runs/[id]/retry', () => {
  beforeEach(() => {
    createSupabaseServerClient.mockReset();
    getMyTeamMember.mockReset();
    requireOrgAdmin.mockReset();
    requireAgentOrchestration.mockReset();
    executeRetry.mockReset();

    getMyTeamMember.mockResolvedValue({ id: 'member-1', org_id: 'org-1', project_id: 'project-1' });
    requireOrgAdmin.mockResolvedValue(undefined);
    requireAgentOrchestration.mockResolvedValue(null);
  });

  it('blocks retry bypass when upgrade is required', async () => {
    createSupabaseServerClient.mockResolvedValue({
      auth: { getUser: vi.fn().mockResolvedValue({ data: { user: { id: 'user-1' } } }) },
      from: vi.fn(),
    });
    requireAgentOrchestration.mockResolvedValue(new Response(JSON.stringify({
      code: 'UPGRADE_REQUIRED',
      error: { code: 'UPGRADE_REQUIRED', message: 'Upgrade required' },
    }), { status: 403, headers: { 'Content-Type': 'application/json' } }));

    const response = await POST(new Request('http://localhost/api/v1/agent-runs/run-1/retry', {
      method: 'POST',
    }), { params: Promise.resolve({ id: 'run-1' }) });

    expect(response.status).toBe(403);
    expect(executeRetry).not.toHaveBeenCalled();
  });

  it('blocks duplicate manual retry when a retry is already scheduled or launched', async () => {
    createSupabaseServerClient.mockResolvedValue({
      auth: { getUser: vi.fn().mockResolvedValue({ data: { user: { id: 'user-1' } } }) },
      from: vi.fn((table: string) => {
        if (table === 'agent_runs') {
          return createRunLookupStub({
            id: 'run-1',
            status: 'failed',
            org_id: 'org-1',
            project_id: 'project-1',
            failure_disposition: 'retry_launched',
            retry_count: 1,
            max_retries: 3,
            next_retry_at: null,
            last_error_code: 'external_mcp_timeout',
            error_message: 'request timeout',
          });
        }
        throw new Error(`Unexpected table: ${table}`);
      }),
    });

    const response = await POST(new Request('http://localhost/api/v1/agent-runs/run-1/retry', {
      method: 'POST',
    }), { params: Promise.resolve({ id: 'run-1' }) });

    expect(response.status).toBe(400);
    expect(executeRetry).not.toHaveBeenCalled();
  });

  it('blocks manual retry for non-retryable failures', async () => {
    createSupabaseServerClient.mockResolvedValue({
      auth: { getUser: vi.fn().mockResolvedValue({ data: { user: { id: 'user-1' } } }) },
      from: vi.fn((table: string) => {
        if (table === 'agent_runs') {
          return createRunLookupStub({
            id: 'run-1',
            status: 'failed',
            org_id: 'org-1',
            project_id: 'project-1',
            failure_disposition: 'non_retryable',
            retry_count: 0,
            max_retries: 3,
            next_retry_at: null,
            last_error_code: 'billing_daily_cap_exceeded',
            error_message: 'daily cap exceeded',
          });
        }
        throw new Error(`Unexpected table: ${table}`);
      }),
    });

    const response = await POST(new Request('http://localhost/api/v1/agent-runs/run-1/retry', {
      method: 'POST',
    }), { params: Promise.resolve({ id: 'run-1' }) });

    expect(response.status).toBe(400);
    expect(executeRetry).not.toHaveBeenCalled();
  });

  it('retries a failed run within the current org/project scope', async () => {
    createSupabaseServerClient.mockResolvedValue({
      auth: { getUser: vi.fn().mockResolvedValue({ data: { user: { id: 'user-1' } } }) },
      from: vi.fn((table: string) => {
        if (table === 'agent_runs') {
          return createRunLookupStub({
            id: 'run-1',
            status: 'failed',
            org_id: 'org-1',
            project_id: 'project-1',
            failure_disposition: 'retry_exhausted',
            retry_count: 3,
            max_retries: 3,
            next_retry_at: null,
            last_error_code: 'external_mcp_timeout',
            error_message: 'request timeout',
          });
        }
        throw new Error(`Unexpected table: ${table}`);
      }),
    });
    executeRetry.mockResolvedValue({ run: { id: 'run-2', status: 'queued' } });

    const response = await POST(new Request('http://localhost/api/v1/agent-runs/run-1/retry', {
      method: 'POST',
    }), { params: Promise.resolve({ id: 'run-1' }) });

    expect(response.status).toBe(202);
    expect(requireAgentOrchestration).toHaveBeenCalledWith(expect.anything(), 'org-1');
    expect(executeRetry).toHaveBeenCalledWith('run-1');
  });
});
