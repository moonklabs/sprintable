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
    createDbServerClient.mockReset();
    getAuthContext.mockReset();
    createAdminClient.mockReset();
    getAuthContext.mockResolvedValue({ id: 'member-1', type: 'human', rateLimitExceeded: false, rateLimitRemaining: 299, rateLimitResetAt: 0 });
  });

  it('returns feedback list for a standup entry', async () => {
    const rows = [
      { id: 'fb-1', standup_entry_id: 'entry-1', feedback_text: 'LGTM', review_type: 'approve' },
    ];
    const db = { from: vi.fn(() => createFeedbackQueryStub(rows)) };
    createDbServerClient.mockResolvedValue(db);

    const response = await GET(
      new Request('http://localhost/api/standup/feedback/entry-1'),
      { params: Promise.resolve({ id: 'entry-1' }) },
    );

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.data).toEqual([expect.objectContaining({ id: 'fb-1', standup_entry_id: 'entry-1' })]);
  });

  it('returns 401 when not authenticated', async () => {
    createDbServerClient.mockResolvedValue({});
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
    const adminDb = { from: vi.fn(() => createFeedbackQueryStub(rows)) };
    createAdminClient.mockReturnValue(adminDb);
    createDbServerClient.mockResolvedValue({});

    const response = await GET(
      new Request('http://localhost/api/standup/feedback/entry-1'),
      { params: Promise.resolve({ id: 'entry-1' }) },
    );

    expect(response.status).toBe(200);
    expect(createAdminClient).toHaveBeenCalled();
  });
});
