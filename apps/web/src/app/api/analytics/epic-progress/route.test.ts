import { beforeEach, describe, expect, it, vi } from 'vitest';

// 837a36c4(Group B): 라우트가 FastAPI proxy 위임으로 리팩토링됨 — 테스트를 현 계약
// (auth → proxyToFastapi → apiSuccess 래핑)에 맞춰 재작성. 구 createDbServerClient 직쿼리
// mock은 폐기(라우트가 더는 DB를 직접 안 쓰며, 비즈니스 로직은 FastAPI backend pytest가 검증).
const { getOrgProjectAuthContext, proxyToFastapi } = vi.hoisted(() => ({
  getOrgProjectAuthContext: vi.fn(),
  proxyToFastapi: vi.fn(),
}));
vi.mock('@/lib/auth-helpers', () => ({ getOrgProjectAuthContext }));
vi.mock('@/lib/fastapi-proxy', () => ({ proxyToFastapi }));

import { GET } from './route';

const PROXY_PATH = '/api/v2/analytics/epic-progress';
const URL = 'http://localhost/api/analytics/epic-progress?project_id=p';
const agent = () => ({ id: 'a', type: 'agent', rateLimitExceeded: false, rateLimitRemaining: 299, rateLimitResetAt: 0 });

describe('GET /api/analytics/epic-progress', () => {
  beforeEach(() => {
    getOrgProjectAuthContext.mockReset();
    proxyToFastapi.mockReset();
    getOrgProjectAuthContext.mockResolvedValue(agent());
  });

  it('returns 401 when unauthenticated', async () => {
    getOrgProjectAuthContext.mockResolvedValue(null);
    expect((await GET(new Request(URL))).status).toBe(401);
    expect(proxyToFastapi).not.toHaveBeenCalled();
  });

  it('returns 429 when rate limited', async () => {
    getOrgProjectAuthContext.mockResolvedValue({ ...agent(), rateLimitExceeded: true });
    expect((await GET(new Request(URL))).status).toBe(429);
  });

  it('delegates to FastAPI proxy and wraps success in {data}', async () => {
    proxyToFastapi.mockResolvedValue(
      new Response(JSON.stringify({ ok: 1 }), { status: 200, headers: { 'content-type': 'application/json' } }),
    );
    const res = await GET(new Request(URL));
    expect(res.status).toBe(200);
    expect(proxyToFastapi).toHaveBeenCalledWith(expect.anything(), PROXY_PATH);
    expect((await res.json()).data).toMatchObject({ ok: 1 });
  });

  it('passes through proxy error responses unchanged', async () => {
    proxyToFastapi.mockResolvedValue(new Response('err', { status: 502 }));
    expect((await GET(new Request(URL))).status).toBe(502);
  });
});
