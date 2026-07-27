// story(oauth-native-handoff) — /api/auth/callback/[provider] 콜백에 추가된 native 격리 rail
// 회귀가드. 핵심 불변식: (1) native 챌린지 쿠키 없으면 기존 레거시 흐름 100% 무변화(회귀 0),
// (2) native면 웹 세션 쿠키를 이 응답에 절대 세팅하지 않음(Custom Tabs jar에 남으면 안 됨),
// (3) /auth/native(attested)나 그 내부 consume 엔드포인트를 이 경로에서 절대 호출하지 않음.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({ cookiesGetMock: vi.fn(), cookiesDeleteMock: vi.fn() }));

vi.mock('next/headers', () => ({
  cookies: vi.fn(async () => ({ get: h.cookiesGetMock, delete: h.cookiesDeleteMock })),
}));
vi.mock('@/lib/db/server', () => ({ SP_AT_COOKIE: 'sp_at', SP_RT_COOKIE: 'sp_rt' }));
vi.mock('@/services/app-url', () => ({ resolveAppUrl: () => 'http://localhost:3108' }));

const mockFetch = vi.fn();
vi.stubGlobal('fetch', mockFetch);

import { GET } from './route';

// header.payload.signature — 서명은 검증 안 하므로 아무 값이나 무방. payload만 유효 base64url JSON.
function fakeJwt(payload: Record<string, unknown>): string {
  const b64 = (obj: unknown) => Buffer.from(JSON.stringify(obj)).toString('base64url');
  return `${b64({ alg: 'none' })}.${b64(payload)}.sig`;
}

function makeRequest(query: Record<string, string>): Request {
  const url = new URL('http://localhost/api/auth/callback/google');
  for (const [k, v] of Object.entries(query)) url.searchParams.set(k, v);
  return new Request(url.toString());
}

function routeParams() {
  return { params: Promise.resolve({ provider: 'google' }) };
}

const ENV_KEYS = ['FIREBASE_BFF_INTERNAL_SECRET', 'NEXT_PUBLIC_FASTAPI_URL', 'MOBILE_APP_LINK_ORIGIN'];

describe('GET /api/auth/callback/[provider] — native OAuth-handoff branch', () => {
  beforeEach(() => {
    mockFetch.mockReset();
    h.cookiesGetMock.mockReset();
    h.cookiesDeleteMock.mockReset();
    for (const k of ENV_KEYS) delete process.env[k];
  });

  afterEach(() => {
    for (const k of ENV_KEYS) delete process.env[k];
  });

  function stubCookies(overrides: Record<string, string> = {}) {
    const defaults: Record<string, string> = { oauth_state_google: 'matching-state', ...overrides };
    h.cookiesGetMock.mockImplementation((name: string) =>
      name in defaults ? { value: defaults[name] } : undefined,
    );
  }

  it('without a native challenge cookie: legacy flow is fully unchanged (regression guard) — sets sp_at/sp_rt, redirects to /inbox', async () => {
    stubCookies();
    mockFetch.mockResolvedValueOnce({
      ok: true, json: async () => ({ data: { access_token: 'legacy-at', refresh_token: 'legacy-rt' } }),
    });
    const res = await GET(makeRequest({ code: 'c', state: 'matching-state' }), routeParams());
    expect(res.status).toBe(307);
    expect(res.headers.get('location')).toBe('http://localhost:3108/inbox');
    const allCookies = res.cookies.getAll();
    expect(allCookies.find((c) => c.name === 'sp_at')?.value).toBe('legacy-at');
    expect(allCookies.find((c) => c.name === 'sp_rt')?.value).toBe('legacy-rt');
    // native issue endpoint must never be hit on the legacy path
    expect(mockFetch).toHaveBeenCalledTimes(1);
    expect((mockFetch.mock.calls[0] as [string])[0]).toContain('/api/v2/auth/oauth/callback');
  });

  it('with a native challenge cookie: does NOT set any session cookie on this response (Custom Tabs jar isolation)', async () => {
    stubCookies({ oauth_native_challenge_google: 'a'.repeat(43) });
    mockFetch
      .mockResolvedValueOnce({ ok: true, json: async () => ({ data: { access_token: fakeJwt({ sub: 'user-123' }), refresh_token: 'legacy-rt' } }) })
      .mockResolvedValueOnce({ ok: true, json: async () => ({ code: 'handoff-code-xyz' }) });

    const res = await GET(makeRequest({ code: 'c', state: 'matching-state' }), routeParams());
    expect(res.cookies.getAll()).toHaveLength(0);
    expect(res.headers.get('set-cookie')).toBeNull();
  });

  it('with a native challenge cookie: calls the isolated oauth-handoff issue endpoint (never /auth/native or native-bootstrap)', async () => {
    stubCookies({ oauth_native_challenge_google: 'a'.repeat(43) });
    mockFetch
      .mockResolvedValueOnce({ ok: true, json: async () => ({ data: { access_token: fakeJwt({ sub: 'user-123' }), refresh_token: 'legacy-rt' } }) })
      .mockResolvedValueOnce({ ok: true, json: async () => ({ code: 'handoff-code-xyz' }) });

    await GET(makeRequest({ code: 'c', state: 'matching-state' }), routeParams());
    expect(mockFetch).toHaveBeenCalledTimes(2);
    const [issueUrl, issueOpts] = mockFetch.mock.calls[1] as [string, RequestInit];
    expect(issueUrl).toContain('/api/v2/internal/auth/oauth-handoff/issue');
    expect(issueUrl).not.toContain('native-bootstrap');
    const sentBody = JSON.parse(issueOpts.body as string) as { user_id: string; code_challenge: string };
    expect(sentBody).toEqual({ user_id: 'user-123', code_challenge: 'a'.repeat(43) });
  });

  it('with a native challenge cookie: redirects to the App Link return URL with the handoff code, no-store + no-referrer', async () => {
    stubCookies({ oauth_native_challenge_google: 'a'.repeat(43) });
    process.env['MOBILE_APP_LINK_ORIGIN'] = 'https://dev-app.sprintable.ai';
    mockFetch
      .mockResolvedValueOnce({ ok: true, json: async () => ({ data: { access_token: fakeJwt({ sub: 'user-123' }), refresh_token: 'legacy-rt' } }) })
      .mockResolvedValueOnce({ ok: true, json: async () => ({ code: 'handoff-code-xyz' }) });

    const res = await GET(makeRequest({ code: 'c', state: 'matching-state' }), routeParams());
    expect(res.headers.get('location')).toBe('https://dev-app.sprintable.ai/native/oauth-return?code=handoff-code-xyz');
    expect(res.headers.get('cache-control')).toBe('no-store');
    expect(res.headers.get('referrer-policy')).toBe('no-referrer');
  });

  it('with a native challenge cookie: sends the internal secret header on the issue call', async () => {
    stubCookies({ oauth_native_challenge_google: 'a'.repeat(43) });
    process.env['FIREBASE_BFF_INTERNAL_SECRET'] = 'shared-secret';
    mockFetch
      .mockResolvedValueOnce({ ok: true, json: async () => ({ data: { access_token: fakeJwt({ sub: 'user-123' }), refresh_token: 'legacy-rt' } }) })
      .mockResolvedValueOnce({ ok: true, json: async () => ({ code: 'x' }) });

    await GET(makeRequest({ code: 'c', state: 'matching-state' }), routeParams());
    const [, issueOpts] = mockFetch.mock.calls[1] as [string, RequestInit];
    expect((issueOpts.headers as Record<string, string>)['Authorization']).toBe('Bearer shared-secret');
  });

  it('native branch: falls back to /login error if the access_token cannot be decoded (malformed JWT)', async () => {
    stubCookies({ oauth_native_challenge_google: 'a'.repeat(43) });
    mockFetch.mockResolvedValueOnce({ ok: true, json: async () => ({ data: { access_token: 'not-a-jwt', refresh_token: 'legacy-rt' } }) });
    const res = await GET(makeRequest({ code: 'c', state: 'matching-state' }), routeParams());
    expect(res.headers.get('location')).toBe('http://localhost:3108/login?error=oauth_native_issue_failed');
    expect(mockFetch).toHaveBeenCalledTimes(1); // issue never called
  });

  it('native branch: falls back to /login error if the issue call fails', async () => {
    stubCookies({ oauth_native_challenge_google: 'a'.repeat(43) });
    mockFetch
      .mockResolvedValueOnce({ ok: true, json: async () => ({ data: { access_token: fakeJwt({ sub: 'user-123' }), refresh_token: 'legacy-rt' } }) })
      .mockResolvedValueOnce({ ok: false, status: 400, json: async () => ({}) });
    const res = await GET(makeRequest({ code: 'c', state: 'matching-state' }), routeParams());
    expect(res.headers.get('location')).toBe('http://localhost:3108/login?error=oauth_native_issue_failed');
  });

  it('native branch: falls back to /login error if the issue response is malformed (no code)', async () => {
    stubCookies({ oauth_native_challenge_google: 'a'.repeat(43) });
    mockFetch
      .mockResolvedValueOnce({ ok: true, json: async () => ({ data: { access_token: fakeJwt({ sub: 'user-123' }), refresh_token: 'legacy-rt' } }) })
      .mockResolvedValueOnce({ ok: true, json: async () => ({ unexpected: 'shape' }) });
    const res = await GET(makeRequest({ code: 'c', state: 'matching-state' }), routeParams());
    expect(res.headers.get('location')).toBe('http://localhost:3108/login?error=oauth_native_issue_failed');
  });

  it('native challenge cookie is always deleted regardless of branch taken (no stale PKCE challenge reuse)', async () => {
    stubCookies({ oauth_native_challenge_google: 'a'.repeat(43) });
    mockFetch.mockResolvedValueOnce({ ok: true, json: async () => ({ data: { access_token: fakeJwt({ sub: 'user-123' }), refresh_token: 'legacy-rt' } }) })
      .mockResolvedValueOnce({ ok: true, json: async () => ({ code: 'x' }) });
    await GET(makeRequest({ code: 'c', state: 'matching-state' }), routeParams());
    expect(h.cookiesDeleteMock).toHaveBeenCalledWith('oauth_native_challenge_google');
  });
});
