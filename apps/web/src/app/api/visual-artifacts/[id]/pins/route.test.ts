import { beforeEach, describe, expect, it, vi } from 'vitest';

const { getAuthContext, proxyToFastapi } = vi.hoisted(() => ({ getAuthContext: vi.fn(), proxyToFastapi: vi.fn() }));
vi.mock('@/lib/auth-helpers', () => ({ getAuthContext }));
vi.mock('@/lib/fastapi-proxy', () => ({ proxyToFastapi }));

import { GET, POST } from './route';

const agent = () => ({ id: 'a', type: 'agent' });
const enveloped = (data: unknown, status = 200) =>
  new Response(JSON.stringify({ data, error: null, meta: null }), { status, headers: { 'content-type': 'application/json' } });
const req = () => new Request('http://localhost/api/visual-artifacts/a1/pins');
const postReq = () => new Request('http://localhost/api/visual-artifacts/a1/pins', {
  method: 'POST', body: JSON.stringify({ anchor_type: 'coord', anchor_x: 100, anchor_y: 50, description: '헤더 스펙' }),
});
const params = { params: Promise.resolve({ id: 'a1' }) };

describe('GET/POST /api/visual-artifacts/[id]/pins (story 7fe16274, BE _ok() 이중 봉투 unwrap 회귀가드)', () => {
  beforeEach(() => { getAuthContext.mockReset(); proxyToFastapi.mockReset(); getAuthContext.mockResolvedValue(agent()); });

  it('GET 401 when unauthenticated', async () => {
    getAuthContext.mockResolvedValue(null);
    expect((await GET(req(), params)).status).toBe(401);
    expect(proxyToFastapi).not.toHaveBeenCalled();
  });

  it('GET unwraps the envelope — array lands directly on .data, not .data.data', async () => {
    const pins = [{ id: 'p1', artifact_id: 'a1', version_id: 'v1', anchor_type: 'coord', anchor_x: 100, anchor_y: 50, node_id: null, description: '헤더 스펙' }];
    proxyToFastapi.mockResolvedValue(enveloped(pins));
    const res = await GET(req(), params);
    const json = await res.json() as { data: unknown };
    expect(json.data).toEqual(pins);
  });

  it('POST unwraps the envelope and passes through the 201 status', async () => {
    const created = { id: 'p1', artifact_id: 'a1', version_id: 'v1', anchor_type: 'coord', anchor_x: 100, anchor_y: 50, node_id: null, description: '헤더 스펙' };
    proxyToFastapi.mockResolvedValue(enveloped(created, 201));
    const res = await POST(postReq(), params);
    expect(res.status).toBe(201);
    const json = await res.json() as { data: unknown };
    expect(json.data).toEqual(created);
  });

  it('passes through proxy errors (e.g. 422 for an empty description)', async () => {
    proxyToFastapi.mockResolvedValue(new Response('unprocessable', { status: 422 }));
    expect((await POST(postReq(), params)).status).toBe(422);
  });
});
