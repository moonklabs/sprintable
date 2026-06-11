import { beforeEach, describe, expect, it, vi } from 'vitest';

// 837a36c4(Group B b6): proxy 위임 리팩토링 후 stale 재작성 — proxyToFastapi·auth 게이트·q 필수·embed_chain→embedChain 매핑.
const { getAuthContext, proxyToFastapi } = vi.hoisted(() => ({ getAuthContext: vi.fn(), proxyToFastapi: vi.fn() }));
vi.mock('@/lib/auth-helpers', () => ({ getAuthContext }));
vi.mock('@/lib/fastapi-proxy', () => ({ proxyToFastapi }));

import { GET } from './route';

const agent = () => ({ id: 'a', type: 'agent', rateLimitExceeded: false, rateLimitRemaining: 299, rateLimitResetAt: 0 });
const previewRes = () => new Response(
  JSON.stringify({ id: 'd1', title: 'T', icon: null, slug: 's', embed_chain: ['a', 'b'] }),
  { status: 200, headers: { 'content-type': 'application/json' } },
);
const req = (q = 'slug-x') => new Request(`http://localhost/api/docs/preview?q=${q}`);

describe('GET /api/docs/preview (proxy 위임)', () => {
  beforeEach(() => { getAuthContext.mockReset(); proxyToFastapi.mockReset(); getAuthContext.mockResolvedValue(agent()); });
  it('401 when unauthenticated', async () => {
    getAuthContext.mockResolvedValue(null);
    expect((await GET(req())).status).toBe(401);
  });
  it('400 when q missing', async () => {
    const res = await GET(new Request('http://localhost/api/docs/preview'));
    expect(res.status).toBe(400);
    expect(proxyToFastapi).not.toHaveBeenCalled();
  });
  it('delegates to /api/v2/docs/preview and maps embed_chain→embedChain', async () => {
    proxyToFastapi.mockResolvedValue(previewRes());
    const res = await GET(req());
    expect(res.status).toBe(200);
    expect(proxyToFastapi).toHaveBeenCalledWith(expect.anything(), '/api/v2/docs/preview');
    expect((await res.json()).data).toMatchObject({ id: 'd1', slug: 's', embedChain: ['a', 'b'] });
  });
  it('passes through proxy errors', async () => {
    proxyToFastapi.mockResolvedValue(new Response('e', { status: 404 }));
    expect((await GET(req())).status).toBe(404);
  });
});
