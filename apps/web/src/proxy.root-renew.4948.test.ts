// story 4948 — the root `/` is a public path, but its page reads the ACCESS cookie only: an hour after the last renewal (the access cookie's max-age) `/` sent a person whose REFRESH cookie was alive to /login — the Mac app opens `/` at every
// start. The proxy now renews once for `/`. Reverting the `/` branch turns the renew cases red; the scope cases pin that no other public page renews and that nothing changes for a first visit / a live access token / a POST.
import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { SignJWT } from 'jose';

const mockFetch = vi.fn();
vi.stubGlobal('fetch', (...args: unknown[]) => mockFetch(...args));
import { proxy as middleware } from './proxy';

const JWT_SECRET = 'test-secret-for-proxy-tests';
async function accessToken(exp: number, sub = 'user-123'): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  return new SignJWT({ type: 'access', email: 't@example.com' }).setProtectedHeader({ alg: 'HS256' }).setSubject(sub).setIssuedAt(now - 4000).setExpirationTime(exp).sign(new TextEncoder().encode(JWT_SECRET));
}
const DOC = { accept: 'text/html,application/xhtml+xml', 'sec-fetch-dest': 'document' }; // what the browser (and the Mac app's window) sends for a page load
const req = (path: string, cookies: Record<string, string> = {}, method = 'GET', headers: Record<string, string> = DOC): NextRequest => {
  const r = new NextRequest(`https://app.example.com${path}`, { method, headers });
  for (const [k, v] of Object.entries(cookies)) r.cookies.set(k, v);
  return r;
};
const answer = (status: number, body: unknown) => ({ ok: status >= 200 && status < 300, status, json: async () => body, headers: new Headers() });
const setCookies = (res: Response): string[] => res.headers.getSetCookie();
const refreshCalls = () => mockFetch.mock.calls.filter((c) => String(c[0]).includes('/api/v2/auth/refresh')).length;

describe('the root `/` renews a session whose access cookie is gone (story 4948)', () => {
  beforeEach(() => { process.env['JWT_SECRET'] = JWT_SECRET; process.env['NEXT_PUBLIC_FASTAPI_URL'] = 'http://localhost:8000'; mockFetch.mockReset(); });
  afterEach(() => { delete process.env['JWT_SECRET']; });

  it('⭐the refresh cookie alive, no access cookie: ONE renewal, new cookies are set AND forwarded on this request (the page reads them) — not a login redirect', async () => {
    const fresh = await accessToken(Math.floor(Date.now() / 1000) + 3600);
    mockFetch.mockResolvedValue(answer(200, { data: { access_token: fresh, refresh_token: 'new-rt' } }));
    const res = await middleware(req('/', { sp_rt: 'old-rt' }));
    expect(refreshCalls()).toBe(1);
    expect(res.status).toBe(200);
    expect(res.headers.get('location')).toBeNull();
    const sc = setCookies(res).join('\n');
    expect(sc).toContain(`sp_at=${fresh}`);
    expect(sc).toContain('sp_rt=new-rt');
    expect(res.headers.get('x-middleware-request-cookie') ?? '').toContain(`sp_at=${fresh}`); // RootPage's getServerSession reads THIS
    expect(res.headers.get('x-middleware-request-cookie') ?? '').toContain('sp_rt=new-rt');
  });

  it('⭐an access cookie that is present but past its expiry renews the same way', async () => {
    const expired = await accessToken(Math.floor(Date.now() / 1000) - 60);
    const fresh = await accessToken(Math.floor(Date.now() / 1000) + 3600);
    mockFetch.mockResolvedValue(answer(200, { data: { access_token: fresh, refresh_token: 'new-rt' } }));
    const res = await middleware(req('/', { sp_at: expired, sp_rt: 'old-rt' }));
    expect(refreshCalls()).toBe(1);
    expect(res.headers.get('x-middleware-request-cookie') ?? '').toContain(`sp_at=${fresh}`);
  });

  it('a live access token: nothing is renewed, nothing is set (the page reads it as it is)', async () => {
    const live = await accessToken(Math.floor(Date.now() / 1000) + 3600);
    const res = await middleware(req('/', { sp_at: live, sp_rt: 'rt' }));
    expect(refreshCalls()).toBe(0);
    expect(setCookies(res)).toEqual([]);
  });

  it('a first visit with no session signal: no renewal, the public passthrough as before', async () => {
    const res = await middleware(req('/'));
    expect(mockFetch).not.toHaveBeenCalled();
    expect(res.status).toBe(200);
    expect(res.headers.get('location')).toBeNull();
    expect(setCookies(res).filter((c) => /sp_(at|rt)=/.test(c)), 'an anonymous visit gets no auth cookie, not even a clearing one').toEqual([]);
    expect(res.headers.get('x-session-changed'), 'and no «the session changed» mark').toBeNull();
  });

  it('only `/`: another public page opened with the same cookies renews nothing (a login · the terms · the register page)', async () => {
    for (const path of ['/login', '/terms', '/register', '/session-unconfirmed']) {
      mockFetch.mockReset();
      await middleware(req(path, { sp_rt: 'old-rt' }));
      expect(refreshCalls(), path).toBe(0);
    }
  });

  it('⭐only a page LOAD: a POST · a HEAD · a prefetch · an RSC fetch · a JSON fetch of `/` renew nothing (each would spend one more rotation for nothing)', async () => {
    const cases: [string, string, Record<string, string>][] = [
      ['POST', 'POST', DOC], ['HEAD', 'HEAD', DOC],
      ['prefetch', 'GET', { ...DOC, 'next-router-prefetch': '1' }], ['RSC', 'GET', { ...DOC, rsc: '1' }], ['JSON', 'GET', { accept: 'application/json' }],
    ];
    for (const [name, method, headers] of cases) {
      mockFetch.mockReset();
      await middleware(req('/', { sp_rt: 'old-rt' }, method, headers));
      expect(refreshCalls(), name).toBe(0);
    }
  });

  it('a Firebase session (the page reads its own cookie): nothing is renewed, nothing is cleared', async () => {
    const res = await middleware(req('/', { sp_rt: 'old-rt', '__Host-sp_fs': 'firebase-session' }));
    expect(refreshCalls()).toBe(0);
    expect(setCookies(res).filter((c) => /sp_(at|rt)=/.test(c))).toEqual([]);
  });

  it('the multi-account vault: no sp_rt, the ACTIVE account\'s vault token is the one renewed (the pointer-scoped fallback every protected path has)', async () => {
    const fresh = await accessToken(Math.floor(Date.now() / 1000) + 3600, 'user-123');
    mockFetch.mockResolvedValue(answer(200, { data: { access_token: fresh, refresh_token: 'vault-new-rt' } }));
    const res = await middleware(req('/', { sp_active_account: 'user-123', 'sp_acct_rt_user-123': 'vault-rt' }));
    expect(refreshCalls()).toBe(1);
    expect(String(mockFetch.mock.calls.find((c) => String(c[0]).includes('/auth/refresh'))?.[1]?.body)).toContain('vault-rt');
    expect(setCookies(res).join('\n')).toContain(`sp_at=${fresh}`);
  });

  it('a refresh the backend REFUSED (a dead session): the cookies are cleared and the request goes on (the page sends the person to sign in)', async () => {
    mockFetch.mockResolvedValue(answer(401, { error: { code: 'TOKEN_REVOKED' } }));
    const res = await middleware(req('/', { sp_rt: 'dead-rt' }));
    const sc = setCookies(res).join('\n');
    expect(sc).toMatch(/sp_rt=;/);
    expect(sc).toMatch(/sp_at=;/);
    expect(res.headers.get('location')).toBeNull();
  });

  it('`/` is still a public page: the sign-up first-touch (utm · referrer) is recorded whether the renewal succeeds, the session is dead, or nothing was renewed', async () => {
    const fresh = await accessToken(Math.floor(Date.now() / 1000) + 3600);
    mockFetch.mockResolvedValue(answer(200, { data: { access_token: fresh, refresh_token: 'new-rt' } }));
    const renewed = await middleware(req('/?utm_source=newsletter', { sp_rt: 'rt' }));
    expect(setCookies(renewed).join('\n')).toContain('sp_attr_src=newsletter');
    mockFetch.mockReset(); mockFetch.mockResolvedValue(answer(401, { error: { code: 'TOKEN_REVOKED' } }));
    const dead = await middleware(req('/?utm_source=newsletter', { sp_rt: 'dead-rt' }));
    expect(setCookies(dead).join('\n')).toContain('sp_attr_src=newsletter');
  });

  it('a refresh that could not be confirmed (503 · the network) clears NOTHING: the session may be alive, the next visit asks again', async () => {
    for (const fail of [() => mockFetch.mockResolvedValue(answer(503, {})), () => mockFetch.mockRejectedValue(new TypeError('fetch failed'))]) {
      mockFetch.mockReset(); fail();
      const res = await middleware(req('/', { sp_rt: 'rt' }));
      expect(setCookies(res).filter((c) => /sp_(at|rt)=/.test(c)), 'no auth cookie is touched').toEqual([]);
    }
  });

  it('a refresh that answers «superseded» (a switch moved the session on) clears nothing either', async () => {
    mockFetch.mockResolvedValue(answer(401, { error: { code: 'TOKEN_SUPERSEDED' } }));
    const res = await middleware(req('/', { sp_rt: 'rt' }));
    expect(setCookies(res).filter((c) => /sp_(at|rt)=/.test(c))).toEqual([]);
  });

  it('RC2: a refresh for an account that is not the active one is not applied (the cookies stay as they are)', async () => {
    const other = await accessToken(Math.floor(Date.now() / 1000) + 3600, 'someone-else');
    mockFetch.mockResolvedValue(answer(200, { data: { access_token: other, refresh_token: 'other-rt' } }));
    const res = await middleware(req('/', { sp_rt: 'rt', sp_active_account: 'user-123' }));
    expect(setCookies(res).filter((c) => /sp_(at|rt)=/.test(c))).toEqual([]);
    expect(res.headers.get('x-middleware-request-cookie') ?? '', 'the other account\'s token is not forwarded to the page either').not.toContain(other);
  });
});
