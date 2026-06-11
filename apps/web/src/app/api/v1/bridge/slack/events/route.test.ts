import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// 837a36c4(Group B b11): bridge = raw fetch 패스스루(서명검증은 FastAPI). 슬랙 서명 헤더 포워딩·상태/json 반환.
import { POST } from './route';

const fetchMock = vi.fn();
beforeEach(() => { fetchMock.mockReset(); vi.stubGlobal('fetch', fetchMock); });
afterEach(() => vi.unstubAllGlobals());

const req = (body = '{"type":"event"}') => new Request('http://localhost/api/v1/bridge/slack/events', {
  method: 'POST', body,
  headers: { 'content-type': 'application/json', 'x-slack-signature': 'v0=sig', 'x-slack-request-timestamp': '1700000000' },
});

describe('POST /api/v1/bridge/slack/events (fetch 패스스루)', () => {
  it('forwards raw body + slack 서명 헤더 to FastAPI bridge', async () => {
    fetchMock.mockResolvedValue(new Response(JSON.stringify({ ok: true }), { status: 200 }));
    const res = await POST(req('RAWBODY'));
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true });
    const [url, init] = fetchMock.mock.calls[0];
    expect(String(url)).toContain('/api/v2/bridge/slack/events');
    expect(init.method).toBe('POST');
    expect(init.body).toBe('RAWBODY');
    expect(init.headers['x-slack-signature']).toBe('v0=sig');
    expect(init.headers['x-slack-request-timestamp']).toBe('1700000000');
  });
  it('passes upstream status through (e.g., 401 invalid signature)', async () => {
    fetchMock.mockResolvedValue(new Response(JSON.stringify({ error: 'bad sig' }), { status: 401 }));
    expect((await POST(req())).status).toBe(401);
  });
});
