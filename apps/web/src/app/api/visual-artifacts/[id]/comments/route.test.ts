import { beforeEach, describe, expect, it, vi } from 'vitest';

const { getAuthContext, proxyToFastapi } = vi.hoisted(() => ({ getAuthContext: vi.fn(), proxyToFastapi: vi.fn() }));
vi.mock('@/lib/auth-helpers', () => ({ getAuthContext }));
vi.mock('@/lib/fastapi-proxy', () => ({ proxyToFastapi }));

import { GET, POST } from './route';

const agent = () => ({ id: 'a', type: 'agent' });
const enveloped = (data: unknown, status = 200) =>
  new Response(JSON.stringify({ data, error: null, meta: null }), { status, headers: { 'content-type': 'application/json' } });
const req = () => new Request('http://localhost/api/visual-artifacts/a1/comments');
const postReq = () => new Request('http://localhost/api/visual-artifacts/a1/comments', { method: 'POST', body: JSON.stringify({ content: 'hi' }) });
const params = { params: Promise.resolve({ id: 'a1' }) };

describe('GET/POST /api/visual-artifacts/[id]/comments (BE _ok() 이중 봉투 unwrap 회귀가드)', () => {
  beforeEach(() => { getAuthContext.mockReset(); proxyToFastapi.mockReset(); getAuthContext.mockResolvedValue(agent()); });

  it('GET 401 when unauthenticated', async () => {
    getAuthContext.mockResolvedValue(null);
    expect((await GET(req(), params)).status).toBe(401);
    expect(proxyToFastapi).not.toHaveBeenCalled();
  });

  it('GET unwraps the envelope — array lands directly on .data, not .data.data', async () => {
    const comments = [{ id: 'c1', artifact_id: 'a1', node_id: null, anchor_x: null, anchor_y: null, content: 'x', parent_id: null, resolved: false, resolved_by: null, resolved_at: null, created_by: 'm1', created_at: '2026-07-10T00:00:00Z' }];
    proxyToFastapi.mockResolvedValue(enveloped(comments));
    const res = await GET(req(), params);
    const json = await res.json() as { data: unknown };
    expect(json.data).toEqual(comments);
  });

  it('POST unwraps the envelope and passes through the 201 status', async () => {
    const created = { id: 'c1', artifact_id: 'a1', node_id: null, anchor_x: null, anchor_y: null, content: 'hi', parent_id: null, resolved: false, resolved_by: null, resolved_at: null, created_by: 'm1', created_at: '2026-07-10T00:00:00Z' };
    proxyToFastapi.mockResolvedValue(enveloped(created, 201));
    const res = await POST(postReq(), params);
    expect(res.status).toBe(201);
    const json = await res.json() as { data: unknown };
    expect(json.data).toEqual(created);
  });

  it('passes through proxy errors', async () => {
    proxyToFastapi.mockResolvedValue(new Response('not found', { status: 404 }));
    expect((await GET(req(), params)).status).toBe(404);
  });
});
