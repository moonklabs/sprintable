// e-mobile-oauth-native-handoff-contract §5/§6/§10 — 격리 rail consume 착지 회귀가드.
// 핵심 불변식: (1) FIREBASE_OAUTH_HANDOFF_ENABLED 기본 off, (2) code+code_verifier(+#3121
// AC1 callback_mode)만 받고 다른 필드는 계약에 없음(installation_id 등 attested 필드가
// 여기 섞이면 격리 위반), (3) mint 대상=레거시 sp_at/sp_rt(Firebase 아님), (4) 실패는 전부
// 동일 401(enumeration 방지).
//
// story #3121 AC1 추가분 — 이 라우트는 issue 시점 쿠키와 연속성이 없는 웹뷰 top-level POST라
// callback_mode는 요청 body에서만 온다(§ route.ts 상단 주석). 핵심: (5) callback_mode 없으면
// (구버전 클라) BE 호출에서 그 필드 자체를 뺀다(반쪽만 보내지 않는다 — BE Phase 1 계약과
// 대칭), (6) 있으면 형식 검증 후 그대로 전달+return_uri는 고정 매핑으로 계산(클라 입력 URI를
// 안 믿는다), (7) 형식이 틀리면 거부한다.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({ csrfCheck: vi.fn() }));

vi.mock('@/lib/auth/csrf', () => ({ verifyCsrfOrigin: h.csrfCheck }));
vi.mock('@/lib/db/server', () => ({ SP_AT_COOKIE: 'sp_at', SP_RT_COOKIE: 'sp_rt' }));

const mockFetch = vi.fn();
vi.stubGlobal('fetch', mockFetch);

import { POST } from './route';

function makeJsonRequest(body: unknown): Request {
  return new Request('http://localhost/auth/oauth-handoff', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });
}

function makeUrlencodedRequest(fields: Record<string, string>): Request {
  return new Request('http://localhost/auth/oauth-handoff', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(fields).toString(),
  });
}

const ENV_KEYS = ['FIREBASE_OAUTH_HANDOFF_ENABLED', 'FIREBASE_BFF_INTERNAL_SECRET', 'NEXT_PUBLIC_FASTAPI_URL', 'MOBILE_APP_LINK_ORIGIN'];

describe('POST /auth/oauth-handoff', () => {
  beforeEach(() => {
    h.csrfCheck.mockReset().mockReturnValue(null);
    mockFetch.mockReset();
    for (const k of ENV_KEYS) delete process.env[k];
  });

  afterEach(() => {
    for (const k of ENV_KEYS) delete process.env[k];
  });

  it('returns 501 when FIREBASE_OAUTH_HANDOFF_ENABLED is unset (default off)', async () => {
    const res = await POST(makeJsonRequest({ code: 'c', code_verifier: 'v' }));
    expect(res.status).toBe(501);
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('returns csrf error passthrough when flag on but CSRF fails', async () => {
    process.env['FIREBASE_OAUTH_HANDOFF_ENABLED'] = 'true';
    const csrfResponse = new Response('csrf', { status: 403 });
    h.csrfCheck.mockReturnValue(csrfResponse);
    const res = await POST(makeJsonRequest({ code: 'c', code_verifier: 'v' }));
    expect(res.status).toBe(403);
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('returns 401 when code is missing', async () => {
    process.env['FIREBASE_OAUTH_HANDOFF_ENABLED'] = 'true';
    const res = await POST(makeJsonRequest({ code_verifier: 'v' }));
    expect(res.status).toBe(401);
    expect((await res.json()).error.code).toBe('OAUTH_HANDOFF_FAILED');
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('returns 401 when code_verifier is missing', async () => {
    process.env['FIREBASE_OAUTH_HANDOFF_ENABLED'] = 'true';
    const res = await POST(makeJsonRequest({ code: 'c' }));
    expect(res.status).toBe(401);
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('parses application/x-www-form-urlencoded body (native postUrl payload format)', async () => {
    process.env['FIREBASE_OAUTH_HANDOFF_ENABLED'] = 'true';
    mockFetch.mockResolvedValue({ ok: true, json: async () => ({ access_token: 'at', refresh_token: 'rt', token_type: 'bearer', expires_in: 3600 }) });
    const res = await POST(makeUrlencodedRequest({ code: 'the-code', code_verifier: 'the-verifier' }));
    expect(res.status).toBe(303);
    const [, opts] = mockFetch.mock.calls[0] as [string, RequestInit];
    const sentBody = JSON.parse(opts.body as string) as { code: string; code_verifier: string };
    expect(sentBody).toEqual({ code: 'the-code', code_verifier: 'the-verifier' });
  });

  it('sends only {code, code_verifier} to consume — no attested/installation fields leak through (isolation rail)', async () => {
    process.env['FIREBASE_OAUTH_HANDOFF_ENABLED'] = 'true';
    mockFetch.mockResolvedValue({ ok: true, json: async () => ({ access_token: 'at', refresh_token: 'rt' }) });
    // 까심 QA(#2230): attested 필드 세트를 전량 커버해야 격리 보장이 완전함 — /auth/native의
    // 실 스키마(installation_id/challenge_id/client_data_b64url/key_version/assertion_b64/
    // signature_b64) + device_key까지 전부 hostile payload에 실어 하나도 안 새는지 확認.
    await POST(makeJsonRequest({
      code: 'c', code_verifier: 'v',
      installation_id: 'should-be-ignored', challenge_id: 'should-be-ignored',
      client_data_b64url: 'should-be-ignored', key_version: 1,
      assertion_b64: 'should-be-ignored', signature_b64: 'should-be-ignored',
      device_key: 'should-be-ignored',
    }));
    const [, opts] = mockFetch.mock.calls[0] as [string, RequestInit];
    const sentBody = JSON.parse(opts.body as string) as Record<string, unknown>;
    expect(Object.keys(sentBody).sort()).toEqual(['code', 'code_verifier']);
  });

  it('calls the isolated oauth-handoff consume endpoint, not the attested native-bootstrap one', async () => {
    process.env['FIREBASE_OAUTH_HANDOFF_ENABLED'] = 'true';
    mockFetch.mockResolvedValue({ ok: true, json: async () => ({ access_token: 'at', refresh_token: 'rt' }) });
    await POST(makeJsonRequest({ code: 'c', code_verifier: 'v' }));
    const [calledUrl] = mockFetch.mock.calls[0] as [string, RequestInit];
    expect(calledUrl).toContain('/api/v2/internal/auth/oauth-handoff/consume');
    expect(calledUrl).not.toContain('native-bootstrap');
  });

  it('returns 401 when consume call fails (BE 4xx)', async () => {
    process.env['FIREBASE_OAUTH_HANDOFF_ENABLED'] = 'true';
    mockFetch.mockResolvedValue({ ok: false, status: 401, json: async () => ({}) });
    const res = await POST(makeJsonRequest({ code: 'bad', code_verifier: 'v' }));
    expect(res.status).toBe(401);
  });

  it('returns 401 when consume call throws (network error)', async () => {
    process.env['FIREBASE_OAUTH_HANDOFF_ENABLED'] = 'true';
    mockFetch.mockRejectedValue(new Error('network down'));
    const res = await POST(makeJsonRequest({ code: 'c', code_verifier: 'v' }));
    expect(res.status).toBe(401);
  });

  it('returns 401 when consume response is malformed (missing access_token)', async () => {
    process.env['FIREBASE_OAUTH_HANDOFF_ENABLED'] = 'true';
    mockFetch.mockResolvedValue({ ok: true, json: async () => ({ refresh_token: 'rt' }) });
    const res = await POST(makeJsonRequest({ code: 'c', code_verifier: 'v' }));
    expect(res.status).toBe(401);
  });

  it('returns 401 when consume response is malformed (missing refresh_token)', async () => {
    process.env['FIREBASE_OAUTH_HANDOFF_ENABLED'] = 'true';
    mockFetch.mockResolvedValue({ ok: true, json: async () => ({ access_token: 'at' }) });
    const res = await POST(makeJsonRequest({ code: 'c', code_verifier: 'v' }));
    expect(res.status).toBe(401);
  });

  it('on success: mints legacy sp_at/sp_rt (NOT __Host-sp_fs Firebase cookie), 303s to /glance, no-store + no-referrer', async () => {
    process.env['FIREBASE_OAUTH_HANDOFF_ENABLED'] = 'true';
    process.env['FIREBASE_BFF_INTERNAL_SECRET'] = 'shared-secret';
    mockFetch.mockResolvedValue({
      ok: true,
      json: async () => ({ access_token: 'legacy-access-token', refresh_token: 'legacy-refresh-token', token_type: 'bearer', expires_in: 3600 }),
    });

    const res = await POST(makeJsonRequest({ code: 'valid-code', code_verifier: 'valid-verifier' }));
    expect(res.status).toBe(303);
    expect(res.headers.get('location')).toBe('http://localhost:3108/glance');
    expect(res.headers.get('cache-control')).toBe('no-store');
    expect(res.headers.get('referrer-policy')).toBe('no-referrer');

    const setCookie = res.headers.get('set-cookie') ?? '';
    expect(setCookie).toContain('sp_at=legacy-access-token');
    expect(setCookie).not.toContain('__Host-sp_fs');

    const allCookies = res.cookies.getAll();
    expect(allCookies.find((c) => c.name === 'sp_at')?.value).toBe('legacy-access-token');
    expect(allCookies.find((c) => c.name === 'sp_rt')?.value).toBe('legacy-refresh-token');

    const [, opts] = mockFetch.mock.calls[0] as [string, RequestInit];
    expect((opts.headers as Record<string, string>)['Authorization']).toBe('Bearer shared-secret');
  });

  it('no redirect_path support — always redirects to /glance regardless of any client-supplied path (no open-redirect surface)', async () => {
    process.env['FIREBASE_OAUTH_HANDOFF_ENABLED'] = 'true';
    mockFetch.mockResolvedValue({ ok: true, json: async () => ({ access_token: 'at', refresh_token: 'rt' }) });
    const res = await POST(makeJsonRequest({ code: 'c', code_verifier: 'v', redirect_path: '//evil.com/phish' }));
    expect(res.headers.get('location')).toBe('http://localhost:3108/glance');
  });

  // ── story #3121 AC1 — callback_mode consume 절반 ──────────────────────────────
  describe('callback_mode (#3121 AC1)', () => {
    it('without callback_mode (legacy client): omits callback_mode/return_uri from the BE call entirely (never sends just one)', async () => {
      process.env['FIREBASE_OAUTH_HANDOFF_ENABLED'] = 'true';
      mockFetch.mockResolvedValue({ ok: true, json: async () => ({ access_token: 'at', refresh_token: 'rt' }) });
      await POST(makeJsonRequest({ code: 'c', code_verifier: 'v' }));
      const [, opts] = mockFetch.mock.calls[0] as [string, RequestInit];
      const sentBody = JSON.parse(opts.body as string) as Record<string, unknown>;
      expect(sentBody).not.toHaveProperty('callback_mode');
      expect(sentBody).not.toHaveProperty('return_uri');
    });

    it('with callback_mode=https: forwards callback_mode + the fixed https return_uri', async () => {
      process.env['FIREBASE_OAUTH_HANDOFF_ENABLED'] = 'true';
      process.env['MOBILE_APP_LINK_ORIGIN'] = 'https://dev-app.sprintable.ai';
      mockFetch.mockResolvedValue({ ok: true, json: async () => ({ access_token: 'at', refresh_token: 'rt' }) });
      await POST(makeJsonRequest({ code: 'c', code_verifier: 'v', callback_mode: 'https' }));
      const [, opts] = mockFetch.mock.calls[0] as [string, RequestInit];
      const sentBody = JSON.parse(opts.body as string) as { callback_mode: string; return_uri: string };
      expect(sentBody.callback_mode).toBe('https');
      expect(sentBody.return_uri).toBe('https://dev-app.sprintable.ai/native/oauth-return');
    });

    it('with callback_mode=custom_scheme: forwards the byte-exact ai.sprintable return_uri, unaffected by MOBILE_APP_LINK_ORIGIN', async () => {
      process.env['FIREBASE_OAUTH_HANDOFF_ENABLED'] = 'true';
      process.env['MOBILE_APP_LINK_ORIGIN'] = 'https://app.sprintable.ai';
      mockFetch.mockResolvedValue({ ok: true, json: async () => ({ access_token: 'at', refresh_token: 'rt' }) });
      await POST(makeJsonRequest({ code: 'c', code_verifier: 'v', callback_mode: 'custom_scheme' }));
      const [, opts] = mockFetch.mock.calls[0] as [string, RequestInit];
      const sentBody = JSON.parse(opts.body as string) as { callback_mode: string; return_uri: string };
      expect(sentBody.callback_mode).toBe('custom_scheme');
      expect(sentBody.return_uri).toBe('ai.sprintable:/oauth-return');
    });

    it('with an invalid callback_mode value: rejects the request (never forwards garbage to BE)', async () => {
      process.env['FIREBASE_OAUTH_HANDOFF_ENABLED'] = 'true';
      const res = await POST(makeJsonRequest({ code: 'c', code_verifier: 'v', callback_mode: 'android' }));
      expect(res.status).toBe(401);
      expect(mockFetch).not.toHaveBeenCalled();
    });

    // 자기검증(뮤테이션) — "반쪽만 보내면 안 된다" 불변식이 실제로 지켜지는지: callback_mode가
    // 없을 때 return_uri **혼자** 새 나가면 안 된다(半-공급은 BE Literal 스키마를 아예 못 만족).
    it('mut: never sends return_uri without callback_mode, or vice versa', async () => {
      process.env['FIREBASE_OAUTH_HANDOFF_ENABLED'] = 'true';
      mockFetch.mockResolvedValue({ ok: true, json: async () => ({ access_token: 'at', refresh_token: 'rt' }) });
      await POST(makeJsonRequest({ code: 'c', code_verifier: 'v' }));
      const sentBody = JSON.parse((mockFetch.mock.calls[0] as [string, RequestInit])[1].body as string) as Record<string, unknown>;
      expect('callback_mode' in sentBody).toBe('return_uri' in sentBody);
    });
  });
});
