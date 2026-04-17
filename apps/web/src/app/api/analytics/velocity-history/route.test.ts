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
  q.then = Promise.resolve({ data: rows, error: null }).then.bind(Promise.resolve({ data: rows, error: null }));
  return q;
}

describe('GET /api/analytics/velocity-history', () => {
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

    const response = await GET(new Request('http://localhost/api/analytics/velocity-history'));

    expect(response.status).toBe(400);
  });

  it('returns 401 when not authenticated', async () => {
    const supabase = {};
    createSupabaseServerClient.mockResolvedValue(supabase);
    getAuthContext.mockResolvedValue(null);

    const response = await GET(new Request('http://localhost/api/analytics/velocity-history?project_id=p'));

    expect(response.status).toBe(401);
  });

  it('returns 200 with velocity history', async () => {
    const sprint = { id: 'sprint-1', title: 'Sprint 1', velocity: 21, status: 'closed', start_date: '2026-04-01', end_date: '2026-04-14' };
    const supabase = { from: vi.fn(() => createQueryStub([sprint])) };
    createSupabaseServerClient.mockResolvedValue(supabase);
    createSupabaseAdminClient.mockReturnValue(supabase);

    const response = await GET(new Request('http://localhost/api/analytics/velocity-history?project_id=project-alpha'));

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.data).toEqual(expect.arrayContaining([expect.objectContaining({ id: 'sprint-1', velocity: 21 })]));
  });
});
