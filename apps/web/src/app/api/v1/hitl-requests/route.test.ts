import { beforeEach, describe, expect, it, vi } from 'vitest';

// 837a36c4(Group B b4): proxy 위임 리팩토링 후 stale 재작성 — pure proxy.
const { proxyToFastapi } = vi.hoisted(() => ({ proxyToFastapi: vi.fn() }));
vi.mock('@/lib/fastapi-proxy', () => ({ proxyToFastapi }));

import { GET } from './route';

const PATH = '/api/v2/hitl/requests';
const okRes = (b: unknown = { ok: 1 }) =>
  new Response(JSON.stringify(b), { status: 200, headers: { 'content-type': 'application/json' } });
const req = () => new Request('http://localhost/x/hitl-requests');

describe('GET /api/v1/hitl-requests (proxy 위임)', () => {
  beforeEach(() => proxyToFastapi.mockReset());
  it('delegates and wraps', async () => {
    proxyToFastapi.mockResolvedValue(okRes());
    const res = await GET(req());
    expect(res.status).toBe(200);
    expect(proxyToFastapi).toHaveBeenCalledWith(expect.anything(), PATH);
    expect((await res.json()).data).toMatchObject({ ok: 1 });
  });
  it('passes through proxy errors', async () => {
    proxyToFastapi.mockResolvedValue(new Response('e', { status: 502 }));
    expect((await GET(req())).status).toBe(502);
  });
});
