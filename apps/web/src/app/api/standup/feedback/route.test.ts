import { beforeEach, describe, expect, it, vi } from 'vitest';

const { createSupabaseServerClient, getAuthContext, createSupabaseAdminClient } = vi.hoisted(() => ({
  createSupabaseServerClient: vi.fn(),
  getAuthContext: vi.fn(),
  createSupabaseAdminClient: vi.fn(),
}));

vi.mock('@/lib/supabase/server', () => ({ createSupabaseServerClient }));
vi.mock('@/lib/supabase/admin', () => ({ createSupabaseAdminClient }));
vi.mock('@/lib/auth-helpers', () => ({ getAuthContext }));

import { GET, POST } from './route';

function createQueryStub(rows: Record<string, unknown>[]) {
  const q: Record<string, unknown> = {};
  const chain = () => q;
  q.select = vi.fn(chain);
  q.eq = vi.fn(chain);
  q.in = vi.fn(chain);
  q.order = vi.fn(chain);
  q.insert = vi.fn(chain);
  q.single = vi.fn(() => Promise.resolve({
    data: rows[0] ?? null,
    error: rows[0] ? null : { code: 'PGRST116', message: 'not found' },
  }));
  q.then = Promise.resolve({ data: rows, error: null }).then.bind(Promise.resolve({ data: rows, error: null }));
  return q;
}

describe('GET /api/standup/feedback', () => {
  beforeEach(() => {
    createSupabaseServerClient.mockReset();
    getAuthContext.mockReset();
    createSupabaseAdminClient.mockReset();
    getAuthContext.mockResolvedValue({ id: 'member-1', type: 'human', rateLimitExceeded: false, rateLimitRemaining: 299, rateLimitResetAt: 0 });
  });

  it('returns feedback list for project_id + date', async () => {
    const entries = [{ id: 'entry-1' }];
    const feedback = [{ id: 'feedback-1', standup_entry_id: 'entry-1', feedback_text: 'LGTM' }];
    let callCount = 0;
    const supabase = {
      from: vi.fn(() => {
        callCount++;
        return createQueryStub(callCount === 1 ? entries : feedback);
      }),
    };
    createSupabaseServerClient.mockResolvedValue(supabase);

    const response = await GET(new Request('http://localhost/api/standup/feedback?project_id=project-alpha&date=2026-04-15'));

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.data).toEqual(expect.arrayContaining([expect.objectContaining({ id: 'feedback-1' })]));
  });

  it('returns 400 when project_id or date missing', async () => {
    createSupabaseServerClient.mockResolvedValue({});

    const response = await GET(new Request('http://localhost/api/standup/feedback?project_id=project-alpha'));

    expect(response.status).toBe(400);
  });

  it('returns 401 when not authenticated', async () => {
    createSupabaseServerClient.mockResolvedValue({});
    getAuthContext.mockResolvedValue(null);

    const response = await GET(new Request('http://localhost/api/standup/feedback?project_id=p&date=2026-04-15'));

    expect(response.status).toBe(401);
  });
});

describe('POST /api/standup/feedback', () => {
  beforeEach(() => {
    createSupabaseServerClient.mockReset();
    getAuthContext.mockReset();
    createSupabaseAdminClient.mockReset();
    getAuthContext.mockResolvedValue({ id: 'member-1', type: 'human', rateLimitExceeded: false, rateLimitRemaining: 299, rateLimitResetAt: 0 });
  });

  it('returns 400 for invalid payload', async () => {
    const memberData = { project_id: 'project-alpha', org_id: 'org-1' };
    const supabase = { from: vi.fn(() => createQueryStub([memberData])) };
    createSupabaseServerClient.mockResolvedValue(supabase);

    const response = await POST(new Request('http://localhost/api/standup/feedback', {
      method: 'POST',
      body: JSON.stringify({ feedback_text: 'LGTM' }),
      headers: { 'Content-Type': 'application/json' },
    }));

    expect(response.status).toBe(400);
    const body = await response.json();
    expect(body.error.code).toBe('VALIDATION_FAILED');
  });
});
