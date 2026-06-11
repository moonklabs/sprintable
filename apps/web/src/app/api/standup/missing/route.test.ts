import { beforeEach, describe, expect, it, vi } from 'vitest';

// 837a36c4(Group B b2): proxy 위임 리팩토링 후 stale 테스트 재작성.
const { getAuthContext, proxyToFastapi } = vi.hoisted(() => ({
  getAuthContext: vi.fn(),
  proxyToFastapi: vi.fn(),
}));
vi.mock('@/lib/auth-helpers', () => ({ getAuthContext }));
vi.mock('@/lib/fastapi-proxy', () => ({ proxyToFastapi }));

import { GET } from './route';

const PATH = '/api/v2/standups/missing';
const agent = () => ({ id: 'a', type: 'agent', rateLimitExceeded: false, rateLimitRemaining: 299, rateLimitResetAt: 0 });
const req = () => new Request('http://localhost/api/standup/missing?project_id=p&date=2026-06-11');

describe('GET /api/standup/missing (proxy 위임)', () => {
  beforeEach(() => {
    getAuthContext.mockReset();
    proxyToFastapi.mockReset();
    getAuthContext.mockResolvedValue(agent());
  });

  it('401 when unauthenticated', async () => {
    getAuthContext.mockResolvedValue(null);
    expect((await GET(req())).status).toBe(401);
    expect(proxyToFastapi).not.toHaveBeenCalled();
  });

  it('delegates and wraps success', async () => {
    proxyToFastapi.mockResolvedValue(new Response(JSON.stringify([{ member_id: 'm' }]), { status: 200, headers: { 'content-type': 'application/json' } }));
    const res = await GET(req());
    expect(res.status).toBe(200);
    expect(proxyToFastapi).toHaveBeenCalledWith(expect.anything(), PATH);
    expect((await res.json()).data).toMatchObject([{ member_id: 'm' }]);
  });

  it('passes through proxy errors', async () => {
    proxyToFastapi.mockResolvedValue(new Response('e', { status: 502 }));
    expect((await GET(req())).status).toBe(502);
  });
});
