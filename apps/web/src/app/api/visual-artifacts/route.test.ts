import { beforeEach, describe, expect, it, vi } from 'vitest';

const { getAuthContext, proxyToFastapi } = vi.hoisted(() => ({ getAuthContext: vi.fn(), proxyToFastapi: vi.fn() }));
vi.mock('@/lib/auth-helpers', () => ({ getAuthContext }));
vi.mock('@/lib/fastapi-proxy', () => ({ proxyToFastapi }));

import { GET } from './route';

const agent = () => ({ id: 'a', type: 'agent' });
const enveloped = (data: unknown) =>
  new Response(JSON.stringify({ data, error: null, meta: null }), { status: 200, headers: { 'content-type': 'application/json' } });
const req = () => new Request('http://localhost/api/visual-artifacts?story_id=s1');

describe('GET /api/visual-artifacts (BE _ok() 이중 봉투 unwrap 회귀가드)', () => {
  beforeEach(() => { getAuthContext.mockReset(); proxyToFastapi.mockReset(); getAuthContext.mockResolvedValue(agent()); });

  it('401 when unauthenticated', async () => {
    getAuthContext.mockResolvedValue(null);
    expect((await GET(req())).status).toBe(401);
    expect(proxyToFastapi).not.toHaveBeenCalled();
  });

  it('unwraps the FastAPI _ok() envelope into a single envelope — the array must land directly on .data, not .data.data', async () => {
    const artifacts = [{ id: 'a1', title: 'X', story_id: 's1', epic_id: null, doc_id: null, source: 'created', latest_version_number: 1, anchor_version: null, created_by: null, created_at: '2026-07-10T00:00:00Z' }];
    proxyToFastapi.mockResolvedValue(enveloped(artifacts));
    const res = await GET(req());
    const json = await res.json() as { data: unknown };
    expect(Array.isArray(json.data)).toBe(true);
    expect(json.data).toEqual(artifacts);
  });

  it('falls back to an empty array (not a crash) when the upstream envelope has no data field', async () => {
    proxyToFastapi.mockResolvedValue(new Response(JSON.stringify({ error: null, meta: null }), { status: 200 }));
    const res = await GET(req());
    const json = await res.json() as { data: unknown };
    expect(json.data).toEqual([]);
  });

  it('passes through proxy errors (e.g. 404 when BE route unavailable)', async () => {
    proxyToFastapi.mockResolvedValue(new Response('not found', { status: 404 }));
    expect((await GET(req())).status).toBe(404);
  });
});
