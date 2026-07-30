import { beforeEach, describe, expect, it, vi } from 'vitest';

// 결함 fix(2026-07-30, 라이브 픽셀 검증 중 발견) — 이 라우트 자체가 없어서 flow-epic-nodes.tsx가
// 백엔드 원본 경로(/api/v2/...)를 브라우저에서 직접 fetch했고 401(Missing Authorization
// header)로 실패했다. dashboard/route.test.ts와 같은 패턴(proxyToFastapi 위임 검증).
const { getOrgProjectAuthContext, proxyToFastapi } = vi.hoisted(() => ({ getOrgProjectAuthContext: vi.fn(), proxyToFastapi: vi.fn() }));
vi.mock('@/lib/auth-helpers', () => ({ getOrgProjectAuthContext }));
vi.mock('@/lib/fastapi-proxy', () => ({ proxyToFastapi }));

import { GET } from './route';

const PATH = '/api/v2/analytics/epic-flow-nodes';
const agent = () => ({ id: 'a', type: 'agent', rateLimitExceeded: false, rateLimitRemaining: 299, rateLimitResetAt: 0 });
const okRes = (b: unknown = { epic_id: 'e1', now: { total: 0, items: [] }, upcoming: { total: 0, items: [] }, past: { total: 0 } }) =>
  new Response(JSON.stringify(b), { status: 200, headers: { 'content-type': 'application/json' } });
const req = () => new Request('http://localhost/api/analytics/epic-flow-nodes?project_id=p&epic_id=e1&upcoming_limit=15');

describe('GET /api/analytics/epic-flow-nodes (proxy 위임)', () => {
  beforeEach(() => { getOrgProjectAuthContext.mockReset(); proxyToFastapi.mockReset(); getOrgProjectAuthContext.mockResolvedValue(agent()); });

  it('401 when unauthenticated', async () => {
    getOrgProjectAuthContext.mockResolvedValue(null);
    expect((await GET(req())).status).toBe(401);
    expect(proxyToFastapi).not.toHaveBeenCalled();
  });

  it('delegates to the backend path with the same request(query string forwarded by proxyToFastapi)', async () => {
    proxyToFastapi.mockResolvedValue(okRes());
    const res = await GET(req());
    expect(res.status).toBe(200);
    expect(proxyToFastapi).toHaveBeenCalledWith(expect.anything(), PATH);
    expect((await res.json()).data).toMatchObject({ epic_id: 'e1' });
  });

  it('passes through proxy errors', async () => {
    proxyToFastapi.mockResolvedValue(new Response('e', { status: 500 }));
    expect((await GET(req())).status).toBe(500);
  });
});
