import { beforeEach, describe, expect, it, vi } from 'vitest';

// 837a36c4(Group B b12): webhooks/agent-runtime는 pure proxy(POST 위임).
const { proxyToFastapi } = vi.hoisted(() => ({ proxyToFastapi: vi.fn() }));
vi.mock('@/lib/fastapi-proxy', () => ({ proxyToFastapi }));

import { POST } from './route';

const PATH = '/api/v2/webhooks/agent-runtime';
const okRes = (b: unknown = { ok: 1 }) =>
  new Response(JSON.stringify(b), { status: 200, headers: { 'content-type': 'application/json' } });
const req = () => new Request('http://localhost/api/webhooks/agent-runtime', { method: 'POST', body: '{}' });

describe('POST /api/webhooks/agent-runtime (proxy 위임)', () => {
  beforeEach(() => proxyToFastapi.mockReset());
  it('delegates and wraps', async () => {
    proxyToFastapi.mockResolvedValue(okRes());
    const res = await POST(req());
    expect(res.status).toBe(200);
    expect(proxyToFastapi).toHaveBeenCalledWith(expect.anything(), PATH);
    expect((await res.json()).data).toMatchObject({ ok: 1 });
  });
  it('204 → {ok:true}', async () => {
    proxyToFastapi.mockResolvedValue(new Response(null, { status: 204 }));
    expect((await (await POST(req())).json()).data).toMatchObject({ ok: true });
  });
  it('passes through proxy errors', async () => {
    proxyToFastapi.mockResolvedValue(new Response('e', { status: 500 }));
    expect((await POST(req())).status).toBe(500);
  });
});
