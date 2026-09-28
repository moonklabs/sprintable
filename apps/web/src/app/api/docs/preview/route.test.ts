import { beforeEach, describe, expect, it, vi } from 'vitest';

// 837a36c4(Group B b6): proxy 위임 리팩토링 후 stale 재작성 — proxyToFastapi·auth 게이트·q 필수.
// [SID:4381] embed_chain(늘 [] 고정이던 순환 정보)은 걷었다 — 응답에 embedChain이 없다.
const { getOrgProjectAuthContext, proxyToFastapi } = vi.hoisted(() => ({ getOrgProjectAuthContext: vi.fn(), proxyToFastapi: vi.fn() }));
vi.mock('@/lib/auth-helpers', () => ({ getOrgProjectAuthContext }));
vi.mock('@/lib/fastapi-proxy', () => ({ proxyToFastapi }));

import { GET } from './route';

const agent = () => ({ id: 'a', type: 'agent', rateLimitExceeded: false, rateLimitRemaining: 299, rateLimitResetAt: 0 });
const previewRes = () => new Response(
  JSON.stringify({ id: 'd1', title: 'T', icon: null, slug: 's', project_id: 'p1', org_slug: 'o', project_slug: 'p' }),
  { status: 200, headers: { 'content-type': 'application/json' } },
);
const req = (q = 'slug-x') => new Request(`http://localhost/api/docs/preview?q=${q}`);

describe('GET /api/docs/preview (proxy 위임)', () => {
  beforeEach(() => { getOrgProjectAuthContext.mockReset(); proxyToFastapi.mockReset(); getOrgProjectAuthContext.mockResolvedValue(agent()); });
  it('401 when unauthenticated', async () => {
    getOrgProjectAuthContext.mockResolvedValue(null);
    expect((await GET(req())).status).toBe(401);
  });
  it('400 when q missing', async () => {
    const res = await GET(new Request('http://localhost/api/docs/preview'));
    expect(res.status).toBe(400);
    expect(proxyToFastapi).not.toHaveBeenCalled();
  });
  it('delegates to /api/v2/docs/preview — 순환 정보(embedChain) 없이 id · 제목 · slug · 프로젝트만([SID:4381])', async () => {
    proxyToFastapi.mockResolvedValue(previewRes());
    const res = await GET(req());
    expect(res.status).toBe(200);
    expect(proxyToFastapi).toHaveBeenCalledWith(expect.anything(), '/api/v2/docs/preview');
    const data = (await res.json()).data;
    expect(data).toMatchObject({ id: 'd1', slug: 's', projectId: 'p1' });
    expect(data).not.toHaveProperty('embedChain');
  });
  it('passes through proxy errors', async () => {
    proxyToFastapi.mockResolvedValue(new Response('e', { status: 404 }));
    expect((await GET(req())).status).toBe(404);
  });
});
