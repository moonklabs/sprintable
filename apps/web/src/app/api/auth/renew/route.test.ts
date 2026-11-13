import { beforeEach, describe, expect, it, vi } from 'vitest';

// story 4904 — the renew road: one refresh for a document navigation, then back to the page (the authenticated layout reads again). Never an open redirect;
// a dead token is cleared like the refresh road does; a token that is not known to be dead stays.
const h = vi.hoisted(() => ({ cookieGet: vi.fn(), superseded: vi.fn() }));
vi.mock('next/headers', () => ({ cookies: vi.fn(async () => ({ get: h.cookieGet })) }));
vi.mock('@/services/app-url', () => ({ resolveAppUrl: () => 'https://app.test' }));
vi.mock('@/lib/auth/switch-epoch', () => ({ isRecentlySuperseded: h.superseded }));

const mockFetch = vi.fn();
vi.stubGlobal('fetch', stubFetch(mockFetch));

import { GET } from './route';
import { safeNextPath } from '@/lib/auth/session-redirect';
import { readNavV3FlagsFromEnv } from '@/lib/nav-v3-flags-server';
import { stubFetch } from '@/test-utils/as-fetch-response';

const get = (next: string | null) => GET(new Request(`http://0.0.0.0:8080/api/auth/renew${next === null ? '' : `?next=${encodeURIComponent(next)}`}`));
// the road reads the account out of the new access token (no signature check — the token came straight from the backend): an unsigned token with a `sub` is enough
const jwtFor = (sub: string) => `${Buffer.from('{"alg":"none"}').toString('base64url')}.${Buffer.from(JSON.stringify({ sub })).toString('base64url')}.x`;
const AT = jwtFor('acct-1');
const setCookie = (res: Response) => res.headers.get('set-cookie') ?? '';

describe('GET /api/auth/renew (story 4904)', () => {
  beforeEach(() => {
    h.superseded.mockReset().mockReturnValue(false);
    h.cookieGet.mockReset().mockImplementation((name: string) => (name === 'sp_rt' ? { value: 'old-rt' } : undefined));
    mockFetch.mockReset();
  });

  it('one refresh → new cookies + the renew marker, back to the page that was asked for (query kept), on the app origin', async () => {
    mockFetch.mockResolvedValue({ ok: true, json: async () => ({ data: { access_token: AT, refresh_token: 'new-rt' } }) });
    const res = await get('/glance?story=abc');
    expect(res.status).toBe(303);
    expect(res.headers.get('location')).toBe('https://app.test/glance?story=abc');
    expect(setCookie(res)).toContain(`sp_at=${AT}`);
    expect(setCookie(res)).toContain('sp_rt=new-rt');
    expect(setCookie(res)).toContain('sp_renew_tried=1');
    expect(res.headers.get('x-session-changed')).toBe('1');
    expect(mockFetch).toHaveBeenCalledTimes(1);
    expect(JSON.parse(String(mockFetch.mock.calls[0]![1].body))).toEqual({ refresh_token: 'old-rt' });
  });

  it.each(['//evil.example/x', 'https://evil.example/x', '/\\evil.example', '/api/auth/renew', '/api/auth/renew?next=%2Fchats', null])('next=%s is never followed off the app: the chat home', async (next) => {
    mockFetch.mockResolvedValue({ ok: true, json: async () => ({ data: { access_token: AT, refresh_token: 'r' } }) });
    const res = await get(next);
    expect(res.headers.get('location')).toBe('https://app.test/chats');
    // … and that default is the app's own safe landing (what the sign-in falls to), not a literal of this file
    expect(res.headers.get('location')).toBe(`https://app.test${safeNextPath(null, readNavV3FlagsFromEnv())}`);
  });

  it('no refresh token → the sign-in, no backend call', async () => {
    h.cookieGet.mockReturnValue(undefined);
    const res = await get('/chats');
    expect(res.headers.get('location')).toBe('https://app.test/login?next=%2Fchats&reason=session_expired');
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('a token the backend calls dead (401) → the sign-in and the session cookies are cleared', async () => {
    mockFetch.mockResolvedValue({ ok: false, status: 401, headers: { get: () => null }, json: async () => ({ error: { code: 'TOKEN_REVOKED' } }) });
    const res = await get('/chats');
    expect(res.headers.get('location')).toBe('https://app.test/login?next=%2Fchats&reason=session_expired');
    const c = setCookie(res);
    expect(c).toMatch(/sp_at=;/);
    expect(c).toMatch(/sp_rt=;/);
    expect(c).not.toContain('sp_renew_tried');
    expect(res.headers.get('x-session-changed')).toBe('1');
  });

  it('superseded by a switch (401 TOKEN_SUPERSEDED) → the sign-in, the cookies stay (the session moved on; not known to be dead)', async () => {
    mockFetch.mockResolvedValue({ ok: false, status: 401, headers: { get: () => null }, json: async () => ({ error: { code: 'TOKEN_SUPERSEDED' } }) });
    const res = await get('/chats');
    expect(res.headers.get('location')).toBe('https://app.test/login?next=%2Fchats&reason=session_expired');
    expect(setCookie(res)).toBe('');
  });

  // story 4915 (PR 2) — «could not confirm» (the call was rejected · timed out · 5xx · an answer we cannot read) is NOT a sign-out: nothing cleared, back to the page with a 10-second marker; the layout answers it
  // with the «다시 시도» screen (and does not call this road again while the marker lives — no loop).
  it.each([
    ['a backend that is ill (503)', () => mockFetch.mockResolvedValue({ ok: false, status: 503, headers: { get: () => null }, json: async () => ({}) })],
    ['a 502 behind a deploy', () => mockFetch.mockResolvedValue({ ok: false, status: 502, headers: { get: () => null }, json: async () => ({}) })],
    ['a 200 without tokens', () => mockFetch.mockResolvedValue({ ok: true, json: async () => ({ data: {} }) })],
    ['the backend cannot be reached (rejected)', () => mockFetch.mockRejectedValue(Object.assign(new TypeError('fetch failed'), { cause: { code: 'ECONNRESET' } }))],
  ])('%s → back to the page (query kept) with the short unconfirmed marker, NOT the sign-in, no session cookie touched', async (_n, arrange) => {
    arrange();
    const res = await get('/chats?story=abc');
    expect(res.status).toBe(303);
    expect(res.headers.get('location')).toBe('https://app.test/chats?story=abc');
    const c = setCookie(res);
    expect(c).toContain('sp_renew_unconfirmed=1');
    expect(c).toMatch(/Max-Age=10\b/i);
    expect(c).not.toMatch(/sp_(at|rt)=/);
    expect(c).not.toContain('sp_renew_tried');
    expect(res.headers.get('x-session-changed')).toBeNull();
  });

  it('the query of the page is kept exactly (one decode only): ?story=a%26b stays a%26b, on the way back and in the sign-in', async () => {
    mockFetch.mockResolvedValue({ ok: true, json: async () => ({ data: { access_token: AT, refresh_token: 'r' } }) });
    expect((await get('/glance?story=a%26b&x=1')).headers.get('location')).toBe('https://app.test/glance?story=a%26b&x=1');
    h.cookieGet.mockReturnValue(undefined);
    expect((await get('/glance?story=a%26b')).headers.get('location')).toBe(`https://app.test/login?next=${encodeURIComponent('/glance?story=a%26b')}&reason=session_expired`);
  });

  it('the road honours its own marker: a second call within the minute does not rotate the token again (no loop · no repeated forced rotation)', async () => {
    h.cookieGet.mockImplementation((name: string) => (name === 'sp_rt' ? { value: 'old-rt' } : name === 'sp_renew_tried' ? { value: '1' } : undefined));
    const res = await get('/chats');
    expect(res.headers.get('location')).toBe('https://app.test/login?next=%2Fchats&reason=session_expired');
    expect(mockFetch).not.toHaveBeenCalled();
    expect(setCookie(res)).toBe('');
  });

  describe('multi-account (the proxy\'s two checks): a renewal that is not the active account\'s writes nothing', () => {
    const ok = () => mockFetch.mockResolvedValue({ ok: true, json: async () => ({ data: { access_token: AT, refresh_token: 'r' } }) });
    it('the active-account pointer names another account → the sign-in, cookies untouched', async () => {
      ok();
      h.cookieGet.mockImplementation((name: string) => (name === 'sp_rt' ? { value: 'old-rt' } : name === 'sp_active_account' ? { value: 'acct-2' } : undefined));
      const res = await get('/chats');
      expect(res.headers.get('location')).toBe('https://app.test/login?next=%2Fchats&reason=session_expired');
      expect(setCookie(res)).toBe('');
    });
    it('the account was just superseded by a switch → the sign-in, cookies untouched', async () => {
      ok();
      h.superseded.mockImplementation((id: string) => id === 'acct-1');
      const res = await get('/chats');
      expect(res.headers.get('location')).toContain('/login?');
      expect(setCookie(res)).toBe('');
    });
    it('the pointer names the same account → renewed as usual', async () => {
      ok();
      h.cookieGet.mockImplementation((name: string) => (name === 'sp_rt' ? { value: 'old-rt' } : name === 'sp_active_account' ? { value: 'acct-1' } : undefined));
      const res = await get('/chats');
      expect(res.headers.get('location')).toBe('https://app.test/chats');
      expect(setCookie(res)).toContain('sp_renew_tried=1');
    });
    it('an access token with no readable account → not written (the sign-in)', async () => {
      mockFetch.mockResolvedValue({ ok: true, json: async () => ({ data: { access_token: 'not-a-jwt', refresh_token: 'r' } }) });
      const res = await get('/chats');
      expect(res.headers.get('location')).toContain('/login?');
      expect(setCookie(res)).toBe('');
    });
  });
});
