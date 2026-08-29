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

  it('without a native challenge cookie: legacy flow is fully unchanged (regression guard) — sets sp_at/sp_rt, redirects to /chats', async () => {
    stubCookies();
    mockFetch.mockResolvedValueOnce({
      ok: true, json: async () => ({ data: { access_token: 'legacy-at', refresh_token: 'legacy-rt' } }),
    });
    const res = await GET(makeRequest({ code: 'c', state: 'matching-state' }), routeParams());
    expect(res.status).toBe(307);
    expect(res.headers.get('location')).toBe('http://localhost:3108/chats');
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
    const sentBody = JSON.parse(issueOpts.body as string) as {
      user_id: string; code_challenge: string; callback_mode: string; return_uri: string;
    };
    // story #3121 AC1 — callback_mode 쿠키 부재 시 https로 기본 유도(구버전 클라 대비).
    expect(sentBody).toEqual({
      user_id: 'user-123',
      code_challenge: 'a'.repeat(43),
      callback_mode: 'https',
      return_uri: 'https://dev-app.sprintable.ai/native/oauth-return',
    });
  });

  // story #3121 AC1 — custom_scheme 쿠키가 있으면 issue 호출에 그대로 실어 보낸다(https 기본값
  // 오버라이드). return_uri는 App.js OAUTH_RETURN_SCHEME_URL과 byte-exact 고정값이라 별도
  // env(MOBILE_APP_LINK_ORIGIN)에 안 흔들린다 — 그것도 같이 확認.
  it('with callback_mode=custom_scheme cookie: sends custom_scheme + fixed ai.sprintable return_uri to issue', async () => {
    stubCookies({ oauth_native_challenge_google: 'a'.repeat(43), oauth_native_callback_mode_google: 'custom_scheme' });
    process.env['MOBILE_APP_LINK_ORIGIN'] = 'https://app.sprintable.ai'; // custom_scheme엔 무영향이어야 함
    mockFetch
      .mockResolvedValueOnce({ ok: true, json: async () => ({ data: { access_token: fakeJwt({ sub: 'user-123' }), refresh_token: 'legacy-rt' } }) })
      .mockResolvedValueOnce({ ok: true, json: async () => ({ code: 'handoff-code-xyz' }) });

    await GET(makeRequest({ code: 'c', state: 'matching-state' }), routeParams());
    const [, issueOpts] = mockFetch.mock.calls[1] as [string, RequestInit];
    const sentBody = JSON.parse(issueOpts.body as string) as { callback_mode: string; return_uri: string };
    expect(sentBody.callback_mode).toBe('custom_scheme');
    expect(sentBody.return_uri).toBe('ai.sprintable:/oauth-return');
  });

  // 자기검증(뮤테이션) — 쿠키 값이 스키마 밖(임의 문자열)이면 https로 안전 폴백해야지, 그
  // 값을 그대로 흘려보내면 안 된다(BE가 Literal["https","custom_scheme"]로 거부하는 자리를
  // BFF가 미리 안 막으면 native 로그인 전체가 400으로 죽는다).
  it('with an invalid callback_mode cookie value: falls back to https (never forwards garbage)', async () => {
    stubCookies({ oauth_native_challenge_google: 'a'.repeat(43), oauth_native_callback_mode_google: 'not-a-real-mode' });
    mockFetch
      .mockResolvedValueOnce({ ok: true, json: async () => ({ data: { access_token: fakeJwt({ sub: 'user-123' }), refresh_token: 'legacy-rt' } }) })
      .mockResolvedValueOnce({ ok: true, json: async () => ({ code: 'x' }) });

    await GET(makeRequest({ code: 'c', state: 'matching-state' }), routeParams());
    const [, issueOpts] = mockFetch.mock.calls[1] as [string, RequestInit];
    const sentBody = JSON.parse(issueOpts.body as string) as { callback_mode: string };
    expect(sentBody.callback_mode).toBe('https');
  });

  it('with a native challenge cookie: deletes the callback_mode cookie (single-use, like the other oauth_* cookies)', async () => {
    stubCookies({ oauth_native_challenge_google: 'a'.repeat(43), oauth_native_callback_mode_google: 'custom_scheme' });
    mockFetch
      .mockResolvedValueOnce({ ok: true, json: async () => ({ data: { access_token: fakeJwt({ sub: 'user-123' }), refresh_token: 'legacy-rt' } }) })
      .mockResolvedValueOnce({ ok: true, json: async () => ({ code: 'x' }) });

    await GET(makeRequest({ code: 'c', state: 'matching-state' }), routeParams());
    expect(h.cookiesDeleteMock).toHaveBeenCalledWith('oauth_native_callback_mode_google');
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

describe('GET /api/auth/callback/[provider] — state 검증 분기 로그(2026-07-28 진단, 가드는 무변화)', () => {
  let warnSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    mockFetch.mockReset();
    h.cookiesGetMock.mockReset();
    h.cookiesDeleteMock.mockReset();
    warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
  });

  afterEach(() => {
    warnSpy.mockRestore();
  });

  function stubCookies(overrides: Record<string, string> = {}) {
    h.cookiesGetMock.mockImplementation((name: string) =>
      name in overrides ? { value: overrides[name] } : undefined,
    );
  }

  it('ⓐ 쿠키가 아예 없으면 missing_cookie로 로그되고, 검증 결과는 원래와 동일하게 csrf_mismatch로 리다이렉트한다', async () => {
    stubCookies(); // oauth_state_google 자체가 없음
    const res = await GET(
      makeRequest({ code: 'c', state: 'some-state-value-from-attacker-or-replay' }),
      routeParams(),
    );
    expect(res.headers.get('location')).toBe('http://localhost:3108/login?error=csrf_mismatch');
    expect(mockFetch).not.toHaveBeenCalled(); // FastAPI까지 안 감(검증이 여전히 앞단에서 막음)

    const logLine = warnSpy.mock.calls.map((c) => String(c[0])).find((l) => l.includes('state_check'));
    expect(logLine).toContain('outcome=missing_cookie');
    expect(logLine).toContain('stored_state_len=null');
  });

  it('ⓑ 쿠키는 있는데 값이 다르면 state_mismatch로 로그되고, 검증 결과는 원래와 동일하게 csrf_mismatch로 리다이렉트한다', async () => {
    stubCookies({ oauth_state_google: 'stored-value-aaa' });
    const res = await GET(makeRequest({ code: 'c', state: 'incoming-value-bbb' }), routeParams());
    expect(res.headers.get('location')).toBe('http://localhost:3108/login?error=csrf_mismatch');
    expect(mockFetch).not.toHaveBeenCalled();

    const logLine = warnSpy.mock.calls.map((c) => String(c[0])).find((l) => l.includes('state_check'));
    expect(logLine).toContain('outcome=state_mismatch');
    expect(logLine).not.toContain('stored_state_len=null'); // 존재는 했다
  });

  it('양성대조 — 통과 경로(dev 포함)에도 outcome=ok 로그가 남는다(미도달과 무로그를 구분)', async () => {
    stubCookies({ oauth_state_google: 'matching-state' });
    mockFetch.mockResolvedValueOnce({
      ok: true, json: async () => ({ data: { access_token: 'at', refresh_token: 'rt' } }),
    });
    await GET(makeRequest({ code: 'c', state: 'matching-state' }), routeParams());

    const logLine = warnSpy.mock.calls.map((c) => String(c[0])).find((l) => l.includes('state_check'));
    expect(logLine).toContain('outcome=ok');
  });

  it('⛔state 값·쿠키 값을 로그에 절대 안 찍는다(길이/존재 여부만) — 세 분기 모두', async () => {
    const secretState = 'THIS-MUST-NEVER-APPEAR-IN-LOGS-abc123';
    const secretStored = 'THIS-STORED-VALUE-MUST-NEVER-APPEAR-xyz789';

    stubCookies({ oauth_state_google: secretStored });
    await GET(makeRequest({ code: 'c', state: secretState }), routeParams());

    const allLoggedText = warnSpy.mock.calls.map((c) => c.join(' ')).join('\n');
    expect(allLoggedText).not.toContain(secretState);
    expect(allLoggedText).not.toContain(secretStored);
  });
});

// story #3204(acquisition 계측) — sign_up 전환 이벤트 발화 신호(?signup=1)+first-touch
// 귀속 쿠키 relay. register/page.tsx(email 경로)와 동일 파라미터로 발화 지점을 하나로
// 모으는 SSOT 계약의 OAuth 쪽 절반.
describe('GET /api/auth/callback/[provider] — sign_up 전환 신호 + 귀속 쿠키 relay(story #3204)', () => {
  beforeEach(() => {
    mockFetch.mockReset();
    h.cookiesGetMock.mockReset();
    h.cookiesDeleteMock.mockReset();
    for (const k of ENV_KEYS) delete process.env[k];
  });

  function stubCookies(overrides: Record<string, string> = {}) {
    const defaults: Record<string, string> = { oauth_state_google: 'matching-state', ...overrides };
    h.cookiesGetMock.mockImplementation((name: string) =>
      name in defaults ? { value: defaults[name] } : undefined,
    );
  }

  it('is_new_user=true — 목적지 URL에 ?signup=1이 붙는다', async () => {
    stubCookies();
    mockFetch.mockResolvedValueOnce({
      ok: true, json: async () => ({ data: { access_token: 'at', refresh_token: 'rt', is_new_user: true } }),
    });
    const res = await GET(makeRequest({ code: 'c', state: 'matching-state' }), routeParams());
    expect(res.headers.get('location')).toBe('http://localhost:3108/chats?signup=1');
  });

  it('is_new_user=false(기존 유저 로그인) — signup 파라미터가 안 붙는다(재로그인마다 중복 발화 금지)', async () => {
    stubCookies();
    mockFetch.mockResolvedValueOnce({
      ok: true, json: async () => ({ data: { access_token: 'at', refresh_token: 'rt', is_new_user: false } }),
    });
    const res = await GET(makeRequest({ code: 'c', state: 'matching-state' }), routeParams());
    expect(res.headers.get('location')).toBe('http://localhost:3108/chats');
  });

  it('first-touch 귀속 쿠키가 있으면 BE oauth/callback 요청 바디에 그대로 실려 간다', async () => {
    stubCookies({
      sp_attr_src: 'google', sp_attr_medium: 'cpc', sp_attr_campaign: 'launch', sp_attr_ref: 'https://twitter.com/x',
    });
    mockFetch.mockResolvedValueOnce({
      ok: true, json: async () => ({ data: { access_token: 'at', refresh_token: 'rt', is_new_user: true } }),
    });
    await GET(makeRequest({ code: 'c', state: 'matching-state' }), routeParams());

    const call = mockFetch.mock.calls.find((c) => String(c[0]).includes('/api/v2/auth/oauth/callback'));
    const body = JSON.parse((call?.[1] as { body: string }).body);
    expect(body).toMatchObject({
      signup_utm_source: 'google', signup_utm_medium: 'cpc',
      signup_utm_campaign: 'launch', signup_referrer: 'https://twitter.com/x',
    });
  });

  it('귀속 쿠키가 없으면 요청 바디에 그 필드들 자체가 없다(빈 문자열을 지어내지 않음)', async () => {
    stubCookies();
    mockFetch.mockResolvedValueOnce({
      ok: true, json: async () => ({ data: { access_token: 'at', refresh_token: 'rt', is_new_user: true } }),
    });
    await GET(makeRequest({ code: 'c', state: 'matching-state' }), routeParams());

    const call = mockFetch.mock.calls.find((c) => String(c[0]).includes('/api/v2/auth/oauth/callback'));
    const body = JSON.parse((call?.[1] as { body: string }).body);
    expect(body).not.toHaveProperty('signup_utm_source');
    expect(body).not.toHaveProperty('signup_referrer');
  });
});
