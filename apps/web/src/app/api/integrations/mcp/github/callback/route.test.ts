import { beforeEach, describe, expect, it, vi } from 'vitest';

// 837a36c4(Group B b12): integrations/mcp/github/callback는 pure proxy(public:true OAuth 콜백).
const { proxyToFastapi } = vi.hoisted(() => ({ proxyToFastapi: vi.fn() }));
vi.mock('@/lib/fastapi-proxy', () => ({ proxyToFastapi }));

import { GET } from './route';

const PATH = '/api/v2/integrations/mcp/github/callback';
const okRes = (b: unknown = { ok: 1 }) =>
  new Response(JSON.stringify(b), { status: 200, headers: { 'content-type': 'application/json' } });
const req = () => new Request('http://localhost/api/integrations/mcp/github/callback?code=x&state=y');

describe('GET /api/integrations/mcp/github/callback (proxy 위임·public)', () => {
  beforeEach(() => proxyToFastapi.mockReset());
  it('delegates with { public: true } and wraps', async () => {
    proxyToFastapi.mockResolvedValue(okRes());
    const res = await GET(req());
    expect(res.status).toBe(200);
    expect(proxyToFastapi).toHaveBeenCalledWith(expect.anything(), PATH, { public: true });
    expect((await res.json()).data).toMatchObject({ ok: 1 });
  });
  it('passes through proxy errors', async () => {
    proxyToFastapi.mockResolvedValue(new Response('e', { status: 400 }));
    expect((await GET(req())).status).toBe(400);
  });
});
