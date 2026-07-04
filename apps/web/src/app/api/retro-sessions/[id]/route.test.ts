import { beforeEach, describe, expect, it, vi } from 'vitest';

const { getOrgProjectAuthContext, proxyToFastapiWithParams } = vi.hoisted(() => ({
  getOrgProjectAuthContext: vi.fn(),
  proxyToFastapiWithParams: vi.fn(),
}));

vi.mock('@/lib/auth-helpers', () => ({ getOrgProjectAuthContext }));
vi.mock('@/lib/fastapi-proxy', () => ({ proxyToFastapiWithParams }));

import { PATCH } from './route';

function makeAgent() {
  return { id: 'agent-1', type: 'agent', rateLimitExceeded: false, rateLimitRemaining: 299, rateLimitResetAt: 0 };
}

describe('PATCH /api/retro-sessions/[id]', () => {
  beforeEach(() => {
    getOrgProjectAuthContext.mockReset();
    proxyToFastapiWithParams.mockReset();
    getOrgProjectAuthContext.mockResolvedValue(makeAgent());
  });

  it('returns 401 when not authenticated', async () => {
    getOrgProjectAuthContext.mockResolvedValue(null);

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
    const updated = { id: 'session-1', project_id: 'project-1', phase: 'group', items: [], actions: [] };
    proxyToFastapiWithParams.mockResolvedValue(
      new Response(JSON.stringify(updated), { status: 200, headers: { 'Content-Type': 'application/json' } }),
    );

    const response = await PATCH(
      new Request('http://localhost/api/retro-sessions/session-1?project_id=project-1', {
        method: 'PATCH',
        body: JSON.stringify({ phase: 'group' }),
      }),
      { params: Promise.resolve({ id: 'session-1' }) },
    );

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.data.phase).toBe('group');
  });
});
