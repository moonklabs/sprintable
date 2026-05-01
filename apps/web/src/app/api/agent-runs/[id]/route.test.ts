import { beforeEach, describe, expect, it, vi } from 'vitest';

const { createDbServerClient, getAuthContext, createAdminClient } = vi.hoisted(() => ({
  createDbServerClient: vi.fn(),
  getAuthContext: vi.fn(),
  createAdminClient: vi.fn(),
}));

vi.mock('@/lib/db/server', () => ({ createDbServerClient }));
vi.mock('@/lib/db/admin', () => ({ createAdminClient }));
vi.mock('@/lib/auth-helpers', () => ({ getAuthContext }));

import { PATCH } from './route';

function makeRun(overrides: Record<string, unknown> = {}) {
  return {
    id: 'run-1',
    org_id: 'org-1',
    project_id: 'project-alpha',
    agent_id: 'agent-1',
    trigger: 'story_status_changed',
    status: 'running',
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

describe('PATCH /api/agent-runs/[id]', () => {
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

  it('updates run status to completed', async () => {
    const existingRun = makeRun({ org_id: 'org-1', project_id: 'project-alpha' });
    const updatedRun = makeRun({ status: 'completed' });
    let callCount = 0;
    const adminDb = {
      from: vi.fn(() => {
        callCount++;
        return createQueryStub(callCount === 1 ? [existingRun] : [updatedRun]);
      }),
    };
    createAdminClient.mockReturnValue(adminDb);
    createDbServerClient.mockResolvedValue({});

    const response = await PATCH(
      new Request('http://localhost/api/agent-runs/run-1', {
        method: 'PATCH',
        body: JSON.stringify({ status: 'completed', result_summary: 'Done' }),
        headers: { 'Content-Type': 'application/json' },
      }),
      { params: Promise.resolve({ id: 'run-1' }) },
    );

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.data).toMatchObject({ status: 'completed' });
  });

  it('schedules retry when updated to failed with retries remaining', async () => {
    const existingRun = makeRun({ org_id: 'org-1', project_id: 'project-alpha' });
    const updatedRun = makeRun({ status: 'failed', retry_count: 1, max_retries: 3 });
    let callCount = 0;
    const adminDb = {
      from: vi.fn(() => {
        callCount++;
        if (callCount === 1) return createQueryStub([existingRun]); // fetch existing
        if (callCount === 2) return createQueryStub([updatedRun]); // update status
        return createQueryStub([updatedRun]); // update next_retry_at
      }),
    };
    createAdminClient.mockReturnValue(adminDb);
    createDbServerClient.mockResolvedValue({});

    const response = await PATCH(
      new Request('http://localhost/api/agent-runs/run-1', {
        method: 'PATCH',
        body: JSON.stringify({ status: 'failed', error_message: 'timeout' }),
        headers: { 'Content-Type': 'application/json' },
      }),
      { params: Promise.resolve({ id: 'run-1' }) },
    );

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.data).toMatchObject({ auto_retry_scheduled: true });
  });

  it('returns 400 for missing status', async () => {
    createDbServerClient.mockResolvedValue({});
    const adminDb = { from: vi.fn(() => createQueryStub([makeRun()])) };
    createAdminClient.mockReturnValue(adminDb);

    const response = await PATCH(
      new Request('http://localhost/api/agent-runs/run-1', {
        method: 'PATCH',
        body: JSON.stringify({ result_summary: 'No status' }),
        headers: { 'Content-Type': 'application/json' },
      }),
      { params: Promise.resolve({ id: 'run-1' }) },
    );

    expect(response.status).toBe(400);
    const body = await response.json();
    expect(body.error.code).toBe('VALIDATION_FAILED');
  });

  it('returns 401 when not authenticated', async () => {
    createDbServerClient.mockResolvedValue({});
    getAuthContext.mockResolvedValue(null);

    const response = await PATCH(
      new Request('http://localhost/api/agent-runs/run-1', {
        method: 'PATCH',
        body: JSON.stringify({ status: 'completed' }),
        headers: { 'Content-Type': 'application/json' },
      }),
      { params: Promise.resolve({ id: 'run-1' }) },
    );

    expect(response.status).toBe(401);
  });
});
