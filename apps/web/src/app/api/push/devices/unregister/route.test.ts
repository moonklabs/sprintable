import { beforeEach, describe, expect, it, vi } from 'vitest';

// story #4397 — /api/push/devices/unregister BFF: delegates to the backend and passes its 204 / errors through.
const { proxyToFastapi } = vi.hoisted(() => ({ proxyToFastapi: vi.fn() }));
vi.mock('@/lib/fastapi-proxy', () => ({ proxyToFastapi }));

import { POST } from './route';

const req = () => new Request('http://localhost/api/push/devices/unregister', { method: 'POST', body: '{}' });

describe('/api/push/devices/unregister (proxy)', () => {
  beforeEach(() => proxyToFastapi.mockReset());

  it('delegates to the backend and answers 204 with no body', async () => {
    proxyToFastapi.mockResolvedValue(new Response(null, { status: 204 }));
    const res = await POST(req());
    // public: no session exists when the app calls this — without it the proxy would answer 401 before FastAPI
    expect(proxyToFastapi).toHaveBeenCalledWith(expect.anything(), '/api/v2/push/devices/unregister', { public: true });
    expect(res.status).toBe(204);
    expect(await res.text()).toBe('');
  });

  it.each([422, 429, 500])('passes the backend %i through', async (status) => {
    proxyToFastapi.mockResolvedValue(new Response('e', { status }));
    expect((await POST(req())).status).toBe(status);
  });
});
