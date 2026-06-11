import { beforeEach, describe, expect, it, vi } from 'vitest';

// 837a36c4(Group B b4): proxy 위임 리팩토링 후 stale 재작성 — dynamic [id] params·pure proxy.
const { proxyToFastapi } = vi.hoisted(() => ({ proxyToFastapi: vi.fn() }));
vi.mock('@/lib/fastapi-proxy', () => ({ proxyToFastapi }));

import { POST } from './route';

const ID = 'dep-1';
const ctx = () => ({ params: Promise.resolve({ id: ID }) });
const okRes = (b: unknown = { ok: 1 }) =>
  new Response(JSON.stringify(b), { status: 200, headers: { 'content-type': 'application/json' } });
const req = () => new Request(`http://localhost/x/${ID}/verification`, { method: 'POST' });

describe('/api/v1/agent-deployments/[id]/verification (proxy 위임)', () => {
  beforeEach(() => proxyToFastapi.mockReset());
  it('POST: delegates to /api/v2/agent-deployments/{id}/verification and wraps', async () => {
    proxyToFastapi.mockResolvedValue(okRes());
    const res = await POST(req(), ctx());
    expect(res.status).toBe(200);
    expect(proxyToFastapi).toHaveBeenCalledWith(expect.anything(), `/api/v2/agent-deployments/${ID}/verification`);
  });
  it('POST: passes through proxy errors', async () => {
    proxyToFastapi.mockResolvedValue(new Response('e', { status: 422 }));
    expect((await POST(req(), ctx())).status).toBe(422);
  });
});
