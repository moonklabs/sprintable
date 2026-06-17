import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// 837a36c4(Group B b11): bridge = raw fetch 패스스루. interactions(form-urlencoded 기본)·슬랙 서명 포워딩.
import { POST } from './route';

const fetchMock = vi.fn();
beforeEach(() => { fetchMock.mockReset(); vi.stubGlobal('fetch', fetchMock); });
afterEach(() => vi.unstubAllGlobals());

const req = (body = 'payload=%7B%7D') => new Request('http://localhost/api/v1/bridge/slack/interactions', {
  method: 'POST', body,
  headers: { 'content-type': 'application/x-www-form-urlencoded', 'x-slack-signature': 'v0=sig', 'x-slack-request-timestamp': '1700000000' },
});

describe('POST /api/v1/bridge/slack/interactions (fetch 패스스루)', () => {
  it('forwards raw body + slack 서명 헤더 to FastAPI bridge', async () => {
    fetchMock.mockResolvedValue(new Response(JSON.stringify({ ok: true }), { status: 200 }));
    const res = await POST(req('payload=%7B%22x%22%3A1%7D'));
    expect(res.status).toBe(200);
    const [url, init] = fetchMock.mock.calls[0];
    expect(String(url)).toContain('/api/v2/bridge/slack/interactions');
    expect(init.method).toBe('POST');
    expect(init.body).toBe('payload=%7B%22x%22%3A1%7D');
    expect(init.headers['x-slack-signature']).toBe('v0=sig');
  });
  it('passes upstream status through', async () => {
    fetchMock.mockResolvedValue(new Response('{}', { status: 401 }));
    expect((await POST(req())).status).toBe(401);
  });
});
