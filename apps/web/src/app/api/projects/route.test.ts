import { beforeEach, describe, expect, it, vi } from 'vitest';

// 837a36c4(Group B b5): proxy 위임 리팩토링 후 stale 재작성. GET=순수 proxy / POST=auth 게이트+org_id
// 보강 후 위임. 둘 다 /api/v2/projects.
const { getAuthContext, proxyToFastapi } = vi.hoisted(() => ({ getAuthContext: vi.fn(), proxyToFastapi: vi.fn() }));
vi.mock('@/lib/auth-helpers', () => ({ getAuthContext }));
vi.mock('@/lib/fastapi-proxy', () => ({ proxyToFastapi }));

import { GET, POST } from './route';

const PATH = '/api/v2/projects';
const me = () => ({ id: 'a', org_id: 'org-1', type: 'human', rateLimitExceeded: false, rateLimitRemaining: 299, rateLimitResetAt: 0 });
const okRes = (b: unknown = { ok: 1 }) =>
  new Response(JSON.stringify(b), { status: 200, headers: { 'content-type': 'application/json' } });

describe('/api/projects (proxy 위임)', () => {
  beforeEach(() => { getAuthContext.mockReset(); proxyToFastapi.mockReset(); getAuthContext.mockResolvedValue(me()); });

  it('GET: delegates to /api/v2/projects and wraps (게이트 없음)', async () => {
    proxyToFastapi.mockResolvedValue(okRes());
    const res = await GET(new Request('http://localhost/api/projects'));
    expect(res.status).toBe(200);
    expect(proxyToFastapi).toHaveBeenCalledWith(expect.anything(), PATH);
    expect((await res.json()).data).toMatchObject({ ok: 1 });
  });

  it('GET: passes through proxy errors', async () => {
    proxyToFastapi.mockResolvedValue(new Response('e', { status: 500 }));
    expect((await GET(new Request('http://localhost/api/projects'))).status).toBe(500);
  });

  it('POST: 401 when unauthenticated', async () => {
    getAuthContext.mockResolvedValue(null);
    const res = await POST(new Request('http://localhost/api/projects', { method: 'POST', body: '{}' }));
    expect(res.status).toBe(401);
    expect(proxyToFastapi).not.toHaveBeenCalled();
  });

  it('POST: delegates to /api/v2/projects and wraps', async () => {
    proxyToFastapi.mockResolvedValue(okRes());
    const res = await POST(new Request('http://localhost/api/projects', { method: 'POST', body: JSON.stringify({ name: 'p' }) }));
    expect(res.status).toBe(200);
    expect(proxyToFastapi).toHaveBeenCalledWith(expect.anything(), PATH);
  });
});
