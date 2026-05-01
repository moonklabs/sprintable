import { beforeEach, describe, expect, it, vi } from 'vitest';

const { createDbServerClient, getAuthContext, createAdminClient } = vi.hoisted(() => ({
  createDbServerClient: vi.fn(),
  getAuthContext: vi.fn(),
  createAdminClient: vi.fn(),
}));

vi.mock('@/lib/db/server', () => ({ createDbServerClient }));
vi.mock('@/lib/db/admin', () => ({ createAdminClient }));
vi.mock('@/lib/auth-helpers', () => ({ getAuthContext }));

import { PATCH } from './route';

function makeAgent() {
  return { id: 'agent-1', type: 'agent', rateLimitExceeded: false, rateLimitRemaining: 299, rateLimitResetAt: 0 };
}

function createQueryStub(rows: Record<string, unknown>[] = []) {
  const q: Record<string, unknown> = {};
  const chain = () => q;
  q.select = vi.fn(chain);
  q.eq = vi.fn(chain);
  q.update = vi.fn(chain);
  q.single = vi.fn(() => Promise.resolve({ data: rows[0] ?? null, error: rows[0] ? null : { message: 'not found' } }));
  return q;
}

describe('PATCH /api/retro-sessions/[id]', () => {
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

    const response = await PATCH(
      new Request('http://localhost/api/retro-sessions/session-1?project_id=project-1', {
        method: 'PATCH',
        body: JSON.stringify({ phase: 'group' }),
      }),
      { params: Promise.resolve({ id: 'session-1' }) },
    );

    expect(response.status).toBe(401);
  });

  it('returns 400 when project_id is missing', async () => {
    const db = {};
    createDbServerClient.mockResolvedValue(db);
    createAdminClient.mockReturnValue(db);

    const response = await PATCH(
      new Request('http://localhost/api/retro-sessions/session-1', {
        method: 'PATCH',
        body: JSON.stringify({ phase: 'group' }),
      }),
      { params: Promise.resolve({ id: 'session-1' }) },
    );

    expect(response.status).toBe(400);
  });

  it('returns 200 with updated session phase', async () => {
    const session = { id: 'session-1', project_id: 'project-1', phase: 'collect' };
    const updated = { ...session, phase: 'group' };
    const db = {
      from: vi.fn((table: string) => {
        if (table === 'retro_sessions') return createQueryStub([session, updated]);
        return createQueryStub();
      }),
    };
    createDbServerClient.mockResolvedValue(db);
    createAdminClient.mockReturnValue(db);

    const response = await PATCH(
      new Request('http://localhost/api/retro-sessions/session-1?project_id=project-1', {
        method: 'PATCH',
        body: JSON.stringify({ phase: 'group' }),
      }),
      { params: Promise.resolve({ id: 'session-1' }) },
    );

    expect(response.status).toBe(200);
  });
});
