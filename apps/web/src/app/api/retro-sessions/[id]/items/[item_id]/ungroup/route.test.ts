import { beforeEach, describe, expect, it, vi } from 'vitest';

const { getAuthContext, proxyToFastapiWithParams } = vi.hoisted(() => ({
  getAuthContext: vi.fn(),
  proxyToFastapiWithParams: vi.fn(),
}));

vi.mock('@/lib/auth-helpers', () => ({ getAuthContext }));
vi.mock('@/lib/fastapi-proxy', () => ({ proxyToFastapiWithParams }));

import { POST } from './route';

function makeAgent() {
  return { id: 'agent-1', type: 'agent', rateLimitExceeded: false, rateLimitRemaining: 299, rateLimitResetAt: 0 };
}

describe('POST /api/retro-sessions/[id]/items/[item_id]/ungroup', () => {
  beforeEach(() => {
    getAuthContext.mockReset();
    proxyToFastapiWithParams.mockReset();
    getAuthContext.mockResolvedValue(makeAgent());
  });

  it('returns 401 when not authenticated', async () => {
    getAuthContext.mockResolvedValue(null);

    const response = await POST(
      new Request('http://localhost/api/retro-sessions/session-1/items/item-1/ungroup', { method: 'POST' }),
      { params: Promise.resolve({ id: 'session-1', item_id: 'item-1' }) },
    );

    expect(response.status).toBe(401);
  });

  it('B2(9f27af8f): ungroups an item back to top-level', async () => {
    const ungrouped = { id: 'item-1', session_id: 'session-1', parent_item_id: null, vote_count: 0 };
    proxyToFastapiWithParams.mockResolvedValue(
      new Response(JSON.stringify(ungrouped), { status: 200, headers: { 'Content-Type': 'application/json' } }),
    );

    const response = await POST(
      new Request('http://localhost/api/retro-sessions/session-1/items/item-1/ungroup', { method: 'POST' }),
      { params: Promise.resolve({ id: 'session-1', item_id: 'item-1' }) },
    );

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.data.parent_item_id).toBeNull();
  });
});
