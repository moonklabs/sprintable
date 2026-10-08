// story #4630 — «sign out everywhere else»: the BFF sends this browser's refresh token (the one the backend keeps) and
// passes back only the count and whether this session was kept.
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { getServerSessionMock } = vi.hoisted(() => ({ getServerSessionMock: vi.fn() }));
vi.mock('@/lib/db/server', () => ({ getServerSession: getServerSessionMock, SP_AT_COOKIE: 'sp_at', SP_RT_COOKIE: 'sp_rt' }));
const cookieJar = vi.hoisted(() => ({ rt: 'rt-this-browser' as string | undefined }));
vi.mock('next/headers', () => ({
  cookies: async () => ({ get: (name: string) => (name === 'sp_rt' && cookieJar.rt ? { value: cookieJar.rt } : undefined) }),
}));

import { POST } from './route';

const req = (headers: Record<string, string> = {}) =>
  new Request('http://localhost:3000/api/auth/logout-others', { method: 'POST', headers: { host: 'localhost:3000', ...headers } });

beforeEach(() => {
  vi.unstubAllGlobals();
  getServerSessionMock.mockReset();
  getServerSessionMock.mockResolvedValue({ access_token: 'at-1' });
  cookieJar.rt = 'rt-this-browser';
});

describe('[SID:4630] /api/auth/logout-others', () => {
  it('sends this browser\'s refresh token with the access token · answers the count and kept_this only', async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ data: { sessions_ended: 2, kept_this: true } }), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    const res = await POST(req({ Origin: 'http://localhost:3000' }));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ data: { sessions_ended: 2, kept_this: true } });
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toMatch(/\/api\/v2\/auth\/logout-others$/);
    expect(JSON.parse(String(init.body))).toEqual({ refresh_token: 'rt-this-browser' });
    expect((init.headers as Record<string, string>)['Authorization']).toBe('Bearer at-1');
  });

  it('no cookie → refresh_token null (the backend then keeps nothing and says kept_this false)', async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ data: { sessions_ended: 3, kept_this: false } }), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    cookieJar.rt = undefined;
    const res = await POST(req());
    expect(await res.json()).toEqual({ data: { sessions_ended: 3, kept_this: false } });
    expect(JSON.parse(String((fetchMock.mock.calls[0] as unknown as [string, RequestInit])[1].body))).toEqual({ refresh_token: null });
  });

  it('another site\'s origin is refused before anything is sent (CSRF)', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const res = await POST(req({ Origin: 'https://evil.example' }));
    expect(res.status).toBe(403);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('not signed in → 401, nothing sent', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    getServerSessionMock.mockResolvedValue(null);
    expect((await POST(req())).status).toBe(401);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('the backend\'s refusal passes through with its status · an HTML 502 gets the envelope', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ error: { code: 'SESSION_INVALIDATED', message: 'x' } }), { status: 401 })));
    const refused = await POST(req());
    expect(refused.status).toBe(401);
    expect((await refused.json() as { error: { code: string } }).error.code).toBe('SESSION_INVALIDATED');
    vi.stubGlobal('fetch', vi.fn(async () => new Response('<html>502</html>', { status: 502, headers: { 'content-type': 'text/html' } })));
    const html = await POST(req());
    expect(html.status).toBe(502);
    expect((await html.json() as { error: { code: string } }).error.code).toBe('LOGOUT_OTHERS_FAILED');
  });
});
