import { beforeEach, describe, expect, it, vi } from 'vitest';

// 837a36c4(Group B b4): proxy 위임 리팩토링 후 stale 재작성 — pure proxy.
const { proxyToFastapi } = vi.hoisted(() => ({ proxyToFastapi: vi.fn() }));
vi.mock('@/lib/fastapi-proxy', () => ({ proxyToFastapi }));

import { GET, PATCH } from './route';

const PATH = '/api/v2/hitl/policy';
const okRes = (b: unknown = { ok: 1 }) =>
  new Response(JSON.stringify(b), { status: 200, headers: { 'content-type': 'application/json' } });
const req = (m = 'GET') => new Request('http://localhost/x/hitl-policy', { method: m });

describe('/api/v1/hitl-policy (proxy 위임)', () => {
  beforeEach(() => proxyToFastapi.mockReset());
  for (const [name, fn] of [['GET', GET], ['PATCH', PATCH]] as const) {
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
