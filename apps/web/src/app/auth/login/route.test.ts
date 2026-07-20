// e-mobile-oauth-native-handoff-contract §7.4 — OAuth-start native=1/code_challenge 핸들링
// 회귀가드. 핵심: (1) native/code_challenge 없으면 기존 흐름 100% 무변화(회귀 0),
// (2) code_challenge가 §10.3 형식(base64url, 43자+)이 아니면 native 챌린지 쿠키를 세팅하지
// 않음(방어적, 형식 오류 유입 자체를 차단).
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({ cookiesSetMock: vi.fn() }));

vi.mock('next/headers', () => ({
  cookies: vi.fn(async () => ({ set: h.cookiesSetMock })),
}));
vi.mock('@/services/app-url', () => ({ resolveAppUrl: () => 'http://localhost:3108' }));

const mockFetch = vi.fn();
vi.stubGlobal('fetch', mockFetch);

import { GET } from './route';

function makeRequest(query: Record<string, string>): Request {
  const url = new URL('http://localhost/auth/login');
  for (const [k, v] of Object.entries(query)) url.searchParams.set(k, v);
  return new Request(url.toString());
}

const VALID_CHALLENGE = 'a'.repeat(43);

describe('GET /auth/login — native OAuth-start branch', () => {
  beforeEach(() => {
    mockFetch.mockReset();
    h.cookiesSetMock.mockReset();
    mockFetch.mockResolvedValue({ ok: true, json: async () => ({ data: { url: 'https://accounts.google.com/o/oauth2/auth', state: 'st' } }) });
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it('without native param: no native challenge cookie set (legacy flow unchanged)', async () => {
    await GET(makeRequest({ provider: 'google' }));
    const cookieNames = h.cookiesSetMock.mock.calls.map((c) => c[0] as string);
    expect(cookieNames).not.toContain('oauth_native_challenge_google');
  });

  it('native=1 but no code_challenge: no native challenge cookie set', async () => {
    await GET(makeRequest({ provider: 'google', native: '1' }));
    const cookieNames = h.cookiesSetMock.mock.calls.map((c) => c[0] as string);
    expect(cookieNames).not.toContain('oauth_native_challenge_google');
  });

  it('code_challenge present but native flag absent: no native challenge cookie set', async () => {
    await GET(makeRequest({ provider: 'google', code_challenge: VALID_CHALLENGE }));
    const cookieNames = h.cookiesSetMock.mock.calls.map((c) => c[0] as string);
    expect(cookieNames).not.toContain('oauth_native_challenge_google');
  });

  it('native=1 + valid code_challenge: sets the httpOnly native challenge cookie with the exact value', async () => {
    await GET(makeRequest({ provider: 'google', native: '1', code_challenge: VALID_CHALLENGE }));
    const call = h.cookiesSetMock.mock.calls.find((c) => c[0] === 'oauth_native_challenge_google');
    expect(call).toBeDefined();
    expect(call?.[1]).toBe(VALID_CHALLENGE);
    expect(call?.[2]).toMatchObject({ httpOnly: true, sameSite: 'lax' });
  });

  it('§10.3 format guard: rejects a too-short code_challenge (under 43 chars) — no cookie set', async () => {
    await GET(makeRequest({ provider: 'google', native: '1', code_challenge: 'too-short' }));
    const cookieNames = h.cookiesSetMock.mock.calls.map((c) => c[0] as string);
    expect(cookieNames).not.toContain('oauth_native_challenge_google');
  });

  it('§10.3 format guard: rejects a code_challenge with invalid characters (non base64url) — no cookie set', async () => {
    await GET(makeRequest({ provider: 'google', native: '1', code_challenge: `${'a'.repeat(40)}+/=` }));
    const cookieNames = h.cookiesSetMock.mock.calls.map((c) => c[0] as string);
    expect(cookieNames).not.toContain('oauth_native_challenge_google');
  });
});
