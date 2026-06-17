import { beforeEach, describe, expect, it, vi } from 'vitest';

// 837a36c4(Group B b12): cron route는 pure proxy(자체 로직 아님) — proxyToFastapi 위임·{data} 래핑·204→{ok}.
const { proxyToFastapi } = vi.hoisted(() => ({ proxyToFastapi: vi.fn() }));
vi.mock('@/lib/fastapi-proxy', () => ({ proxyToFastapi }));

import { GET } from './route';

const PATH = '/api/v2/internal/cron/hitl-timeouts';
const okRes = (b: unknown = { ok: 1 }) =>
  new Response(JSON.stringify(b), { status: 200, headers: { 'content-type': 'application/json' } });
const req = () => new Request('http://localhost/api/cron/hitl-timeouts');

describe('GET /api/cron/hitl-timeouts (proxy 위임)', () => {
  beforeEach(() => proxyToFastapi.mockReset());
  it('delegates and wraps', async () => {
    proxyToFastapi.mockResolvedValue(okRes());
    const res = await GET(req());
    expect(res.status).toBe(200);
    expect(proxyToFastapi).toHaveBeenCalledWith(expect.anything(), PATH);
    expect((await res.json()).data).toMatchObject({ ok: 1 });
  });
  it('204 → {ok:true}', async () => {
    proxyToFastapi.mockResolvedValue(new Response(null, { status: 204 }));
    const res = await GET(req());
    expect(res.status).toBe(200);
    expect((await res.json()).data).toMatchObject({ ok: true });
  });
  it('passes through proxy errors', async () => {
    proxyToFastapi.mockResolvedValue(new Response('e', { status: 500 }));
    expect((await GET(req())).status).toBe(500);
  });
});
