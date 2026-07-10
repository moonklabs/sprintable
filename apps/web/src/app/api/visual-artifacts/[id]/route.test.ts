import { beforeEach, describe, expect, it, vi } from 'vitest';

const { getAuthContext, proxyToFastapi } = vi.hoisted(() => ({ getAuthContext: vi.fn(), proxyToFastapi: vi.fn() }));
vi.mock('@/lib/auth-helpers', () => ({ getAuthContext }));
vi.mock('@/lib/fastapi-proxy', () => ({ proxyToFastapi }));

import { GET } from './route';

const agent = () => ({ id: 'a', type: 'agent' });
const enveloped = (data: unknown) =>
  new Response(JSON.stringify({ data, error: null, meta: null }), { status: 200, headers: { 'content-type': 'application/json' } });
const req = () => new Request('http://localhost/api/visual-artifacts/a1');
const params = { params: Promise.resolve({ id: 'a1' }) };

describe('GET /api/visual-artifacts/[id] (BE _ok() 이중 봉투 unwrap 회귀가드)', () => {
  beforeEach(() => { getAuthContext.mockReset(); proxyToFastapi.mockReset(); getAuthContext.mockResolvedValue(agent()); });

  it('401 when unauthenticated', async () => {
    getAuthContext.mockResolvedValue(null);
    expect((await GET(req(), params)).status).toBe(401);
    expect(proxyToFastapi).not.toHaveBeenCalled();
  });

  it('unwraps the FastAPI _ok() envelope — the detail object lands directly on .data, not .data.data', async () => {
    const detail = { id: 'a1', title: 'X', story_id: 's1', epic_id: null, doc_id: null, source: 'created', latest_version_number: 1, anchor_version: null, created_by: null, created_at: '2026-07-10T00:00:00Z', version_number: 1, version_summary: null, nodes: [] };
    proxyToFastapi.mockResolvedValue(enveloped(detail));
    const res = await GET(req(), params);
    const json = await res.json() as { data: unknown };
    expect(json.data).toEqual(detail);
  });

  it('passes through proxy errors (e.g. 404 for an unknown id)', async () => {
    proxyToFastapi.mockResolvedValue(new Response('not found', { status: 404 }));
    expect((await GET(req(), params)).status).toBe(404);
  });
});
