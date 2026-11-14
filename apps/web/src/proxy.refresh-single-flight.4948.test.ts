// story 4948 (PR 2) — concurrent requests that carry the SAME refresh token share ONE backend rotation (what is in flight, nothing after it settles). Removing the sharing turns the «one call» cases red; the «not kept» and
// «different tokens» cases pin that the share is limited to what is in flight and to one token.
import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { SignJWT } from 'jose';

const mockFetch = vi.fn();
vi.stubGlobal('fetch', (...args: unknown[]) => mockFetch(...args));
import { proxy as middleware, REFRESH_JOIN_WINDOW_MS, pendingRefreshCount } from './proxy';

const JWT_SECRET = 'test-secret-for-proxy-tests';
async function accessToken(exp: number, sub = 'user-123'): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  return new SignJWT({ type: 'access', email: 't@example.com' }).setProtectedHeader({ alg: 'HS256' }).setSubject(sub).setIssuedAt(now - 4000).setExpirationTime(exp).sign(new TextEncoder().encode(JWT_SECRET));
}
// a protected API request with no access cookie: the proxy renews, then lets the request through
const api = (cookies: Record<string, string>) => {
  const r = new NextRequest('https://app.example.com/api/me', { headers: { accept: 'application/json' } });
  for (const [k, v] of Object.entries(cookies)) r.cookies.set(k, v);
  return r;
};
const answer = (status: number, body: unknown) => ({ ok: status >= 200 && status < 300, status, json: async () => body, headers: new Headers() });
const refreshCalls = () => mockFetch.mock.calls.filter((c) => String(c[0]).includes('/api/v2/auth/refresh'));
const setCookies = (res: Response) => res.headers.getSetCookie().join('\n');

/** a refresh answer the test releases by hand, so the requests overlap for real */
function gate() {
  let release!: (v: unknown) => void;
  const p = new Promise((r) => { release = r; });
  return { p, release };
}

describe('one rotation per refresh token in flight (story 4948 PR 2)', () => {
  beforeEach(() => { process.env['JWT_SECRET'] = JWT_SECRET; process.env['NEXT_PUBLIC_FASTAPI_URL'] = 'http://localhost:8000'; mockFetch.mockReset(); });
  afterEach(() => { delete process.env['JWT_SECRET']; });

  it('⭐19 concurrent requests with the SAME refresh token: ONE call to the backend, and every request gets the same renewed pair', async () => {
    const fresh = await accessToken(Math.floor(Date.now() / 1000) + 3600);
    const g = gate();
    mockFetch.mockImplementation(async () => { await g.p; return answer(200, { data: { access_token: fresh, refresh_token: 'new-rt' } }); });
    const all = Array.from({ length: 19 }, () => middleware(api({ sp_rt: 'same-rt' })));
    await new Promise((r) => setTimeout(r, 30)); // every one of them has reached the refresh
    g.release(undefined);
    const results = await Promise.all(all);
    expect(refreshCalls()).toHaveLength(1);
    for (const res of results) {
      expect(res.status).toBe(200);
      expect(setCookies(res)).toContain(`sp_at=${fresh}`);
      expect(setCookies(res)).toContain('sp_rt=new-rt');
    }
  });

  it('the proactive refresh (an access token in its last 5 minutes) shares too: a dozen requests, one rotation', async () => {
    const nearEnd = await accessToken(Math.floor(Date.now() / 1000) + 120);
    const fresh = await accessToken(Math.floor(Date.now() / 1000) + 3600);
    const g = gate();
    mockFetch.mockImplementation(async () => { await g.p; return answer(200, { data: { access_token: fresh, refresh_token: 'new-rt' } }); });
    const all = Array.from({ length: 12 }, () => middleware(api({ sp_at: nearEnd, sp_rt: 'same-rt' })));
    await new Promise((r) => setTimeout(r, 30));
    g.release(undefined);
    await Promise.all(all);
    expect(refreshCalls()).toHaveLength(1);
  });

  it('⭐only what is IN FLIGHT is shared: once it has settled nothing is kept — the next request with the same token asks the backend again (a finished answer is never replayed)', async () => {
    const fresh = await accessToken(Math.floor(Date.now() / 1000) + 3600);
    mockFetch.mockResolvedValue(answer(200, { data: { access_token: fresh, refresh_token: 'new-rt' } }));
    await middleware(api({ sp_rt: 'same-rt' }));
    await middleware(api({ sp_rt: 'same-rt' }));
    expect(refreshCalls()).toHaveLength(2);
  });

  it('⭐a DIFFERENT refresh token is its own rotation (two people, two tabs on two tokens): never mixed', async () => {
    const a = await accessToken(Math.floor(Date.now() / 1000) + 3600, 'user-a');
    const b = await accessToken(Math.floor(Date.now() / 1000) + 3600, 'user-b');
    const g = gate();
    mockFetch.mockImplementation(async (_url: string, init: { body: string }) => {
      await g.p;
      return JSON.parse(init.body).refresh_token === 'rt-a' ? answer(200, { data: { access_token: a, refresh_token: 'new-a' } }) : answer(200, { data: { access_token: b, refresh_token: 'new-b' } });
    });
    const pa = middleware(api({ sp_rt: 'rt-a' })); const pb = middleware(api({ sp_rt: 'rt-b' }));
    await new Promise((r) => setTimeout(r, 30));
    g.release(undefined);
    const [ra, rb] = await Promise.all([pa, pb]);
    expect(refreshCalls()).toHaveLength(2);
    expect(setCookies(ra)).toContain('sp_rt=new-a');
    expect(setCookies(ra)).not.toContain('new-b');
    expect(setCookies(rb)).toContain('sp_rt=new-b');
  });

  it('⭐a rotation older than the join window is NOT joined: a slow or hung one never holds the later requests (they start their own)', async () => {
    const fresh = await accessToken(Math.floor(Date.now() / 1000) + 3600);
    const g = gate();
    mockFetch.mockImplementation(async () => { await g.p; return answer(200, { data: { access_token: fresh, refresh_token: 'new-rt' } }); });
    const first = middleware(api({ sp_rt: 'slow-rt' }));
    await new Promise((r) => setTimeout(r, 30));
    const realNow = Date.now;
    const spy = vi.spyOn(Date, 'now').mockImplementation(() => realNow() + REFRESH_JOIN_WINDOW_MS + 1000); // the first rotation is now «old»
    const second = middleware(api({ sp_rt: 'slow-rt' }));
    await new Promise((r) => setTimeout(r, 30));
    spy.mockRestore();
    expect(refreshCalls(), 'the late request started its own rotation').toHaveLength(2);
    g.release(undefined);
    await Promise.all([first, second]);
  });

  it('⭐an OLD flight settling does not free a NEWER flight\'s slot: a request that arrives while the newer one runs still joins it', async () => {
    const fresh = await accessToken(Math.floor(Date.now() / 1000) + 3600);
    const gates = [gate(), gate()];
    let n = 0;
    mockFetch.mockImplementation(async () => { const g = gates[Math.min(n++, 1)]!; await g.p; return answer(200, { data: { access_token: fresh, refresh_token: `rt-${n}` } }); });
    const first = middleware(api({ sp_rt: 'same-rt' }));
    await new Promise((r) => setTimeout(r, 30));
    const realNow = Date.now;
    const spy = vi.spyOn(Date, 'now').mockImplementation(() => realNow() + REFRESH_JOIN_WINDOW_MS + 1000);
    const second = middleware(api({ sp_rt: 'same-rt' })); // the first is old: this one starts the second flight, which takes the slot
    await new Promise((r) => setTimeout(r, 30));
    gates[0]!.release(undefined); // the OLD flight settles: its `finally` must leave the newer flight's slot alone
    await first;
    const third = middleware(api({ sp_rt: 'same-rt' })); // arrives while the second flight is young and running: joins it
    await new Promise((r) => setTimeout(r, 30));
    spy.mockRestore();
    expect(refreshCalls(), 'two rotations, not three').toHaveLength(2);
    gates[1]!.release(undefined);
    await Promise.all([second, third]);
  });

  it('⭐a backend that never answers does not grow the map for ever: rotations unanswered after 30 s are dropped from it when the next one is registered', async () => {
    mockFetch.mockImplementation(() => new Promise(() => {})); // never settles
    const before = pendingRefreshCount();
    for (const rt of ['hung-1', 'hung-2', 'hung-3']) void middleware(api({ sp_rt: rt }));
    await new Promise((r) => setTimeout(r, 30));
    expect(pendingRefreshCount() - before).toBe(3);
    const realNow = Date.now;
    const spy = vi.spyOn(Date, 'now').mockImplementation(() => realNow() + 40_000);
    void middleware(api({ sp_rt: 'new-one' }));
    await new Promise((r) => setTimeout(r, 30));
    spy.mockRestore();
    expect(pendingRefreshCount() - before, 'the three hung ones are gone, the new one is there').toBe(1);
  });

  it('⭐what is shared is the BACKEND answer only — each waiter still decides for itself (RC2 with its own cookies) and forwards its OWN cookies to the page', async () => {
    const fresh = await accessToken(Math.floor(Date.now() / 1000) + 3600, 'user-123');
    const g = gate();
    mockFetch.mockImplementation(async () => { await g.p; return answer(200, { data: { access_token: fresh, refresh_token: 'new-rt' } }); });
    // A is the active account (pointer = the token's subject); B points at ANOTHER account: its RC2 refuses the same answer
    const a = middleware(api({ sp_rt: 'same-rt', tz: 'A-zone', sp_active_account: 'user-123' }));
    const b = middleware(api({ sp_rt: 'same-rt', tz: 'B-zone', sp_active_account: 'someone-else' }));
    await new Promise((r) => setTimeout(r, 30));
    g.release(undefined);
    const [ra, rb] = await Promise.all([a, b]);
    expect(refreshCalls()).toHaveLength(1);
    expect(setCookies(ra)).toContain('sp_rt=new-rt');
    expect(ra.headers.get('x-middleware-request-cookie') ?? '').toContain('tz=A-zone');
    expect(ra.headers.get('x-middleware-request-cookie') ?? '').not.toContain('B-zone');
    expect(setCookies(rb)).not.toContain('sp_rt=new-rt'); // B's own RC2 said no
  });

  it('a REFUSED rotation is shared as well (every overlapping request is told the same, the cookies are cleared once per response) and is not remembered', async () => {
    const g = gate();
    mockFetch.mockImplementation(async () => { await g.p; return answer(401, { error: { code: 'TOKEN_REVOKED' } }); });
    const all = Array.from({ length: 5 }, () => middleware(api({ sp_rt: 'dead-rt' })));
    await new Promise((r) => setTimeout(r, 30));
    g.release(undefined);
    const results = await Promise.all(all);
    expect(refreshCalls()).toHaveLength(1);
    for (const res of results) expect(setCookies(res)).toMatch(/sp_rt=;/);
    mockFetch.mockClear();
    await middleware(api({ sp_rt: 'dead-rt' }));
    expect(refreshCalls()).toHaveLength(1); // asked again: nothing was kept
  });

  it('a rotation that THROWS (the network) frees the slot: the next request asks again instead of waiting on a dead promise', async () => {
    mockFetch.mockRejectedValueOnce(new TypeError('fetch failed'));
    await middleware(api({ sp_rt: 'rt' }));
    const fresh = await accessToken(Math.floor(Date.now() / 1000) + 3600);
    mockFetch.mockResolvedValue(answer(200, { data: { access_token: fresh, refresh_token: 'new-rt' } }));
    const res = await middleware(api({ sp_rt: 'rt' }));
    expect(setCookies(res)).toContain('sp_rt=new-rt');
    expect(refreshCalls()).toHaveLength(2);
  });

  it('the vault fallback shares by ITS token too (the active account\'s vault entry): one call per token, not per request', async () => {
    const fresh = await accessToken(Math.floor(Date.now() / 1000) + 3600, 'user-123');
    const primary = gate(); const vault = gate();
    mockFetch.mockImplementation(async (_u: string, init: { body: string }) => {
      if (JSON.parse(init.body).refresh_token === 'vault-rt') { await vault.p; return answer(200, { data: { access_token: fresh, refresh_token: 'vault-new' } }); }
      await primary.p; return answer(401, { error: { code: 'TOKEN_REVOKED' } });
    });
    const all = Array.from({ length: 4 }, () => middleware(api({ sp_rt: 'dead-rt', sp_active_account: 'user-123', 'sp_acct_rt_user-123': 'vault-rt' })));
    await new Promise((r) => setTimeout(r, 30));
    primary.release(undefined); // the primary token is refused: all four go on to the vault entry, and meet there
    await new Promise((r) => setTimeout(r, 30));
    vault.release(undefined);
    const results = await Promise.all(all);
    const bodies = refreshCalls().map((c) => JSON.parse((c[1] as { body: string }).body).refresh_token).sort();
    expect(bodies).toEqual(['dead-rt', 'vault-rt']);
    for (const res of results) expect(setCookies(res)).toContain('sp_rt=vault-new');
  });
});
