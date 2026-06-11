import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// 837a36c4(Group B b11): bridge = raw fetch 패스스루. teams는 authorization 헤더 포워딩.
import { POST } from './route';

const fetchMock = vi.fn();
beforeEach(() => { fetchMock.mockReset(); vi.stubGlobal('fetch', fetchMock); });
afterEach(() => vi.unstubAllGlobals());

const req = (body = '{"type":"message"}') => new Request('http://localhost/api/v1/bridge/teams/events', {
  method: 'POST', body,
  headers: { 'content-type': 'application/json', authorization: 'Bearer aad-token' },
});

describe('POST /api/v1/bridge/teams/events (fetch 패스스루)', () => {
  it('forwards raw body + authorization to FastAPI bridge', async () => {
    fetchMock.mockResolvedValue(new Response(JSON.stringify({ ok: true }), { status: 200 }));
    const res = await POST(req('RAW'));
    expect(res.status).toBe(200);
    const [url, init] = fetchMock.mock.calls[0];
    expect(String(url)).toContain('/api/v2/bridge/teams/events');
    expect(init.method).toBe('POST');
    expect(init.body).toBe('RAW');
    expect(init.headers['authorization']).toBe('Bearer aad-token');
  });
  it('passes upstream status through (e.g., 401)', async () => {
    fetchMock.mockResolvedValue(new Response('{}', { status: 401 }));
    expect((await POST(req())).status).toBe(401);
  });
});
