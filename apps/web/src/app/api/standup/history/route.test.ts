import { beforeEach, describe, expect, it, vi } from 'vitest';

const { getOrgProjectAuthContext, proxyToFastapi } = vi.hoisted(() => ({
  getOrgProjectAuthContext: vi.fn(),
  proxyToFastapi: vi.fn(),
}));

vi.mock('@/lib/auth-helpers', () => ({ getOrgProjectAuthContext }));
vi.mock('@/lib/fastapi-proxy', () => ({ proxyToFastapi }));

import { GET } from './route';

function makeAgent() {
  return { id: 'agent-1', type: 'agent', rateLimitExceeded: false, rateLimitRemaining: 299, rateLimitResetAt: 0 };
}

describe('GET /api/standup/history', () => {
  beforeEach(() => {
    getOrgProjectAuthContext.mockReset();
    proxyToFastapi.mockReset();
    getOrgProjectAuthContext.mockResolvedValue(makeAgent());
  });

  it('returns 401 when not authenticated', async () => {
    getOrgProjectAuthContext.mockResolvedValue(null);

    const response = await GET(
      new Request('http://localhost/api/standup/history?project_id=project-1'),
    );

    expect(response.status).toBe(401);
  });

  it('returns 200 with standup entries list', async () => {
    const entries = [
      { id: 'e1', author_id: 'member-1', date: '2026-04-06', done: 'done', plan: 'plan', blockers: null },
      { id: 'e2', author_id: 'member-2', date: '2026-04-05', done: 'done', plan: 'plan', blockers: null },
    ];
    proxyToFastapi.mockResolvedValue(
      new Response(JSON.stringify(entries), { status: 200 }),
    );

    const response = await GET(
      new Request('http://localhost/api/standup/history?project_id=project-1'),
    );

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.data).toHaveLength(2);
    expect(body.data[0]).toMatchObject({ id: 'e1', author_id: 'member-1' });
  });

  it('forwards upstream error status', async () => {
    proxyToFastapi.mockResolvedValue(new Response('not found', { status: 404 }));

    const response = await GET(
      new Request('http://localhost/api/standup/history?project_id=project-1'),
    );

    expect(response.status).toBe(404);
  });
});
