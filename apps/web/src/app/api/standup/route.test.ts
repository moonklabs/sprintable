import { beforeEach, describe, expect, it, vi } from 'vitest';

// 837a36c4(Group B b2): proxy 위임 리팩토링 후 stale 테스트 재작성 — auth → proxyToFastapi → 래핑.
const { getOrgProjectAuthContext, proxyToFastapi } = vi.hoisted(() => ({
  getOrgProjectAuthContext: vi.fn(),
  proxyToFastapi: vi.fn(),
}));
vi.mock('@/lib/auth-helpers', () => ({ getOrgProjectAuthContext }));
vi.mock('@/lib/fastapi-proxy', () => ({ proxyToFastapi }));

import { GET, POST, PUT } from './route';

const PATH = '/api/v2/standups';
const agent = () => ({ id: 'a', type: 'agent', rateLimitExceeded: false, rateLimitRemaining: 299, rateLimitResetAt: 0 });
const okRes = (b: unknown = { ok: 1 }) =>
  new Response(JSON.stringify(b), { status: 200, headers: { 'content-type': 'application/json' } });
const req = (method = 'GET') => new Request('http://localhost/api/standup?project_id=p', { method });

describe('/api/standup (proxy 위임)', () => {
  beforeEach(() => {
    getOrgProjectAuthContext.mockReset();
    proxyToFastapi.mockReset();
    getOrgProjectAuthContext.mockResolvedValue(agent());
  });

  for (const [name, fn] of [['GET', GET], ['POST', POST], ['PUT', PUT]] as const) {
    it(`${name}: 401 when unauthenticated`, async () => {
      getOrgProjectAuthContext.mockResolvedValue(null);
      expect((await fn(req(name))).status).toBe(401);
      expect(proxyToFastapi).not.toHaveBeenCalled();
    });

    it(`${name}: delegates to ${PATH} and wraps success`, async () => {
      proxyToFastapi.mockResolvedValue(okRes());
      const res = await fn(req(name));
      expect(res.status).toBe(200);
      expect(proxyToFastapi).toHaveBeenCalledWith(expect.anything(), PATH);
      expect((await res.json()).data).toMatchObject({ ok: 1 });
    });

    it(`${name}: passes through proxy errors`, async () => {
      proxyToFastapi.mockResolvedValue(new Response('e', { status: 500 }));
      expect((await fn(req(name))).status).toBe(500);
    });
  }

  it('GET: 204 → {ok:true}', async () => {
    proxyToFastapi.mockResolvedValue(new Response(null, { status: 204 }));
    const res = await GET(req());
    expect(res.status).toBe(200);
    expect((await res.json()).data).toMatchObject({ ok: true });
  });
});
