import { beforeEach, describe, expect, it, vi } from 'vitest';

const { getOrgProjectAuthContext, proxyToFastapiWithParams } = vi.hoisted(() => ({
  getOrgProjectAuthContext: vi.fn(),
  proxyToFastapiWithParams: vi.fn(),
}));

vi.mock('@/lib/auth-helpers', () => ({ getOrgProjectAuthContext }));
vi.mock('@/lib/fastapi-proxy', () => ({ proxyToFastapiWithParams }));

import { POST } from './route';

function makeAgent() {
  return { id: 'agent-1', type: 'agent', rateLimitExceeded: false, rateLimitRemaining: 299, rateLimitResetAt: 0 };
}

describe('POST /api/retro-sessions/[id]/items/[item_id]/group', () => {
  beforeEach(() => {
    getOrgProjectAuthContext.mockReset();
    proxyToFastapiWithParams.mockReset();
    getOrgProjectAuthContext.mockResolvedValue(makeAgent());
  });

  it('returns 401 when not authenticated', async () => {
    getOrgProjectAuthContext.mockResolvedValue(null);

    const response = await POST(
      new Request('http://localhost/api/retro-sessions/session-1/items/item-1/group', {
        method: 'POST',
        body: JSON.stringify({ parent_item_id: 'item-2' }),
      }),
      { params: Promise.resolve({ id: 'session-1', item_id: 'item-1' }) },
    );

    expect(response.status).toBe(401);
  });

  it('B2(9f27af8f): merges item under parent, parent vote_count reflects BE-side sum', async () => {
    const merged = { id: 'item-1', session_id: 'session-1', parent_item_id: 'item-2', vote_count: 0 };
    proxyToFastapiWithParams.mockResolvedValue(
      new Response(JSON.stringify(merged), { status: 200, headers: { 'Content-Type': 'application/json' } }),
    );

    const response = await POST(
      new Request('http://localhost/api/retro-sessions/session-1/items/item-1/group', {
        method: 'POST',
        body: JSON.stringify({ parent_item_id: 'item-2' }),
      }),
      { params: Promise.resolve({ id: 'session-1', item_id: 'item-1' }) },
    );

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.data.parent_item_id).toBe('item-2');
    expect(proxyToFastapiWithParams).toHaveBeenCalledWith(
      expect.anything(),
      '/api/v2/retros/[id]/items/[item_id]/group',
      { id: 'session-1', item_id: 'item-1' },
    );
  });
});
