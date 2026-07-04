import { beforeEach, describe, expect, it, vi } from 'vitest';

// 837a36c4(Group B b10): 혼합 핸들러 — PATCH=proxyToFastapi(verbatim) / GET·DELETE=DocsService 직접.
const h = vi.hoisted(() => ({
  getOrgProjectAuthContext: vi.fn(), createDocRepository: vi.fn(), proxyToFastapi: vi.fn(),
  getDocTimestamp: vi.fn(), deleteDoc: vi.fn(),
}));
vi.mock('@/lib/auth-helpers', () => ({ getOrgProjectAuthContext: h.getOrgProjectAuthContext }));
vi.mock('@/lib/storage/factory', () => ({ createDocRepository: h.createDocRepository }));
vi.mock('@/lib/fastapi-proxy', () => ({ proxyToFastapi: h.proxyToFastapi }));
vi.mock('@/services/docs', async (importActual) => ({
  ...(await importActual<typeof import('@/services/docs')>()),
  DocsService: class { getDocTimestamp = h.getDocTimestamp; deleteDoc = h.deleteDoc; },
}));

import { GET, PATCH, DELETE } from './route';

const ID = 'doc-1';
const ctx = () => ({ params: Promise.resolve({ id: ID }) });
const agent = () => ({ id: 'a', type: 'agent', rateLimitExceeded: false, rateLimitRemaining: 299, rateLimitResetAt: 0 });
const okRes = (b: unknown = { ok: 1 }) =>
  new Response(JSON.stringify(b), { status: 200, headers: { 'content-type': 'application/json' } });
const req = (m = 'GET') => new Request(`http://localhost/x/${ID}`, { method: m });

describe('/api/docs/[id] (혼합: proxy + DocsService)', () => {
  beforeEach(() => {
    Object.values(h).forEach((m) => m.mockReset());
    h.getOrgProjectAuthContext.mockResolvedValue(agent());
    h.createDocRepository.mockResolvedValue({});
  });

  it('PATCH: 401 when unauthenticated', async () => {
    h.getOrgProjectAuthContext.mockResolvedValue(null);
    expect((await PATCH(req('PATCH'), ctx())).status).toBe(401);
  });
  it('PATCH: proxies to /api/v2/docs/{id} verbatim (200)', async () => {
    h.proxyToFastapi.mockResolvedValue(okRes());
    const res = await PATCH(req('PATCH'), ctx());
    expect(res.status).toBe(200);
    expect(h.proxyToFastapi).toHaveBeenCalledWith(expect.anything(), `/api/v2/docs/${ID}`);
  });
  it('PATCH: passes through proxy 409 (slug taken) verbatim', async () => {
    h.proxyToFastapi.mockResolvedValue(new Response('conflict', { status: 409 }));
    expect((await PATCH(req('PATCH'), ctx())).status).toBe(409);
  });

  it('GET: 401 when unauthenticated', async () => {
    h.getOrgProjectAuthContext.mockResolvedValue(null);
    expect((await GET(req(), ctx())).status).toBe(401);
  });
  it('GET: returns timestamp via DocsService.getDocTimestamp(id)', async () => {
    h.getDocTimestamp.mockResolvedValue({ updated_at: '2026-06-11' });
    const res = await GET(req(), ctx());
    expect(res.status).toBe(200);
    expect(h.getDocTimestamp).toHaveBeenCalledWith(ID);
    expect((await res.json()).data).toMatchObject({ updated_at: '2026-06-11' });
  });

  it('DELETE: deletes via DocsService.deleteDoc(id) → {ok:true}', async () => {
    h.deleteDoc.mockResolvedValue(undefined);
    const res = await DELETE(req('DELETE'), ctx());
    expect(res.status).toBe(200);
    expect(h.deleteDoc).toHaveBeenCalledWith(ID);
    expect((await res.json()).data).toMatchObject({ ok: true });
  });
});
