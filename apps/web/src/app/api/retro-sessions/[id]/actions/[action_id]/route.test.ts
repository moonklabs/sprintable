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

describe('PATCH /api/retro-sessions/[id]/actions/[action_id]', () => {
  beforeEach(() => {
    getOrgProjectAuthContext.mockReset();
    proxyToFastapiWithParams.mockReset();
    getOrgProjectAuthContext.mockResolvedValue(makeAgent());
  });

  it('returns 401 when not authenticated', async () => {
    getOrgProjectAuthContext.mockResolvedValue(null);

    const response = await PATCH(
      new Request('http://localhost/api/retro-sessions/session-1/actions/action-1?project_id=project-1', {
        method: 'PATCH',
        body: JSON.stringify({ status: 'done' }),
      }),
      { params: Promise.resolve({ id: 'session-1', action_id: 'action-1' }) },
    );

    expect(response.status).toBe(401);
  });

  it('returns 400 when project_id is missing', async () => {
    const response = await PATCH(
      new Request('http://localhost/api/retro-sessions/session-1/actions/action-1', {
        method: 'PATCH',
        body: JSON.stringify({ status: 'done' }),
      }),
      { params: Promise.resolve({ id: 'session-1', action_id: 'action-1' }) },
    );

    expect(response.status).toBe(400);
  });

  // B3(9f27af8f): 완료 토글 — status 갱신 반영.
  it('returns 200 with the updated action status', async () => {
    const updated = { id: 'action-1', session_id: 'session-1', title: 'Follow up', assignee_id: 'member-1', status: 'done' };
    proxyToFastapiWithParams.mockResolvedValue(
      new Response(JSON.stringify(updated), { status: 200, headers: { 'Content-Type': 'application/json' } }),
    );

    const response = await PATCH(
      new Request('http://localhost/api/retro-sessions/session-1/actions/action-1?project_id=project-1', {
        method: 'PATCH',
        body: JSON.stringify({ status: 'done' }),
      }),
      { params: Promise.resolve({ id: 'session-1', action_id: 'action-1' }) },
    );

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.data.status).toBe('done');
    expect(proxyToFastapiWithParams).toHaveBeenCalledWith(
      expect.anything(),
      '/api/v2/retros/[id]/actions/[action_id]',
      { id: 'session-1', action_id: 'action-1' },
    );
  });
});
