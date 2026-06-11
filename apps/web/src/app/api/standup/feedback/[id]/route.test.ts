import { beforeEach, describe, expect, it, vi } from 'vitest';

// 837a36c4(Group B b2): proxy 위임 리팩토링 후 stale 테스트 재작성. dynamic [id] → params 동봉,
// /api/v2/standups/feedback/{id}로 위임(auth 게이트 없음).
const { proxyToFastapi } = vi.hoisted(() => ({ proxyToFastapi: vi.fn() }));
vi.mock('@/lib/fastapi-proxy', () => ({ proxyToFastapi }));

import { GET, PATCH, DELETE } from './route';

const ID = 'entry-123';
const ctx = () => ({ params: Promise.resolve({ id: ID }) });
const okRes = (b: unknown = { ok: 1 }) =>
  new Response(JSON.stringify(b), { status: 200, headers: { 'content-type': 'application/json' } });
const req = (method = 'GET') => new Request(`http://localhost/api/standup/feedback/${ID}`, { method });

describe('/api/standup/feedback/[id] (proxy 위임)', () => {
  beforeEach(() => proxyToFastapi.mockReset());

  for (const [name, fn] of [['GET', GET], ['PATCH', PATCH], ['DELETE', DELETE]] as const) {
    it(`${name}: delegates to /api/v2/standups/feedback/${ID} and wraps`, async () => {
      proxyToFastapi.mockResolvedValue(okRes());
      const res = await fn(req(name), ctx());
      expect(res.status).toBe(200);
      expect(proxyToFastapi).toHaveBeenCalledWith(expect.anything(), `/api/v2/standups/feedback/${ID}`);
    });

    it(`${name}: passes through proxy errors`, async () => {
      proxyToFastapi.mockResolvedValue(new Response('e', { status: 404 }));
      expect((await fn(req(name), ctx())).status).toBe(404);
    });
  }

  it('GET: 204 → {ok:true}', async () => {
    proxyToFastapi.mockResolvedValue(new Response(null, { status: 204 }));
    const res = await GET(req(), ctx());
    expect(res.status).toBe(200);
    expect((await res.json()).data).toMatchObject({ ok: true });
  });
});
