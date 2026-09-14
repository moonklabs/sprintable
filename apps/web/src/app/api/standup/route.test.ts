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

  // story #3857 — BE list_standups(story #3841)가 X-Total-Count·X-Next-Cursor를 내는데
  // 이 라우트가 body만 취해 버려 왔다. 실제로 meta로 옮기는지 + 헤더 無일 때 하위호환을 고정한다.
  describe('GET — 페이지네이션 meta(story #3857)', () => {
    it('헤더 有(꽉 찬 페이지) → meta.hasMore=true·nextCursor·totalCount 채움', async () => {
      const entries = Array.from({ length: 1000 }, (_, i) => ({ id: `e${i}` }));
      proxyToFastapi.mockResolvedValue(new Response(JSON.stringify(entries), {
        status: 200,
        headers: { 'content-type': 'application/json', 'x-total-count': '4200', 'x-next-cursor': '2026-09-14|c1|s1' },
      }));

      const res = await GET(new Request('http://localhost/api/standup?project_id=p&limit=1000'));
      const json = await res.json();

      expect(json.meta.hasMore).toBe(true);
      expect(json.meta.nextCursor).toBe('2026-09-14|c1|s1');
      expect(json.meta.totalCount).toBe(4200);
    });

    it('헤더 無(하위호환) → meta.hasMore=false·nextCursor/totalCount=null(더 있다고 단정하지 않음)', async () => {
      proxyToFastapi.mockResolvedValue(okRes([{ id: 'e1' }]));

      const res = await GET(req());
      const json = await res.json();

      expect(json.meta).toEqual({ limit: 1000, hasMore: false, nextCursor: null, totalCount: null });
    });
  });
});
