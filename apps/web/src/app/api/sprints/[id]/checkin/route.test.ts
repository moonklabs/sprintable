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

function createQueryStub(rows: Record<string, unknown>[] = [], opts: { singleNotFound?: boolean } = {}) {
  const q: Record<string, unknown> = {};
  const chain = () => q;
  q.select = vi.fn(chain);
  q.eq = vi.fn(chain);
  q.is = vi.fn(chain);
  q.order = vi.fn(chain);
  q.limit = vi.fn(chain);
  q.lt = vi.fn(chain);
  q.single = vi.fn(() =>
    opts.singleNotFound
      ? Promise.resolve({ data: null, error: { code: 'PGRST116', message: 'not found' } })
      : Promise.resolve({ data: rows[0] ?? null, error: null }),
  );
  q.then = Promise.resolve({ data: rows, error: null }).then.bind(Promise.resolve({ data: rows, error: null }));
  return q;
}

describe('GET /api/sprints/[id]/checkin', () => {
  beforeEach(() => {
    createDbServerClient.mockReset();
    getAuthContext.mockReset();
    createAdminClient.mockReset();
    getAuthContext.mockResolvedValue(makeAgent());
  });

  it('returns 400 when date missing', async () => {
    const db = { from: vi.fn(() => createQueryStub()) };
    createDbServerClient.mockResolvedValue(db);
    createAdminClient.mockReturnValue(db);

    const response = await GET(
      new Request('http://localhost/api/sprints/sprint-1/checkin'),
      { params: Promise.resolve({ id: 'sprint-1' }) },
    );

    expect(response.status).toBe(400);
  });

  it('returns 401 when not authenticated', async () => {
    const db = {};
    createDbServerClient.mockResolvedValue(db);
    getAuthContext.mockResolvedValue(null);

    const response = await GET(
      new Request('http://localhost/api/sprints/sprint-1/checkin?date=2026-04-06'),
      { params: Promise.resolve({ id: 'sprint-1' }) },
    );

    expect(response.status).toBe(401);
  });

  it('returns 200 with checkin data', async () => {
    const sprint = { id: 'sprint-1', project_id: 'project-alpha', title: 'S1' };
    const stories = [{ status: 'done', story_points: 5 }, { status: 'todo', story_points: 3 }];
    const members = [{ id: 'member-1', name: 'Alice' }, { id: 'member-2', name: 'Bob' }];
    const standups = [{ author_id: 'member-1' }];
    const db = {
      from: vi.fn((table: string) => {
        if (table === 'sprints') return createQueryStub([sprint]);
        if (table === 'stories') return createQueryStub(stories);
        if (table === 'team_members') return createQueryStub(members);
        return createQueryStub(standups);
      }),
    };
    createDbServerClient.mockResolvedValue(db);
    createAdminClient.mockReturnValue(db);

    const response = await GET(
      new Request('http://localhost/api/sprints/sprint-1/checkin?date=2026-04-06'),
      { params: Promise.resolve({ id: 'sprint-1' }) },
    );

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.data).toMatchObject({
      total_stories: 2,
      total_points: 8,
      done_points: 5,
      missing_standups: expect.any(Array),
    });
  });
});
