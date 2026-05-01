import { beforeEach, describe, expect, it, vi } from 'vitest';

const { createDbServerClient, getAuthContext, createAdminClient } = vi.hoisted(() => ({
  createDbServerClient: vi.fn(),
  getAuthContext: vi.fn(),
  createAdminClient: vi.fn(),
}));

vi.mock('@/lib/db/server', () => ({ createDbServerClient }));
vi.mock('@/lib/db/admin', () => ({ createAdminClient }));
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
    createDbServerClient.mockReset();
    getAuthContext.mockReset();
    createAdminClient.mockReset();
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
    const adminDb = {
      from: vi.fn((table: string) => {
        if (table === 'team_members') return createQueryStub([memberData]);
        return createQueryStub([runData]);
      }),
    };
    createAdminClient.mockReturnValue(adminDb);
    createDbServerClient.mockResolvedValue({});

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
    const adminDb = {
      from: vi.fn((table: string) => {
        if (table === 'team_members') return createQueryStub([memberData]);
        callCount++;
        if (callCount === 1) return createQueryStub([runData]); // insert
        return createQueryStub([runData]); // update next_retry_at
      }),
    };
    createAdminClient.mockReturnValue(adminDb);
    createDbServerClient.mockResolvedValue({});

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
    createDbServerClient.mockResolvedValue({});

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
    createDbServerClient.mockResolvedValue({});
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
    createDbServerClient.mockReset();
    getAuthContext.mockReset();
    createAdminClient.mockReset();
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
    const adminDb = { from: vi.fn(() => createQueryStub(runs)) };
    createAdminClient.mockReturnValue(adminDb);
    createDbServerClient.mockResolvedValue({});

    const response = await GET(
      new Request('http://localhost/api/agent-runs?project_id=project-alpha'),
    );

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.data).toHaveLength(2);
  });

  it('returns 400 when project_id missing', async () => {
    createDbServerClient.mockResolvedValue({});

    const response = await GET(new Request('http://localhost/api/agent-runs'));

    expect(response.status).toBe(400);
  });

  it('uses admin client for agent auth', async () => {
    const runs = [makeRun()];
    const adminDb = { from: vi.fn(() => createQueryStub(runs)) };
    createAdminClient.mockReturnValue(adminDb);
    createDbServerClient.mockResolvedValue({});

    await GET(new Request('http://localhost/api/agent-runs?project_id=project-alpha'));

    expect(createAdminClient).toHaveBeenCalled();
  });
});
