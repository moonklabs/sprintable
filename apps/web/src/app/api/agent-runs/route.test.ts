import { beforeEach, describe, expect, it, vi } from 'vitest';

const { createSupabaseServerClient, getAuthContext, createSupabaseAdminClient } = vi.hoisted(() => ({
  createSupabaseServerClient: vi.fn(),
  getAuthContext: vi.fn(),
  createSupabaseAdminClient: vi.fn(),
}));

vi.mock('@/lib/supabase/server', () => ({ createSupabaseServerClient }));
vi.mock('@/lib/supabase/admin', () => ({ createSupabaseAdminClient }));
vi.mock('@/lib/auth-helpers', () => ({ getAuthContext }));

import { GET, POST } from './route';

function makeRun(overrides: Record<string, unknown> = {}) {
  return {
    id: 'run-1',
    org_id: 'org-1',
    project_id: 'project-alpha',
    agent_id: 'agent-1',
    trigger: 'story_status_changed',
    status: 'completed',
    retry_count: 0,
    max_retries: 3,
    next_retry_at: null,
    created_at: '2026-04-15T06:00:00Z',
    ...overrides,
  };
}

function createQueryStub(rows: Record<string, unknown>[]) {
  const q: Record<string, unknown> = {};
  const chain = () => q;
  q.select = vi.fn(chain);
  q.eq = vi.fn(chain);
  q.order = vi.fn(chain);
  q.limit = vi.fn(chain);
  q.insert = vi.fn(chain);
  q.update = vi.fn(chain);
  q.single = vi.fn(() =>
    Promise.resolve({
      data: rows[0] ?? null,
      error: rows[0] ? null : { code: 'PGRST116', message: 'not found' },
    }),
  );
  q.then = Promise.resolve({ data: rows, error: null }).then.bind(
    Promise.resolve({ data: rows, error: null }),
  );
  return q;
}

describe('POST /api/agent-runs', () => {
  beforeEach(() => {
    createSupabaseServerClient.mockReset();
    getAuthContext.mockReset();
    createSupabaseAdminClient.mockReset();
    getAuthContext.mockResolvedValue({
      id: 'agent-1',
      type: 'agent',
      rateLimitExceeded: false,
      rateLimitRemaining: 299,
      rateLimitResetAt: 0,
    });
  });

  it('creates agent run and returns 201', async () => {
    const memberData = { project_id: 'project-alpha', org_id: 'org-1' };
    const runData = makeRun();
    const adminSupabase = {
      from: vi.fn((table: string) => {
        if (table === 'team_members') return createQueryStub([memberData]);
        return createQueryStub([runData]);
      }),
    };
    createSupabaseAdminClient.mockReturnValue(adminSupabase);
    createSupabaseServerClient.mockResolvedValue({});

    const response = await POST(
      new Request('http://localhost/api/agent-runs', {
        method: 'POST',
        body: JSON.stringify({ agent_id: 'agent-1', trigger: 'story_status_changed', status: 'completed' }),
        headers: { 'Content-Type': 'application/json' },
      }),
    );

    expect(response.status).toBe(201);
    const body = await response.json();
    expect(body.data).toMatchObject({ id: 'run-1', status: 'completed' });
  });

  it('schedules retry when status is failed and retryCount < maxRetries', async () => {
    const memberData = { project_id: 'project-alpha', org_id: 'org-1' };
    const runData = makeRun({ status: 'failed', retry_count: 0, max_retries: 3 });
    let callCount = 0;
    const adminSupabase = {
      from: vi.fn((table: string) => {
        if (table === 'team_members') return createQueryStub([memberData]);
        callCount++;
        if (callCount === 1) return createQueryStub([runData]); // insert
        return createQueryStub([runData]); // update next_retry_at
      }),
    };
    createSupabaseAdminClient.mockReturnValue(adminSupabase);
    createSupabaseServerClient.mockResolvedValue({});

    const response = await POST(
      new Request('http://localhost/api/agent-runs', {
        method: 'POST',
        body: JSON.stringify({ agent_id: 'agent-1', trigger: 'test', status: 'failed', error_message: 'timeout' }),
        headers: { 'Content-Type': 'application/json' },
      }),
    );

    expect(response.status).toBe(201);
    const body = await response.json();
    expect(body.data).toMatchObject({ auto_retry_scheduled: true });
    expect(typeof body.data.next_retry_at).toBe('string');
  });

  it('returns 400 for missing required fields', async () => {
    createSupabaseServerClient.mockResolvedValue({});

    const response = await POST(
      new Request('http://localhost/api/agent-runs', {
        method: 'POST',
        body: JSON.stringify({ agent_id: 'agent-1' }),
        headers: { 'Content-Type': 'application/json' },
      }),
    );

    expect(response.status).toBe(400);
    const body = await response.json();
    expect(body.error.code).toBe('VALIDATION_FAILED');
  });

  it('returns 401 when not authenticated', async () => {
    createSupabaseServerClient.mockResolvedValue({});
    getAuthContext.mockResolvedValue(null);

    const response = await POST(
      new Request('http://localhost/api/agent-runs', {
        method: 'POST',
        body: JSON.stringify({ agent_id: 'agent-1', trigger: 'test' }),
        headers: { 'Content-Type': 'application/json' },
      }),
    );

    expect(response.status).toBe(401);
  });
});

describe('GET /api/agent-runs', () => {
  beforeEach(() => {
    createSupabaseServerClient.mockReset();
    getAuthContext.mockReset();
    createSupabaseAdminClient.mockReset();
    getAuthContext.mockResolvedValue({
      id: 'agent-1',
      type: 'agent',
      rateLimitExceeded: false,
      rateLimitRemaining: 299,
      rateLimitResetAt: 0,
    });
  });

  it('returns recent runs for project', async () => {
    const runs = [makeRun(), makeRun({ id: 'run-2' })];
    const adminSupabase = { from: vi.fn(() => createQueryStub(runs)) };
    createSupabaseAdminClient.mockReturnValue(adminSupabase);
    createSupabaseServerClient.mockResolvedValue({});

    const response = await GET(
      new Request('http://localhost/api/agent-runs?project_id=project-alpha'),
    );

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.data).toHaveLength(2);
  });

  it('returns 400 when project_id missing', async () => {
    createSupabaseServerClient.mockResolvedValue({});

    const response = await GET(new Request('http://localhost/api/agent-runs'));

    expect(response.status).toBe(400);
  });

  it('uses admin client for agent auth', async () => {
    const runs = [makeRun()];
    const adminSupabase = { from: vi.fn(() => createQueryStub(runs)) };
    createSupabaseAdminClient.mockReturnValue(adminSupabase);
    createSupabaseServerClient.mockResolvedValue({});

    await GET(new Request('http://localhost/api/agent-runs?project_id=project-alpha'));

    expect(createSupabaseAdminClient).toHaveBeenCalled();
  });
});
