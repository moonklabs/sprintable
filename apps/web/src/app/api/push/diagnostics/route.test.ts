import { beforeEach, describe, expect, it, vi } from 'vitest';

// story #4394 — /api/push/diagnostics BFF: delegates to the backend EE receiver and passes its 204 / errors through.
const { proxyToFastapi } = vi.hoisted(() => ({ proxyToFastapi: vi.fn() }));
vi.mock('@/lib/fastapi-proxy', () => ({ proxyToFastapi }));

import { POST } from './route';

const PATH = '/api/v2/push/diagnostics';
const req = () => new Request('http://localhost/api/push/diagnostics', { method: 'POST', body: '{}' });

describe('/api/push/diagnostics (proxy)', () => {
  beforeEach(() => proxyToFastapi.mockReset());

  it('delegates to the backend receiver and answers 204 with no body', async () => {
    proxyToFastapi.mockResolvedValue(new Response(null, { status: 204 }));
    const res = await POST(req());
    expect(proxyToFastapi).toHaveBeenCalledWith(expect.anything(), PATH);
    expect(res.status).toBe(204);
    expect(await res.text()).toBe('');
  });

  it.each([401, 422, 429, 500])('passes the backend %i through', async (status) => {
    proxyToFastapi.mockResolvedValue(new Response('e', { status }));
    expect((await POST(req())).status).toBe(status);
  });
});
