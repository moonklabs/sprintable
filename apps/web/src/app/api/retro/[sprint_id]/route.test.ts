import { beforeEach, describe, expect, it, vi } from 'vitest';

const { createSupabaseServerClient, getAuthContext, createSupabaseAdminClient } = vi.hoisted(() => ({
  createSupabaseServerClient: vi.fn(),
  getAuthContext: vi.fn(),
  createSupabaseAdminClient: vi.fn(),
}));

vi.mock('@/lib/supabase/server', () => ({ createSupabaseServerClient }));
vi.mock('@/lib/supabase/admin', () => ({ createSupabaseAdminClient }));
vi.mock('@/lib/auth-helpers', () => ({ getAuthContext }));

import { GET, PATCH } from './route';

function makeAgent() {
  return { id: 'agent-1', type: 'agent', rateLimitExceeded: false, rateLimitRemaining: 299, rateLimitResetAt: 0 };
}

function createQueryStub(rows: Record<string, unknown>[] = [], opts: { singleNull?: boolean } = {}) {
  const q: Record<string, unknown> = {};
  const chain = () => q;
  q.select = vi.fn(chain);
  q.eq = vi.fn(chain);
  q.order = vi.fn(chain);
  q.limit = vi.fn(chain);
  q.single = vi.fn(() =>
    opts.singleNull
      ? Promise.resolve({ data: null, error: { code: 'PGRST116', message: 'not found' } })
      : Promise.resolve({ data: rows[0] ?? null, error: null }),
  );
  q.then = Promise.resolve({ data: rows, error: null }).then.bind(Promise.resolve({ data: rows, error: null }));
  return q;
}

describe('GET /api/retro/[sprint_id]', () => {
  beforeEach(() => {
    createSupabaseServerClient.mockReset();
    getAuthContext.mockReset();
    createSupabaseAdminClient.mockReset();
    getAuthContext.mockResolvedValue(makeAgent());
  });

  it('returns 400 when project_id missing', async () => {
    const supabase = { from: vi.fn(() => createQueryStub()) };
    createSupabaseServerClient.mockResolvedValue(supabase);
    createSupabaseAdminClient.mockReturnValue(supabase);

    const response = await GET(
      new Request('http://localhost/api/retro/sprint-1'),
      { params: Promise.resolve({ sprint_id: 'sprint-1' }) },
    );

    expect(response.status).toBe(400);
  });

  it('returns 401 when not authenticated', async () => {
    const supabase = {};
    createSupabaseServerClient.mockResolvedValue(supabase);
    getAuthContext.mockResolvedValue(null);

    const response = await GET(
      new Request('http://localhost/api/retro/sprint-1?project_id=p'),
      { params: Promise.resolve({ sprint_id: 'sprint-1' }) },
    );

    expect(response.status).toBe(401);
  });

  it('returns 200 with session data', async () => {
    const session = { id: 'session-1', sprint_id: 'sprint-1', phase: 'collect' };
    const supabase = { from: vi.fn(() => createQueryStub([session])) };
    createSupabaseServerClient.mockResolvedValue(supabase);
    createSupabaseAdminClient.mockReturnValue(supabase);

    const response = await GET(
      new Request('http://localhost/api/retro/sprint-1?project_id=project-alpha'),
      { params: Promise.resolve({ sprint_id: 'sprint-1' }) },
    );

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.data).toMatchObject({ id: 'session-1', phase: 'collect' });
  });
});

describe('PATCH /api/retro/[sprint_id]', () => {
  beforeEach(() => {
    createSupabaseServerClient.mockReset();
    getAuthContext.mockReset();
    createSupabaseAdminClient.mockReset();
    getAuthContext.mockResolvedValue(makeAgent());
  });

  it('returns 410 (GONE) when called — v1 retro PATCH API removed', async () => {
    const supabase = { from: vi.fn(() => createQueryStub()) };
    createSupabaseServerClient.mockResolvedValue(supabase);
    createSupabaseAdminClient.mockReturnValue(supabase);

    const response = await PATCH(
      new Request('http://localhost/api/retro/sprint-1', { method: 'PATCH', body: JSON.stringify({ phase: 'vote' }) }),
      { params: Promise.resolve({ sprint_id: 'sprint-1' }) },
    );

    expect(response.status).toBe(410);
    const body = await response.json();
    expect(body.error.code).toBe('GONE');
  });

  it('returns 410 regardless of params — v1 retro PATCH removed', async () => {
    const supabase = { from: vi.fn(() => createQueryStub()) };
    createSupabaseServerClient.mockResolvedValue(supabase);
    createSupabaseAdminClient.mockReturnValue(supabase);

    const response = await PATCH(
      new Request('http://localhost/api/retro/sprint-1?project_id=p', { method: 'PATCH', body: JSON.stringify({}) }),
      { params: Promise.resolve({ sprint_id: 'sprint-1' }) },
    );

    expect(response.status).toBe(410);
  });
});
