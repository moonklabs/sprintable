import { beforeEach, describe, expect, it, vi } from 'vitest';

// 837a36c4(Group B b6): proxy 위임 리팩토링 후 stale 재작성 — proxyToFastapiWithParams(경로 템플릿+{id})·auth 게이트.
const { getAuthContext, proxyToFastapiWithParams } = vi.hoisted(() => ({
  getAuthContext: vi.fn(), proxyToFastapiWithParams: vi.fn(),
}));
vi.mock('@/lib/auth-helpers', () => ({ getAuthContext }));
vi.mock('@/lib/fastapi-proxy', () => ({ proxyToFastapiWithParams }));

import { GET, PATCH, DELETE } from './route';

const ID = 'tm-1';
const TPL = '/api/v2/team-members/[id]';
const ctx = () => ({ params: Promise.resolve({ id: ID }) });
const agent = () => ({ id: 'a', type: 'agent', rateLimitExceeded: false, rateLimitRemaining: 299, rateLimitResetAt: 0 });
const okRes = (b: unknown = { ok: 1 }) =>
  new Response(JSON.stringify(b), { status: 200, headers: { 'content-type': 'application/json' } });
const req = (m = 'GET') => new Request(`http://localhost/x/${ID}`, { method: m });

describe('/api/team-members/[id] (proxyWithParams 위임)', () => {
  beforeEach(() => { getAuthContext.mockReset(); proxyToFastapiWithParams.mockReset(); getAuthContext.mockResolvedValue(agent()); });
  for (const [name, fn] of [['GET', GET], ['PATCH', PATCH], ['DELETE', DELETE]] as const) {
    it(`${name}: 401 when unauthenticated`, async () => {
      getAuthContext.mockResolvedValue(null);
      expect((await fn(req(name), ctx())).status).toBe(401);
      expect(proxyToFastapiWithParams).not.toHaveBeenCalled();
    });
    it(`${name}: delegates with path template + {id}`, async () => {
      proxyToFastapiWithParams.mockResolvedValue(okRes());
      const res = await fn(req(name), ctx());
      expect(res.status).toBe(200);
      expect(proxyToFastapiWithParams).toHaveBeenCalledWith(expect.anything(), TPL, { id: ID });
    });
    it(`${name}: passes through proxy errors`, async () => {
      proxyToFastapiWithParams.mockResolvedValue(new Response('e', { status: 404 }));
      expect((await fn(req(name), ctx())).status).toBe(404);
    });
  }
});
