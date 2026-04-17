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
  q.then = Promise.resolve({ data: rows, error: null }).then.bind(Promise.resolve({ data: rows, error: null }));
  return q;
}

describe('GET /api/analytics/epic-progress', () => {
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

    const response = await GET(new Request('http://localhost/api/analytics/epic-progress?epic_id=epic-1'));

    expect(response.status).toBe(400);
    const body = await response.json();
    expect(body.error?.message).toMatch(/project_id/);
  });

  it('returns 400 when epic_id missing', async () => {
    const supabase = { from: vi.fn(() => createQueryStub()) };
    createSupabaseServerClient.mockResolvedValue(supabase);
    createSupabaseAdminClient.mockReturnValue(supabase);

    const response = await GET(new Request('http://localhost/api/analytics/epic-progress?project_id=p'));

    expect(response.status).toBe(400);
    const body = await response.json();
    expect(body.error?.message).toMatch(/epic_id/);
  });

  it('returns 200 with epic progress stats', async () => {
    const stories = [
      { status: 'done', story_points: 5 },
      { status: 'done', story_points: 3 },
      { status: 'in-progress', story_points: 2 },
    ];
    const supabase = { from: vi.fn(() => createQueryStub(stories)) };
    createSupabaseServerClient.mockResolvedValue(supabase);
    createSupabaseAdminClient.mockReturnValue(supabase);

    const response = await GET(new Request('http://localhost/api/analytics/epic-progress?project_id=project-alpha&epic_id=epic-1'));

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.data).toMatchObject({ total_stories: 3, done_stories: 2, total_points: 10, done_points: 8, completion_pct: 67 });
  });
});
