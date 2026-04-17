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

function createFeedbackQueryStub(rows: Record<string, unknown>[]) {
  const q: Record<string, unknown> = {};
  const chain = () => q;
  q.select = vi.fn(chain);
  q.eq = vi.fn(chain);
  q.order = vi.fn(chain);
  q.then = Promise.resolve({ data: rows, error: null }).then.bind(Promise.resolve({ data: rows, error: null }));
  return q;
}

describe('GET /api/standup/feedback/[id]', () => {
  beforeEach(() => {
    createSupabaseServerClient.mockReset();
    getAuthContext.mockReset();
    createSupabaseAdminClient.mockReset();
    getAuthContext.mockResolvedValue({ id: 'member-1', type: 'human', rateLimitExceeded: false, rateLimitRemaining: 299, rateLimitResetAt: 0 });
  });

  it('returns feedback list for a standup entry', async () => {
    const rows = [
      { id: 'fb-1', standup_entry_id: 'entry-1', feedback_text: 'LGTM', review_type: 'approve' },
    ];
    const supabase = { from: vi.fn(() => createFeedbackQueryStub(rows)) };
    createSupabaseServerClient.mockResolvedValue(supabase);

    const response = await GET(
      new Request('http://localhost/api/standup/feedback/entry-1'),
      { params: Promise.resolve({ id: 'entry-1' }) },
    );

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.data).toEqual([expect.objectContaining({ id: 'fb-1', standup_entry_id: 'entry-1' })]);
  });

  it('returns 401 when not authenticated', async () => {
    createSupabaseServerClient.mockResolvedValue({});
    getAuthContext.mockResolvedValue(null);

    const response = await GET(
      new Request('http://localhost/api/standup/feedback/entry-1'),
      { params: Promise.resolve({ id: 'entry-1' }) },
    );

    expect(response.status).toBe(401);
  });

  it('uses admin client for agent auth', async () => {
    getAuthContext.mockResolvedValue({ id: 'agent-1', type: 'agent', rateLimitExceeded: false, rateLimitRemaining: 299, rateLimitResetAt: 0 });
    const rows = [{ id: 'fb-1', standup_entry_id: 'entry-1' }];
    const adminSupabase = { from: vi.fn(() => createFeedbackQueryStub(rows)) };
    createSupabaseAdminClient.mockReturnValue(adminSupabase);
    createSupabaseServerClient.mockResolvedValue({});

    const response = await GET(
      new Request('http://localhost/api/standup/feedback/entry-1'),
      { params: Promise.resolve({ id: 'entry-1' }) },
    );

    expect(response.status).toBe(200);
    expect(createSupabaseAdminClient).toHaveBeenCalled();
  });
});
