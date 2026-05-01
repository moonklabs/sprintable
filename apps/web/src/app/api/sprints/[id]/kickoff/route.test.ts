import { beforeEach, describe, expect, it, vi } from 'vitest';

const { createDbServerClient, getAuthContext, createAdminClient } = vi.hoisted(() => ({
  createDbServerClient: vi.fn(),
  getAuthContext: vi.fn(),
  createAdminClient: vi.fn(),
}));

vi.mock('@/lib/db/server', () => ({ createDbServerClient }));
vi.mock('@/lib/db/admin', () => ({ createAdminClient }));
vi.mock('@/lib/auth-helpers', () => ({ getAuthContext }));

import { POST } from './route';

function makeAgent() {
  return { id: 'agent-1', type: 'agent', rateLimitExceeded: false, rateLimitRemaining: 299, rateLimitResetAt: 0 };
}

function createQueryStub(rows: Record<string, unknown>[] = [], opts: { singleNotFound?: boolean; insertOk?: boolean } = {}) {
  const q: Record<string, unknown> = {};
  const chain = () => q;
  q.select = vi.fn(chain);
  q.eq = vi.fn(chain);
  q.is = vi.fn(chain);
  q.order = vi.fn(chain);
  q.limit = vi.fn(chain);
  q.lt = vi.fn(chain);
  q.insert = vi.fn(() => (opts.insertOk !== false ? Promise.resolve({ error: null }) : Promise.resolve({ error: { message: 'insert failed' } })));
  q.single = vi.fn(() =>
    opts.singleNotFound
      ? Promise.resolve({ data: null, error: { code: 'PGRST116', message: 'not found' } })
      : Promise.resolve({ data: rows[0] ?? null, error: null }),
  );
  q.then = Promise.resolve({ data: rows, error: null }).then.bind(Promise.resolve({ data: rows, error: null }));
  return q;
}

describe('POST /api/sprints/[id]/kickoff', () => {
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

    const response = await POST(
      new Request('http://localhost/api/sprints/sprint-1/kickoff', { method: 'POST', body: '{}' }),
      { params: Promise.resolve({ id: 'sprint-1' }) },
    );

    expect(response.status).toBe(401);
  });

  it('returns 200 with notified count', async () => {
    const sprint = { id: 'sprint-1', project_id: 'project-alpha', title: 'Sprint 1', org_id: 'org-1' };
    const project = { org_id: 'org-1' };
    const members = [{ id: 'member-1' }, { id: 'member-2' }];
    const db = {
      from: vi.fn((table: string) => {
        if (table === 'sprints') return createQueryStub([sprint]);
        if (table === 'projects') return createQueryStub([project]);
        if (table === 'team_members') return createQueryStub(members);
        return createQueryStub([], { insertOk: true });
      }),
    };
    createDbServerClient.mockResolvedValue(db);
    createAdminClient.mockReturnValue(db);

    const response = await POST(
      new Request('http://localhost/api/sprints/sprint-1/kickoff', { method: 'POST', body: '{}' }),
      { params: Promise.resolve({ id: 'sprint-1' }) },
    );

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.data).toMatchObject({ notified: expect.any(Number) });
  });
});
