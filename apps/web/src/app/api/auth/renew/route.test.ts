import { beforeEach, describe, expect, it, vi } from 'vitest';

// story 4904 — the renew road: one refresh for a document navigation, then back to the page (the authenticated layout reads again). Never an open redirect;
// a dead token is cleared like the refresh road does; a token that is not known to be dead stays.
const h = vi.hoisted(() => ({ cookieGet: vi.fn() }));
vi.mock('next/headers', () => ({ cookies: vi.fn(async () => ({ get: h.cookieGet })) }));
vi.mock('@/services/app-url', () => ({ resolveAppUrl: () => 'https://app.test' }));

const mockFetch = vi.fn();
vi.stubGlobal('fetch', stubFetch(mockFetch));

import { GET } from './route';
import { stubFetch } from '@/test-utils/as-fetch-response';

const get = (next: string | null) => GET(new Request(`http://0.0.0.0:8080/api/auth/renew${next === null ? '' : `?next=${encodeURIComponent(next)}`}`));
const setCookie = (res: Response) => res.headers.get('set-cookie') ?? '';

describe('GET /api/auth/renew (story 4904)', () => {
  beforeEach(() => {
    h.cookieGet.mockReset().mockImplementation((name: string) => (name === 'sp_rt' ? { value: 'old-rt' } : undefined));
    mockFetch.mockReset();
  });

  it('one refresh → new cookies + the renew marker, back to the page that was asked for (query kept), on the app origin', async () => {
    mockFetch.mockResolvedValue({ ok: true, json: async () => ({ data: { access_token: 'new-at', refresh_token: 'new-rt' } }) });
    const res = await get('/glance?story=abc');
    expect(res.status).toBe(303);
    expect(res.headers.get('location')).toBe('https://app.test/glance?story=abc');
    expect(setCookie(res)).toContain('sp_at=new-at');
    expect(setCookie(res)).toContain('sp_rt=new-rt');
    expect(setCookie(res)).toContain('sp_renew_tried=1');
    expect(res.headers.get('x-session-changed')).toBe('1');
    expect(mockFetch).toHaveBeenCalledTimes(1);
    expect(JSON.parse(String(mockFetch.mock.calls[0]![1].body))).toEqual({ refresh_token: 'old-rt' });
  });

  it.each(['//evil.example/x', 'https://evil.example/x', '/\\evil.example', null])('next=%s is never followed off the app: the chat home', async (next) => {
    mockFetch.mockResolvedValue({ ok: true, json: async () => ({ data: { access_token: 'a', refresh_token: 'r' } }) });
    const res = await get(next);
    expect(res.headers.get('location')).toBe('https://app.test/chats');
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

  it.each([
    ['superseded by a switch', { ok: false, status: 401, headers: { get: () => null }, json: async () => ({ error: { code: 'TOKEN_SUPERSEDED' } }) }],
    ['a backend that is ill (503)', { ok: false, status: 503, headers: { get: () => null }, json: async () => ({}) }],
    ['a 200 without tokens', { ok: true, json: async () => ({ data: {} }) }],
  ])('%s → the sign-in, the cookies stay (not known to be dead)', async (_n, answer) => {
    mockFetch.mockResolvedValue(answer);
    const res = await get('/chats');
    expect(res.headers.get('location')).toBe('https://app.test/login?next=%2Fchats&reason=session_expired');
    expect(setCookie(res)).toBe('');
  });

  it('the backend cannot be reached → the sign-in, the cookies stay', async () => {
    mockFetch.mockRejectedValue(new Error('network'));
    const res = await get('/chats');
    expect(res.headers.get('location')).toBe('https://app.test/login?next=%2Fchats&reason=session_expired');
    expect(setCookie(res)).toBe('');
  });
});
