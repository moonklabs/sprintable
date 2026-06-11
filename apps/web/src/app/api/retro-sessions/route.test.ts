import { beforeEach, describe, expect, it, vi } from 'vitest';

// 837a36c4(Group B b5): proxy 위임 리팩토링 후 stale 재작성 — auth 게이트 → proxyToFastapi → 래핑.
const { getAuthContext, proxyToFastapi } = vi.hoisted(() => ({ getAuthContext: vi.fn(), proxyToFastapi: vi.fn() }));
vi.mock('@/lib/auth-helpers', () => ({ getAuthContext }));
vi.mock('@/lib/fastapi-proxy', () => ({ proxyToFastapi }));

import { GET, POST } from './route';

const PATH = '/api/v2/retros';
const agent = () => ({ id: 'a', type: 'agent', rateLimitExceeded: false, rateLimitRemaining: 299, rateLimitResetAt: 0 });
const okRes = (b: unknown = { ok: 1 }) =>
  new Response(JSON.stringify(b), { status: 200, headers: { 'content-type': 'application/json' } });
const req = (m = 'GET') => new Request('http://localhost/api/retro-sessions?project_id=p', { method: m });

describe('/api/retro-sessions (proxy 위임)', () => {
  beforeEach(() => { getAuthContext.mockReset(); proxyToFastapi.mockReset(); getAuthContext.mockResolvedValue(agent()); });
  for (const [name, fn] of [['GET', GET], ['POST', POST]] as const) {
    it(`${name}: 401 when unauthenticated`, async () => {
      getAuthContext.mockResolvedValue(null);
      expect((await fn(req(name))).status).toBe(401);
    });
    it(`${name}: delegates to ${PATH} and wraps`, async () => {
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
});
