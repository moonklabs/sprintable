import { beforeEach, describe, expect, it, vi } from 'vitest';

const { getAuthContext, proxyToFastapi } = vi.hoisted(() => ({ getAuthContext: vi.fn(), proxyToFastapi: vi.fn() }));
vi.mock('@/lib/auth-helpers', () => ({ getAuthContext }));
vi.mock('@/lib/fastapi-proxy', () => ({ proxyToFastapi }));

import { PATCH, DELETE } from './route';

const agent = () => ({ id: 'a', type: 'agent' });
const enveloped = (data: unknown) =>
  new Response(JSON.stringify({ data, error: null, meta: null }), { status: 200, headers: { 'content-type': 'application/json' } });
const patchReq = () => new Request('http://localhost/api/visual-artifacts/a1/pins/p1', { method: 'PATCH', body: JSON.stringify({ description: '수정된 스펙' }) });
const deleteReq = () => new Request('http://localhost/api/visual-artifacts/a1/pins/p1', { method: 'DELETE' });
const params = { params: Promise.resolve({ id: 'a1', pinId: 'p1' }) };

describe('PATCH/DELETE /api/visual-artifacts/[id]/pins/[pinId] (story 7fe16274, BE _ok() 이중 봉투 unwrap 회귀가드)', () => {
  beforeEach(() => { getAuthContext.mockReset(); proxyToFastapi.mockReset(); getAuthContext.mockResolvedValue(agent()); });

  it('PATCH 401 when unauthenticated', async () => {
    getAuthContext.mockResolvedValue(null);
    expect((await PATCH(patchReq(), params)).status).toBe(401);
    expect(proxyToFastapi).not.toHaveBeenCalled();
  });

  it('PATCH unwraps the envelope — the updated pin lands directly on .data', async () => {
    const updated = { id: 'p1', artifact_id: 'a1', version_id: 'v1', anchor_type: 'coord', anchor_x: 100, anchor_y: 50, node_id: null, description: '수정된 스펙' };
    proxyToFastapi.mockResolvedValue(enveloped(updated));
    const res = await PATCH(patchReq(), params);
    const json = await res.json() as { data: unknown };
    expect(json.data).toEqual(updated);
  });

  it('PATCH passes through proxy errors (e.g. 404 for a stale/past-version pin)', async () => {
    proxyToFastapi.mockResolvedValue(new Response('not found', { status: 404 }));
    expect((await PATCH(patchReq(), params)).status).toBe(404);
  });

  it('DELETE 401 when unauthenticated', async () => {
    getAuthContext.mockResolvedValue(null);
    expect((await DELETE(deleteReq(), params)).status).toBe(401);
    expect(proxyToFastapi).not.toHaveBeenCalled();
  });

  it('DELETE unwraps the envelope', async () => {
    proxyToFastapi.mockResolvedValue(enveloped({ ok: true, id: 'p1' }));
    const res = await DELETE(deleteReq(), params);
    const json = await res.json() as { data: unknown };
    expect(json.data).toEqual({ ok: true, id: 'p1' });
  });

  it('DELETE passes through proxy errors', async () => {
    proxyToFastapi.mockResolvedValue(new Response('not found', { status: 404 }));
    expect((await DELETE(deleteReq(), params)).status).toBe(404);
  });
});
