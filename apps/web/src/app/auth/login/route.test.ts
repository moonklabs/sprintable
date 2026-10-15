// e-mobile-oauth-native-handoff-contract §7.4 — OAuth-start native=1/code_challenge 핸들링
// 회귀가드. 핵심: (1) native/code_challenge 없으면 기존 흐름 100% 무변화(회귀 0),
// (2) code_challenge가 §10.3 형식(base64url, 43자+)이 아니면 native 챌린지 쿠키를 세팅하지
// 않음(방어적, 형식 오류 유입 자체를 차단).
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({ cookiesSetMock: vi.fn(), cookiesDeleteMock: vi.fn() }));

vi.mock('next/headers', () => ({
  cookies: vi.fn(async () => ({ set: h.cookiesSetMock, delete: h.cookiesDeleteMock })),
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
    h.cookiesDeleteMock.mockReset();
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

  // story #3121 AC1 — 모바일이 OAuth 시작 전 정적으로 고른 호환 모드를 그대로 쿠키에 심는다.
  it('native=1 + callback_mode=custom_scheme: sets the callback_mode cookie with the exact value', async () => {
    await GET(makeRequest({ provider: 'google', native: '1', code_challenge: VALID_CHALLENGE, callback_mode: 'custom_scheme' }));
    const call = h.cookiesSetMock.mock.calls.find((c) => c[0] === 'oauth_native_callback_mode_google');
    expect(call).toBeDefined();
    expect(call?.[1]).toBe('custom_scheme');
  });

  it('native=1 + callback_mode=https: sets the callback_mode cookie', async () => {
    await GET(makeRequest({ provider: 'google', native: '1', code_challenge: VALID_CHALLENGE, callback_mode: 'https' }));
    const call = h.cookiesSetMock.mock.calls.find((c) => c[0] === 'oauth_native_callback_mode_google');
    expect(call?.[1]).toBe('https');
  });

  it('invalid callback_mode value: does not set the cookie (콜백이 https 기본값으로 유도)', async () => {
    await GET(makeRequest({ provider: 'google', native: '1', code_challenge: VALID_CHALLENGE, callback_mode: 'android' }));
    const cookieNames = h.cookiesSetMock.mock.calls.map((c) => c[0] as string);
    expect(cookieNames).not.toContain('oauth_native_callback_mode_google');
  });

  it('callback_mode present but native flag absent: no callback_mode cookie set (legacy flow unchanged)', async () => {
    await GET(makeRequest({ provider: 'google', code_challenge: VALID_CHALLENGE, callback_mode: 'custom_scheme' }));
    const cookieNames = h.cookiesSetMock.mock.calls.map((c) => c[0] as string);
    expect(cookieNames).not.toContain('oauth_native_callback_mode_google');
  });

  // story #4626 — which desktop app to hand back to: only the closed table's value is kept
  it('[4626] return_app=check (native) → the return_app cookie «check» · off the table → no cookie · not native → no cookie', async () => {
    const appCookie = () => h.cookiesSetMock.mock.calls.find((c) => c[0] === 'oauth_native_return_app_google');
    await GET(makeRequest({ provider: 'google', native: '1', code_challenge: VALID_CHALLENGE, callback_mode: 'custom_scheme', return_app: 'check' }));
    expect(appCookie()?.[1]).toBe('check');
    for (const off of ['evil', 'CHECK', 'ai.sprintable.check', ' check', '']) {
      h.cookiesSetMock.mockReset();
      await GET(makeRequest({ provider: 'google', native: '1', code_challenge: VALID_CHALLENGE, callback_mode: 'custom_scheme', return_app: off }));
      expect(appCookie(), off).toBeUndefined();
    }
    h.cookiesSetMock.mockReset();
    await GET(makeRequest({ provider: 'google', code_challenge: VALID_CHALLENGE, return_app: 'check' }));
    expect(appCookie(), 'not a native start').toBeUndefined();
  });

  it('[4626 · Kadir 08:18Z] a native start without return_app (or off the table) drops a return_app cookie an earlier start left', async () => {
    const starts: Record<string, string>[] = [{}, { return_app: 'evil' }, { return_app: 'Check' }];
    for (const q of starts) {
      h.cookiesSetMock.mockReset();
      h.cookiesDeleteMock.mockReset();
      await GET(makeRequest({ provider: 'google', native: '1', code_challenge: VALID_CHALLENGE, callback_mode: 'custom_scheme', ...q }));
      expect(h.cookiesDeleteMock, JSON.stringify(q)).toHaveBeenCalledWith('oauth_native_return_app_google');
      expect(h.cookiesSetMock.mock.calls.some((c) => c[0] === 'oauth_native_return_app_google'), JSON.stringify(q)).toBe(false);
    }
    // a start with it sets, never deletes
    h.cookiesDeleteMock.mockReset();
    await GET(makeRequest({ provider: 'google', native: '1', code_challenge: VALID_CHALLENGE, callback_mode: 'custom_scheme', return_app: 'check' }));
    expect(h.cookiesDeleteMock).not.toHaveBeenCalledWith('oauth_native_return_app_google');
  });

  // story #4628 — each start says all of its own values: one it does not carry is deleted (never left from an earlier start).
  // The five of 4628 and 4626's return_app (rebased onto 5010: the same rule, a web start drops it too)
  const SIX = ['oauth_tos', 'oauth_invite_token', 'oauth_next', 'oauth_native_challenge', 'oauth_native_callback_mode', 'oauth_native_return_app'] as const;
  const setNames = () => h.cookiesSetMock.mock.calls.map((c) => c[0] as string);
  const deletedNames = () => h.cookiesDeleteMock.mock.calls.map((c) => c[0] as string);

  it('[4628] a start with none of the values deletes each of the six — and sets none', async () => {
    await GET(makeRequest({ provider: 'google' }));
    for (const n of SIX) {
      expect(deletedNames(), n).toContain(`${n}_google`);
      expect(setNames(), n).not.toContain(`${n}_google`);
    }
    expect(setNames()).toContain('oauth_state_google'); // the state is always written
  });

  it('[4628] a start with all six values sets each (as before, byte for byte) and deletes none', async () => {
    await GET(makeRequest({ provider: 'google', tos_accepted: 'true', invite_token: 'inv-1', next: '/board', native: '1', code_challenge: VALID_CHALLENGE, callback_mode: 'custom_scheme', return_app: 'check' }));
    const value = (n: string) => h.cookiesSetMock.mock.calls.find((c) => c[0] === `${n}_google`)?.[1];
    expect(SIX.map(value)).toEqual(['true', 'inv-1', '/board', VALID_CHALLENGE, 'custom_scheme', 'check']);
    expect(deletedNames()).toEqual(['oauth_link_google']); // only the connect flag, which a sign-in never carries (below)
  });

  it('[4628 follow-up] every sign-in start drops oauth_link_* (set by /auth/link · a sign-in never carries it) and never sets it', async () => {
    for (const provider of ['google', 'apple'] as const) {
      h.cookiesSetMock.mockReset(); h.cookiesDeleteMock.mockReset();
      await GET(makeRequest({ provider }));
      expect(deletedNames()).toContain(`oauth_link_${provider}`);
      expect(setNames()).not.toContain(`oauth_link_${provider}`);
    }
  });

  it('[4628] a native start with an invalid mode drops an old mode · a bad challenge drops the old challenge and mode · tos=false drops tos', async () => {
    await GET(makeRequest({ provider: 'google', native: '1', code_challenge: VALID_CHALLENGE, callback_mode: 'android' }));
    expect(deletedNames()).toContain('oauth_native_callback_mode_google');
    expect(setNames()).toContain('oauth_native_challenge_google');
    h.cookiesSetMock.mockReset(); h.cookiesDeleteMock.mockReset();
    await GET(makeRequest({ provider: 'google', native: '1', code_challenge: 'too-short', callback_mode: 'custom_scheme', tos_accepted: 'false' }));
    expect(deletedNames()).toEqual(expect.arrayContaining(['oauth_native_challenge_google', 'oauth_native_callback_mode_google', 'oauth_tos_google']));
  });
});
