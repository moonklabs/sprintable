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
    createSupabaseServerClient.mockReset();
    getAuthContext.mockReset();
    createSupabaseAdminClient.mockReset();
    getAuthContext.mockResolvedValue(makeAgent());
  });

  it('returns 400 when project_id missing', async () => {
    const supabase = { from: vi.fn(() => createQueryStub()) };
    createSupabaseServerClient.mockResolvedValue(supabase);
    createSupabaseAdminClient.mockReturnValue(supabase);

    const response = await GET(new Request('http://localhost/api/analytics/health'));

    expect(response.status).toBe(400);
  });

  it('returns 401 when not authenticated', async () => {
    const supabase = {};
    createSupabaseServerClient.mockResolvedValue(supabase);
    getAuthContext.mockResolvedValue(null);

    const response = await GET(new Request('http://localhost/api/analytics/health?project_id=p'));

    expect(response.status).toBe(401);
  });

  it('returns 200 with health data when no active sprint', async () => {
    const supabase = { from: vi.fn(() => createQueryStub([], { singleNull: true })) };
    createSupabaseServerClient.mockResolvedValue(supabase);
    createSupabaseAdminClient.mockReturnValue(supabase);

    const response = await GET(new Request('http://localhost/api/analytics/health?project_id=project-alpha'));

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.data).toMatchObject({ active_sprint: null, sprint_progress: 0, health: 'good' });
  });
});
