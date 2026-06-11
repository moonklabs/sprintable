import { beforeEach, describe, expect, it, vi } from 'vitest';

// 837a36c4(Group B b6): proxy 위임 리팩토링 후 stale 재작성 — proxyToFastapiWithParams·auth 게이트. POST는 201.
const { getAuthContext, proxyToFastapiWithParams } = vi.hoisted(() => ({
  getAuthContext: vi.fn(), proxyToFastapiWithParams: vi.fn(),
}));
vi.mock('@/lib/auth-helpers', () => ({ getAuthContext }));
vi.mock('@/lib/fastapi-proxy', () => ({ proxyToFastapiWithParams }));

import { GET, POST } from './route';

const ID = 'doc-1';
const TPL = '/api/v2/docs/[id]/comments';
const ctx = () => ({ params: Promise.resolve({ id: ID }) });
const agent = () => ({ id: 'a', type: 'agent', rateLimitExceeded: false, rateLimitRemaining: 299, rateLimitResetAt: 0 });
const okRes = (b: unknown = { ok: 1 }) =>
  new Response(JSON.stringify(b), { status: 200, headers: { 'content-type': 'application/json' } });
const req = (m = 'GET') => new Request(`http://localhost/x/${ID}/comments`, { method: m });

describe('/api/docs/[id]/comments (proxyWithParams 위임)', () => {
  beforeEach(() => { getAuthContext.mockReset(); proxyToFastapiWithParams.mockReset(); getAuthContext.mockResolvedValue(agent()); });
  for (const [name, fn] of [['GET', GET], ['POST', POST]] as const) {
    it(`${name}: 401 when unauthenticated`, async () => {
      getAuthContext.mockResolvedValue(null);
      expect((await fn(req(name), ctx())).status).toBe(401);
      expect(proxyToFastapiWithParams).not.toHaveBeenCalled();
    });
    it(`${name}: delegates with path template + {id}`, async () => {
      proxyToFastapiWithParams.mockResolvedValue(okRes());
      const res = await fn(req(name), ctx());
      expect(proxyToFastapiWithParams).toHaveBeenCalledWith(expect.anything(), TPL, { id: ID });
      expect((await res.json()).data).toMatchObject({ ok: 1 });
    });
    it(`${name}: passes through proxy errors`, async () => {
      proxyToFastapiWithParams.mockResolvedValue(new Response('e', { status: 404 }));
      expect((await fn(req(name), ctx())).status).toBe(404);
    });
  }
  it('POST: wraps success as 201', async () => {
    proxyToFastapiWithParams.mockResolvedValue(okRes());
    expect((await POST(req('POST'), ctx())).status).toBe(201);
  });
});
