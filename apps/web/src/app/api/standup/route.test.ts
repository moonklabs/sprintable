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

function makeStandupEntry(overrides: Record<string, unknown> = {}) {
  return { id: 'entry-1', project_id: 'project-alpha', author_id: 'member-1', date: '2026-04-15', done: 'done', plan: 'plan', blockers: null, ...overrides };
}

function createQueryStub(rows: Record<string, unknown>[]) {
  const q: Record<string, unknown> = {};
  const chain = () => q;
  q.select = vi.fn(chain);
  q.eq = vi.fn(chain);
  q.order = vi.fn(chain);
  q.upsert = vi.fn(chain);
  q.insert = vi.fn(chain);
  q.single = vi.fn(() => Promise.resolve({ data: rows[0] ?? null, error: rows[0] ? null : { code: 'PGRST116', message: 'not found' } }));
  q.then = Promise.resolve({ data: rows, error: null }).then.bind(Promise.resolve({ data: rows, error: null }));
  return q;
}

describe('GET /api/standup', () => {
  beforeEach(() => {
    createSupabaseServerClient.mockReset();
    getAuthContext.mockReset();
    createSupabaseAdminClient.mockReset();
    getAuthContext.mockResolvedValue({ id: 'member-1', type: 'human', rateLimitExceeded: false, rateLimitRemaining: 299, rateLimitResetAt: 0 });
  });

  it('returns entries list when no member_id provided', async () => {
    const entries = [makeStandupEntry()];
    const supabase = { from: vi.fn(() => createQueryStub(entries)) };
    createSupabaseServerClient.mockResolvedValue(supabase);

    const response = await GET(new Request('http://localhost/api/standup?project_id=project-alpha&date=2026-04-15'));

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.data).toEqual(expect.arrayContaining([expect.objectContaining({ id: 'entry-1' })]));
  });

  it('returns single entry when member_id provided', async () => {
    const entry = makeStandupEntry();
    const supabase = { from: vi.fn(() => createQueryStub([entry])) };
    createSupabaseServerClient.mockResolvedValue(supabase);

    const response = await GET(new Request('http://localhost/api/standup?project_id=project-alpha&member_id=member-1&date=2026-04-15'));

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.data).toMatchObject({ id: 'entry-1', author_id: 'member-1' });
  });

  it('returns 400 when project_id or date missing', async () => {
    const supabase = {};
    createSupabaseServerClient.mockResolvedValue(supabase);

    const response = await GET(new Request('http://localhost/api/standup?project_id=project-alpha'));

    expect(response.status).toBe(400);
  });

  it('returns 401 when not authenticated', async () => {
    const supabase = {};
    createSupabaseServerClient.mockResolvedValue(supabase);
    getAuthContext.mockResolvedValue(null);

    const response = await GET(new Request('http://localhost/api/standup?project_id=p&date=2026-04-15'));

    expect(response.status).toBe(401);
  });

  it('uses admin client for agent auth', async () => {
    getAuthContext.mockResolvedValue({ id: 'agent-1', type: 'agent', rateLimitExceeded: false, rateLimitRemaining: 299, rateLimitResetAt: 0 });
    const entries = [makeStandupEntry()];
    const adminQuery = createQueryStub(entries);
    const adminSupabase = { from: vi.fn(() => adminQuery) };
    createSupabaseAdminClient.mockReturnValue(adminSupabase);
    createSupabaseServerClient.mockResolvedValue({});

    const response = await GET(new Request('http://localhost/api/standup?project_id=project-alpha&date=2026-04-15'));

    expect(response.status).toBe(200);
    expect(createSupabaseAdminClient).toHaveBeenCalled();
  });
});

describe('POST /api/standup', () => {
  beforeEach(() => {
    createSupabaseServerClient.mockReset();
    getAuthContext.mockReset();
    createSupabaseAdminClient.mockReset();
    getAuthContext.mockResolvedValue({ id: 'member-1', type: 'human', rateLimitExceeded: false, rateLimitRemaining: 299, rateLimitResetAt: 0 });
  });

  it('saves standup entry for human user', async () => {
    const memberData = { project_id: 'project-alpha', org_id: 'org-1' };
    const entryData = makeStandupEntry();
    const supabase = {
      from: vi.fn((table: string) => {
        if (table === 'team_members') return createQueryStub([memberData]);
        return createQueryStub([entryData]);
      }),
    };
    createSupabaseServerClient.mockResolvedValue(supabase);

    const response = await POST(new Request('http://localhost/api/standup', {
      method: 'POST',
      body: JSON.stringify({ date: '2026-04-15', done: 'Finished S7', plan: 'Start S8' }),
      headers: { 'Content-Type': 'application/json' },
    }));

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.data).toMatchObject({ id: 'entry-1' });
  });

  it('uses author_id from body for agent auth', async () => {
    getAuthContext.mockResolvedValue({ id: 'agent-1', type: 'agent', rateLimitExceeded: false, rateLimitRemaining: 299, rateLimitResetAt: 0 });
    const memberData = { project_id: 'project-alpha', org_id: 'org-1' };
    const entryData = makeStandupEntry({ author_id: 'member-1' });
    const adminSupabase = {
      from: vi.fn((table: string) => {
        if (table === 'team_members') return createQueryStub([memberData]);
        return createQueryStub([entryData]);
      }),
    };
    createSupabaseAdminClient.mockReturnValue(adminSupabase);
    createSupabaseServerClient.mockResolvedValue({});

    const response = await POST(new Request('http://localhost/api/standup', {
      method: 'POST',
      body: JSON.stringify({ author_id: 'member-1', date: '2026-04-15', done: 'Finished S7', plan: 'Start S8' }),
      headers: { 'Content-Type': 'application/json' },
    }));

    expect(response.status).toBe(200);
    expect(createSupabaseAdminClient).toHaveBeenCalled();
  });

  it('returns 400 for invalid body', async () => {
    const supabase = {};
    createSupabaseServerClient.mockResolvedValue(supabase);

    const response = await POST(new Request('http://localhost/api/standup', {
      method: 'POST',
      body: JSON.stringify({ done: 'no date provided' }),
      headers: { 'Content-Type': 'application/json' },
    }));

    expect(response.status).toBe(400);
  });
});
