import { beforeEach, describe, expect, it, vi } from 'vitest';

const { createDbServerClient, getAuthContext, createAdminClient } = vi.hoisted(() => ({
  createDbServerClient: vi.fn(),
  getAuthContext: vi.fn(),
  createAdminClient: vi.fn(),
}));

vi.mock('@/lib/db/server', () => ({ createDbServerClient }));
vi.mock('@/lib/db/admin', () => ({ createAdminClient }));
vi.mock('@/lib/auth-helpers', () => ({ getAuthContext }));

import { GET, POST } from './route';

function makeAgent() {
  return { id: 'agent-1', type: 'agent', rateLimitExceeded: false, rateLimitRemaining: 299, rateLimitResetAt: 0 };
}

function createQueryStub(rows: Record<string, unknown>[] = []) {
  const q: Record<string, unknown> = {};
  const chain = () => q;
  q.select = vi.fn(chain);
  q.eq = vi.fn(chain);
  q.order = vi.fn(chain);
  q.insert = vi.fn(chain);
  q.single = vi.fn(() => Promise.resolve({ data: rows[0] ?? null, error: rows[0] ? null : { message: 'not found' } }));
  q.then = Promise.resolve({ data: rows, error: null }).then.bind(Promise.resolve({ data: rows, error: null }));
  return q;
}

describe('GET /api/retro-sessions', () => {
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

    const response = await GET(
      new Request('http://localhost/api/retro-sessions?project_id=project-1'),
    );

    expect(response.status).toBe(401);
  });

  it('returns 400 when project_id is missing', async () => {
    const db = {};
    createDbServerClient.mockResolvedValue(db);
    createAdminClient.mockReturnValue(db);

    const response = await GET(
      new Request('http://localhost/api/retro-sessions'),
    );

    expect(response.status).toBe(400);
  });

  it('returns 200 with sessions list', async () => {
    const sessions = [{ id: 'session-1', project_id: 'project-1', phase: 'collect' }];
    const db = {
      from: vi.fn(() => createQueryStub(sessions)),
    };
    createDbServerClient.mockResolvedValue(db);
    createAdminClient.mockReturnValue(db);

    const response = await GET(
      new Request('http://localhost/api/retro-sessions?project_id=project-1'),
    );

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.data).toEqual(sessions);
  });
});

describe('POST /api/retro-sessions', () => {
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

    const response = await POST(
      new Request('http://localhost/api/retro-sessions', { method: 'POST', body: '{}' }),
    );

    expect(response.status).toBe(401);
  });

  it('returns 400 when required fields are missing', async () => {
    const db = {};
    createDbServerClient.mockResolvedValue(db);
    createAdminClient.mockReturnValue(db);

    const response = await POST(
      new Request('http://localhost/api/retro-sessions', {
        method: 'POST',
        body: JSON.stringify({ title: 'Sprint Retro' }),
      }),
    );

    expect(response.status).toBe(400);
  });

  it('returns 200 with created session', async () => {
    const session = { id: 'session-new', project_id: 'project-1', title: 'Sprint Retro', phase: 'collect' };
    const db = {
      from: vi.fn(() => createQueryStub([session])),
    };
    createDbServerClient.mockResolvedValue(db);
    createAdminClient.mockReturnValue(db);

    const response = await POST(
      new Request('http://localhost/api/retro-sessions', {
        method: 'POST',
        body: JSON.stringify({ project_id: 'project-1', org_id: 'org-1', title: 'Sprint Retro', created_by: 'member-1' }),
      }),
    );

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.data).toMatchObject({ id: 'session-new' });
  });
});
