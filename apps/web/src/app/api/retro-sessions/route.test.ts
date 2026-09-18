import { beforeEach, describe, expect, it, vi } from 'vitest';

// 837a36c4(Group B b5): proxy 위임 리팩토링 후 stale 재작성 — auth 게이트 → proxyToFastapi → 래핑.
const { getOrgProjectAuthContext, proxyToFastapi } = vi.hoisted(() => ({ getOrgProjectAuthContext: vi.fn(), proxyToFastapi: vi.fn() }));
vi.mock('@/lib/auth-helpers', () => ({ getOrgProjectAuthContext }));
vi.mock('@/lib/fastapi-proxy', () => ({ proxyToFastapi }));

import { GET, POST } from './route';

const PATH = '/api/v2/retros';
const agent = () => ({ id: 'a', type: 'agent', rateLimitExceeded: false, rateLimitRemaining: 299, rateLimitResetAt: 0 });
const okRes = (b: unknown = { ok: 1 }) =>
  new Response(JSON.stringify(b), { status: 200, headers: { 'content-type': 'application/json' } });
const req = (m = 'GET') => new Request('http://localhost/api/retro-sessions?project_id=p', { method: m });

describe('/api/retro-sessions (proxy 위임)', () => {
  beforeEach(() => { getOrgProjectAuthContext.mockReset(); proxyToFastapi.mockReset(); getOrgProjectAuthContext.mockResolvedValue(agent()); });
  for (const [name, fn] of [['GET', GET], ['POST', POST]] as const) {
    it(`${name}: 401 when unauthenticated`, async () => {
      getOrgProjectAuthContext.mockResolvedValue(null);
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

  // story #3857 — BE list_sessions(retros.py, #2428 PR④)가 X-Total-Count·X-Next-Cursor를 내는데
  // 이 라우트가 body만 취해 버려 왔다. 실제로 meta로 옮기는지 + 헤더 無일 때 하위호환을 고정한다.
  describe('GET — 페이지네이션 meta(story #3857)', () => {
    it('헤더 有(꽉 찬 페이지) → meta.hasMore=true·nextCursor·totalCount 채움', async () => {
      const sessions = Array.from({ length: 1000 }, (_, i) => ({ id: `r${i}` }));
      proxyToFastapi.mockResolvedValue(new Response(JSON.stringify(sessions), {
        status: 200,
        headers: { 'content-type': 'application/json', 'x-total-count': '2100', 'x-next-cursor': '2026-09-14T00:00:00Z' },
      }));

      const res = await GET(new Request('http://localhost/api/retro-sessions?project_id=p&limit=1000'));
      const json = await res.json();

      expect(json.meta.hasMore).toBe(true);
      expect(json.meta.nextCursor).toBe('2026-09-14T00:00:00Z');
      expect(json.meta.totalCount).toBe(2100);
    });

    it('헤더 無(하위호환) → meta.hasMore=false·nextCursor/totalCount=null(더 있다고 단정하지 않음)', async () => {
      proxyToFastapi.mockResolvedValue(okRes([{ id: 'r1' }]));

      const res = await GET(req());
      const json = await res.json();

      expect(json.meta).toEqual({ limit: 1000, hasMore: false, nextCursor: null, totalCount: null });
    });
  });
});
