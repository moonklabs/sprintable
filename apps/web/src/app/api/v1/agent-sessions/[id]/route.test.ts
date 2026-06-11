import { beforeEach, describe, expect, it, vi } from 'vitest';

// 837a36c4(Group B b3): proxy 위임 리팩토링 후 stale 재작성 — dynamic [id] params·pure proxy.
const { proxyToFastapi } = vi.hoisted(() => ({ proxyToFastapi: vi.fn() }));
vi.mock('@/lib/fastapi-proxy', () => ({ proxyToFastapi }));

import { PATCH } from './route';

const ID = 'session-1';
const ctx = () => ({ params: Promise.resolve({ id: ID }) });
const okRes = (b: unknown = { ok: 1 }) =>
  new Response(JSON.stringify(b), { status: 200, headers: { 'content-type': 'application/json' } });
const req = () => new Request(`http://localhost/x/${ID}`, { method: 'PATCH' });

describe('/api/v1/agent-sessions/[id] (proxy 위임)', () => {
  beforeEach(() => proxyToFastapi.mockReset());
  it('PATCH: delegates to /api/v2/agent-sessions/{id} and wraps', async () => {
    proxyToFastapi.mockResolvedValue(okRes());
    const res = await PATCH(req(), ctx());
    expect(res.status).toBe(200);
    expect(proxyToFastapi).toHaveBeenCalledWith(expect.anything(), `/api/v2/agent-sessions/${ID}`);
  });
  it('PATCH: passes through proxy errors', async () => {
    proxyToFastapi.mockResolvedValue(new Response('e', { status: 404 }));
    expect((await PATCH(req(), ctx())).status).toBe(404);
  });
});
