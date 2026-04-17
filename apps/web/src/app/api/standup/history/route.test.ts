import { beforeEach, describe, expect, it, vi } from 'vitest';

const { createSupabaseServerClient, getAuthContext, createSupabaseAdminClient } = vi.hoisted(() => ({
  createSupabaseServerClient: vi.fn(),
  getAuthContext: vi.fn(),
  createSupabaseAdminClient: vi.fn(),
}));

vi.mock('@/lib/supabase/server', () => ({ createSupabaseServerClient }));
vi.mock('@/lib/supabase/admin', () => ({ createSupabaseAdminClient }));
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
  q.order = vi.fn(chain);
  q.limit = vi.fn(chain);
  q.then = Promise.resolve({ data: rows, error: null }).then.bind(Promise.resolve({ data: rows, error: null }));
  return q;
}

describe('GET /api/standup/history', () => {
  beforeEach(() => {
    createSupabaseServerClient.mockReset();
    getAuthContext.mockReset();
    createSupabaseAdminClient.mockReset();
    getAuthContext.mockResolvedValue(makeAgent());
  });

  it('returns 401 when not authenticated', async () => {
    const supabase = {};
    createSupabaseServerClient.mockResolvedValue(supabase);
    getAuthContext.mockResolvedValue(null);

    const response = await GET(
      new Request('http://localhost/api/standup/history?project_id=project-1'),
    );

    expect(response.status).toBe(401);
  });

  it('returns 400 when project_id is missing', async () => {
    const supabase = {};
    createSupabaseServerClient.mockResolvedValue(supabase);
    createSupabaseAdminClient.mockReturnValue(supabase);

    const response = await GET(
      new Request('http://localhost/api/standup/history'),
    );

    expect(response.status).toBe(400);
  });

  it('returns 200 with standup entries list', async () => {
    const entries = [
      { id: 'e1', author_id: 'member-1', date: '2026-04-06', done: 'done', plan: 'plan', blockers: null },
      { id: 'e2', author_id: 'member-2', date: '2026-04-05', done: 'done', plan: 'plan', blockers: null },
    ];
    const supabase = {
      from: vi.fn(() => createQueryStub(entries)),
    };
    createSupabaseServerClient.mockResolvedValue(supabase);
    createSupabaseAdminClient.mockReturnValue(supabase);

    const response = await GET(
      new Request('http://localhost/api/standup/history?project_id=project-1'),
    );

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.data).toHaveLength(2);
    expect(body.data[0]).toMatchObject({ id: 'e1', author_id: 'member-1' });
  });
});
