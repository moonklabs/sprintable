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

function createQueryStub(rows: Record<string, unknown>[] = []) {
  const q: Record<string, unknown> = {};
  const chain = () => q;
  q.select = vi.fn(chain);
  q.eq = vi.fn(chain);
  q.then = Promise.resolve({ data: rows, error: null }).then.bind(Promise.resolve({ data: rows, error: null }));
  return q;
}

describe('GET /api/standup/missing', () => {
  beforeEach(() => {
    createDbServerClient.mockReset();
    getAuthContext.mockReset();
    createAdminClient.mockReset();
    getAuthContext.mockResolvedValue(makeAgent());
  });

  it('returns 401 when not authenticated', async () => {
    const db = {};
    createDbServerClient.mockResolvedValue(db);
    getAuthContext.mockResolvedValue(null);

    const response = await GET(
      new Request('http://localhost/api/standup/missing?project_id=project-1&date=2026-04-06'),
    );

    expect(response.status).toBe(401);
  });

  it('returns 400 when project_id is missing', async () => {
    const db = {};
    createDbServerClient.mockResolvedValue(db);
    createAdminClient.mockReturnValue(db);

    const response = await GET(
      new Request('http://localhost/api/standup/missing?date=2026-04-06'),
    );

    expect(response.status).toBe(400);
  });

  it('returns 400 when date is missing', async () => {
    const db = {};
    createDbServerClient.mockResolvedValue(db);
    createAdminClient.mockReturnValue(db);

    const response = await GET(
      new Request('http://localhost/api/standup/missing?project_id=project-1'),
    );

    expect(response.status).toBe(400);
  });

  it('returns 200 with submitted_count and missing list', async () => {
    const members = [{ id: 'member-1', name: 'Alice' }, { id: 'member-2', name: 'Bob' }];
    const entries = [{ author_id: 'member-1' }];
    const db = {
      from: vi.fn((table: string) => {
        if (table === 'team_members') return createQueryStub(members);
        if (table === 'standup_entries') return createQueryStub(entries);
        return createQueryStub();
      }),
    };
    createDbServerClient.mockResolvedValue(db);
    createAdminClient.mockReturnValue(db);

    const response = await GET(
      new Request('http://localhost/api/standup/missing?project_id=project-1&date=2026-04-06'),
    );

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.data).toMatchObject({ submitted_count: 1, missing: [{ id: 'member-2', name: 'Bob' }] });
  });
});
