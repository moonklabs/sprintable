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

describe('GET /api/dashboard', () => {
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

    const response = await GET(new Request('http://localhost/api/dashboard?member_id=member-1'));

    expect(response.status).toBe(401);
  });

  it('returns 400 when member_id is missing', async () => {
    const db = {};
    createDbServerClient.mockResolvedValue(db);
    createAdminClient.mockReturnValue(db);

    const response = await GET(new Request('http://localhost/api/dashboard'));

    expect(response.status).toBe(400);
  });

  it('returns 404 when member not found (no project_id)', async () => {
    const chain = () => q;
    const q: Record<string, unknown> = {};
    q.select = vi.fn(chain);
    q.eq = vi.fn(chain);
    q.single = vi.fn(async () => ({ data: null, error: { message: 'not found' } }));
    const db = { from: vi.fn(() => q) };
    createDbServerClient.mockResolvedValue(db);
    createAdminClient.mockReturnValue(db);

    const response = await GET(new Request('http://localhost/api/dashboard?member_id=nonexistent'));

    expect(response.status).toBe(404);
  });

  it('returns 200 with dashboard data when project_id provided', async () => {
    const stories = [{ id: 'story-1', title: 'S1', status: 'backlog', story_points: 5 }];
    const tasks = [{ id: 'task-1', title: 'T1', status: 'todo' }];
    const memos = [{ id: 'memo-1', title: 'M1', status: 'open' }];

    let callIndex = 0;
    const makeQuery = (rows: Record<string, unknown>[]) => {
      const q: Record<string, unknown> = {};
      const chain = () => q;
      q.select = vi.fn(chain);
      q.eq = vi.fn(chain);
      q.neq = vi.fn(chain);
      q.then = Promise.resolve({ data: rows, error: null }).then.bind(Promise.resolve({ data: rows, error: null }));
      return q;
    };
    const db = {
      from: vi.fn(() => {
        const idx = callIndex++;
        if (idx === 0) return makeQuery(stories);
        if (idx === 1) return makeQuery(tasks);
        return makeQuery(memos);
      }),
    };
    createDbServerClient.mockResolvedValue(db);
    createAdminClient.mockReturnValue(db);

    const response = await GET(
      new Request('http://localhost/api/dashboard?member_id=member-1&project_id=project-1'),
    );

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.data).toMatchObject({
      my_stories: stories,
      assigned_stories: stories,
      my_tasks: tasks,
      open_memos: memos,
    });
  });
});
