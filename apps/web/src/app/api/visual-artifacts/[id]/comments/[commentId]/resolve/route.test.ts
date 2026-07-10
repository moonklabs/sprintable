import { beforeEach, describe, expect, it, vi } from 'vitest';

const { getAuthContext, proxyToFastapi } = vi.hoisted(() => ({ getAuthContext: vi.fn(), proxyToFastapi: vi.fn() }));
vi.mock('@/lib/auth-helpers', () => ({ getAuthContext }));
vi.mock('@/lib/fastapi-proxy', () => ({ proxyToFastapi }));

import { POST } from './route';

const agent = () => ({ id: 'a', type: 'agent' });
const enveloped = (data: unknown) =>
  new Response(JSON.stringify({ data, error: null, meta: null }), { status: 200, headers: { 'content-type': 'application/json' } });
const req = () => new Request('http://localhost/api/visual-artifacts/a1/comments/c1/resolve', { method: 'POST' });
const params = { params: Promise.resolve({ id: 'a1', commentId: 'c1' }) };

describe('POST /api/visual-artifacts/[id]/comments/[commentId]/resolve (BE _ok() 이중 봉투 unwrap 회귀가드)', () => {
  beforeEach(() => { getAuthContext.mockReset(); proxyToFastapi.mockReset(); getAuthContext.mockResolvedValue(agent()); });

  it('401 when unauthenticated', async () => {
    getAuthContext.mockResolvedValue(null);
    expect((await POST(req(), params)).status).toBe(401);
    expect(proxyToFastapi).not.toHaveBeenCalled();
  });

  it('unwraps the envelope — the resolved comment lands directly on .data', async () => {
    const resolved = { id: 'c1', artifact_id: 'a1', node_id: null, anchor_x: null, anchor_y: null, content: 'x', parent_id: null, resolved: true, resolved_by: 'm2', resolved_at: '2026-07-10T00:00:00Z', created_by: 'm1', created_at: '2026-07-10T00:00:00Z' };
    proxyToFastapi.mockResolvedValue(enveloped(resolved));
    const res = await POST(req(), params);
    const json = await res.json() as { data: unknown };
    expect(json.data).toEqual(resolved);
  });

  it('passes through proxy errors (e.g. 404 for an unknown comment)', async () => {
    proxyToFastapi.mockResolvedValue(new Response('not found', { status: 404 }));
    expect((await POST(req(), params)).status).toBe(404);
  });
});
