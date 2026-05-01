import { beforeEach, describe, expect, it, vi } from 'vitest';

const { createDbServerClient, getAuthContext, createAdminClient } = vi.hoisted(() => ({
  createDbServerClient: vi.fn(),
  getAuthContext: vi.fn(),
  createAdminClient: vi.fn(),
}));

vi.mock('@/lib/db/server', () => ({ createDbServerClient }));
vi.mock('@/lib/db/admin', () => ({ createAdminClient }));
vi.mock('@/lib/auth-helpers', () => ({ getAuthContext }));

import { GET } from './route';

function makeAgent() {
  return { id: 'agent-1', type: 'agent', rateLimitExceeded: false, rateLimitRemaining: 299, rateLimitResetAt: 0 };
}

function createQueryStub(rows: Record<string, unknown>[] = [], opts: { singleNull?: boolean } = {}) {
  const q: Record<string, unknown> = {};
  const chain = () => q;
  q.select = vi.fn(chain);
  q.eq = vi.fn(chain);
  q.is = vi.fn(chain);
  q.neq = vi.fn(chain);
  q.single = vi.fn(() =>
    opts.singleNull
      ? Promise.resolve({ data: null, error: { code: 'PGRST116', message: 'not found' } })
      : Promise.resolve({ data: rows[0] ?? null, error: null }),
  );
  q.then = Promise.resolve({ data: rows, error: null }).then.bind(Promise.resolve({ data: rows, error: null }));
  return q;
}

describe('GET /api/analytics/health', () => {
  beforeEach(() => {
    createDbServerClient.mockReset();
    getAuthContext.mockReset();
    createAdminClient.mockReset();
    getAuthContext.mockResolvedValue(makeAgent());
  });

  it('returns 400 when project_id missing', async () => {
    const db = { from: vi.fn(() => createQueryStub()) };
    createDbServerClient.mockResolvedValue(db);
    createAdminClient.mockReturnValue(db);

    const response = await GET(new Request('http://localhost/api/analytics/health'));

    expect(response.status).toBe(400);
  });

  it('returns 401 when not authenticated', async () => {
    const db = {};
    createDbServerClient.mockResolvedValue(db);
    getAuthContext.mockResolvedValue(null);

    const response = await GET(new Request('http://localhost/api/analytics/health?project_id=p'));

    expect(response.status).toBe(401);
  });

  it('returns 200 with health data when no active sprint', async () => {
    const db = { from: vi.fn(() => createQueryStub([], { singleNull: true })) };
    createDbServerClient.mockResolvedValue(db);
    createAdminClient.mockReturnValue(db);

    const response = await GET(new Request('http://localhost/api/analytics/health?project_id=project-alpha'));

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.data).toMatchObject({ active_sprint: null, sprint_progress: 0, health: 'good' });
  });
});
