// story f755b1a9: /auth/native BFF 라우트 — logged-out login-CSRF(story 6ae1ecac AC#2) 핵심은
// existing_session_user_id를 절대 클라 입력(body/query)에서 읽지 않고 서버검증 __Host-sp_fs
// 세션에서만 도출하는 것 — 이 파일의 "클라 위조값 무시" 테스트가 그 불변식을 고정한다.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  csrfCheck: vi.fn(),
  cookiesGetMock: vi.fn(),
  resolveFirebaseServerSessionMock: vi.fn(),
}));

vi.mock('@/lib/auth/csrf', () => ({ verifyCsrfOrigin: h.csrfCheck }));
vi.mock('next/headers', () => ({
  cookies: vi.fn(async () => ({ get: h.cookiesGetMock })),
}));
vi.mock('@/lib/db/server', () => ({
  SP_AT_COOKIE: 'sp_at',
  SP_RT_COOKIE: 'sp_rt',
  resolveFirebaseServerSession: (...args: unknown[]) => h.resolveFirebaseServerSessionMock(...args),
}));

const mockFetch = vi.fn();
vi.stubGlobal('fetch', mockFetch);

import { POST } from './route';

function makeJsonRequest(body: unknown): Request {
  return new Request('http://localhost/auth/native', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });
}

function makeUrlencodedRequest(fields: Record<string, string>): Request {
  return new Request('http://localhost/auth/native', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(fields).toString(),
  });
}

const ENV_KEYS = ['FIREBASE_AUTH_MOBILE_ISSUE', 'FIREBASE_BFF_INTERNAL_SECRET', 'NEXT_PUBLIC_FASTAPI_URL'];

describe('POST /auth/native', () => {
  beforeEach(() => {
    h.csrfCheck.mockReset().mockReturnValue(null);
    h.cookiesGetMock.mockReset().mockReturnValue(undefined); // 기본: 기존 세션 없음
    h.resolveFirebaseServerSessionMock.mockReset();
    mockFetch.mockReset();
    for (const k of ENV_KEYS) delete process.env[k];
  });

  afterEach(() => {
    for (const k of ENV_KEYS) delete process.env[k];
  });

  it('returns 501 when FIREBASE_AUTH_MOBILE_ISSUE is unset (default off)', async () => {
    const res = await POST(makeJsonRequest({ code: 'abc' }));
    expect(res.status).toBe(501);
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('returns csrf error passthrough when flag on but CSRF fails', async () => {
    process.env['FIREBASE_AUTH_MOBILE_ISSUE'] = 'true';
    const csrfResponse = new Response('csrf', { status: 403 });
    h.csrfCheck.mockReturnValue(csrfResponse);
    const res = await POST(makeJsonRequest({ code: 'abc' }));
    expect(res.status).toBe(403);
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('returns 401 when code is missing from body', async () => {
    process.env['FIREBASE_AUTH_MOBILE_ISSUE'] = 'true';
    const res = await POST(makeJsonRequest({}));
    expect(res.status).toBe(401);
    expect((await res.json()).error.code).toBe('NATIVE_BOOTSTRAP_FAILED');
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('parses application/x-www-form-urlencoded body (native postUrl payload format)', async () => {
    process.env['FIREBASE_AUTH_MOBILE_ISSUE'] = 'true';
    mockFetch.mockResolvedValue({ ok: true, json: async () => ({ session_cookie: 'cookie-val' }) });
    const res = await POST(makeUrlencodedRequest({ code: 'the-code' }));
    expect(res.status).toBe(303);
    const [, opts] = mockFetch.mock.calls[0] as [string, RequestInit];
    const sentBody = JSON.parse(opts.body as string) as { code: string };
    expect(sentBody.code).toBe('the-code');
  });

  it('returns 401 when internal consume call fails', async () => {
    process.env['FIREBASE_AUTH_MOBILE_ISSUE'] = 'true';
    mockFetch.mockResolvedValue({ ok: false, status: 401, json: async () => ({}) });
    const res = await POST(makeJsonRequest({ code: 'bad-code' }));
    expect(res.status).toBe(401);
  });

  it('returns 401 when internal consume call throws (network error)', async () => {
    process.env['FIREBASE_AUTH_MOBILE_ISSUE'] = 'true';
    mockFetch.mockRejectedValue(new Error('network down'));
    const res = await POST(makeJsonRequest({ code: 'x' }));
    expect(res.status).toBe(401);
  });

  it('returns 401 when consume response is malformed (no session_cookie)', async () => {
    process.env['FIREBASE_AUTH_MOBILE_ISSUE'] = 'true';
    mockFetch.mockResolvedValue({ ok: true, json: async () => ({ unexpected: 'shape' }) });
    const res = await POST(makeJsonRequest({ code: 'x' }));
    expect(res.status).toBe(401);
  });

  it('on success: sets __Host-sp_fs, clears sp_at/sp_rt, 303s to default safe path, no-store + no-referrer headers', async () => {
    process.env['FIREBASE_AUTH_MOBILE_ISSUE'] = 'true';
    process.env['FIREBASE_BFF_INTERNAL_SECRET'] = 'shared-secret';
    mockFetch.mockResolvedValue({ ok: true, json: async () => ({ session_cookie: 'super-secret-cookie' }) });

    const res = await POST(makeJsonRequest({ code: 'valid-code' }));
    expect(res.status).toBe(303);
    expect(res.headers.get('location')).toBe('http://localhost/inbox'); // safeNextPath 기본 폴백
    expect(res.headers.get('cache-control')).toBe('no-store');
    expect(res.headers.get('referrer-policy')).toBe('no-referrer');

    const setCookie = res.headers.get('set-cookie') ?? '';
    expect(setCookie).toContain('__Host-sp_fs=super-secret-cookie');
    expect(setCookie).not.toContain('Domain=');

    const allCookies = res.cookies.getAll();
    expect(allCookies.find((c) => c.name === 'sp_at')?.maxAge).toBe(0);
    expect(allCookies.find((c) => c.name === 'sp_rt')?.maxAge).toBe(0);

    const [, opts] = mockFetch.mock.calls[0] as [string, RequestInit];
    expect((opts.headers as Record<string, string>)['Authorization']).toBe('Bearer shared-secret');
  });

  it('on success with a valid redirect_path: 303s to that exact path (딥링크 복귀)', async () => {
    process.env['FIREBASE_AUTH_MOBILE_ISSUE'] = 'true';
    mockFetch.mockResolvedValue({ ok: true, json: async () => ({ session_cookie: 'c' }) });
    const res = await POST(makeJsonRequest({ code: 'x', redirect_path: '/board/abc123' }));
    expect(res.headers.get('location')).toBe('http://localhost/board/abc123');
  });

  it('on success with an unsafe redirect_path(open-redirect attempt): falls back to safe default, never redirects externally', async () => {
    process.env['FIREBASE_AUTH_MOBILE_ISSUE'] = 'true';
    mockFetch.mockResolvedValue({ ok: true, json: async () => ({ session_cookie: 'c' }) });
    const res = await POST(makeJsonRequest({ code: 'x', redirect_path: '//evil.com/phish' }));
    expect(res.headers.get('location')).toBe('http://localhost/inbox');
    expect(res.headers.get('location')).not.toContain('evil.com');
  });

  it('no existing __Host-sp_fs session: existing_session_user_id is omitted from the consume call', async () => {
    process.env['FIREBASE_AUTH_MOBILE_ISSUE'] = 'true';
    mockFetch.mockResolvedValue({ ok: true, json: async () => ({ session_cookie: 'c' }) });
    h.cookiesGetMock.mockReturnValue(undefined);
    await POST(makeJsonRequest({ code: 'x' }));
    const [, opts] = mockFetch.mock.calls[0] as [string, RequestInit];
    const sentBody = JSON.parse(opts.body as string) as { existing_session_user_id?: string };
    expect(sentBody.existing_session_user_id).toBeUndefined();
    expect(h.resolveFirebaseServerSessionMock).not.toHaveBeenCalled();
  });

  it('no existing __Host-sp_fs session AND client body claims a UID anyway: forged value is never forwarded (login-CSRF core guard)', async () => {
    process.env['FIREBASE_AUTH_MOBILE_ISSUE'] = 'true';
    mockFetch.mockResolvedValue({ ok: true, json: async () => ({ session_cookie: 'c' }) });
    h.cookiesGetMock.mockReturnValue(undefined); // 쿠키 자체가 없음 — 서버검증 경로가 아예 안 돎.
    await POST(makeJsonRequest({ code: 'x', existing_session_user_id: 'attacker-forged-uid-no-cookie' }));
    const [, opts] = mockFetch.mock.calls[0] as [string, RequestInit];
    const sentBody = JSON.parse(opts.body as string) as { existing_session_user_id?: string };
    expect(sentBody.existing_session_user_id).toBeUndefined();
  });

  it('existing valid __Host-sp_fs session: existing_session_user_id is derived from the SERVER-verified session, not any client input', async () => {
    process.env['FIREBASE_AUTH_MOBILE_ISSUE'] = 'true';
    mockFetch.mockResolvedValue({ ok: true, json: async () => ({ session_cookie: 'c' }) });
    h.cookiesGetMock.mockImplementation((name: string) =>
      name === '__Host-sp_fs' ? { value: 'existing-cookie-value' } : undefined,
    );
    h.resolveFirebaseServerSessionMock.mockResolvedValue({
      user_id: 'server-verified-user-id', email: 'a@b.com', access_token: 'x', org_id: null, project_id: null,
    });

    // 클라가 body에 다른(위조) UID를 실어 보내도 — 애초에 그 필드를 읽지 않으므로 무시됨.
    await POST(makeJsonRequest({ code: 'x', existing_session_user_id: 'attacker-forged-uid' }));

    expect(h.resolveFirebaseServerSessionMock).toHaveBeenCalledWith('existing-cookie-value');
    const [, opts] = mockFetch.mock.calls[0] as [string, RequestInit];
    const sentBody = JSON.parse(opts.body as string) as { existing_session_user_id?: string };
    expect(sentBody.existing_session_user_id).toBe('server-verified-user-id');
    expect(sentBody.existing_session_user_id).not.toBe('attacker-forged-uid');
  });

  it('existing __Host-sp_fs cookie present but fails server verification: existing_session_user_id stays omitted (no silent trust)', async () => {
    process.env['FIREBASE_AUTH_MOBILE_ISSUE'] = 'true';
    mockFetch.mockResolvedValue({ ok: true, json: async () => ({ session_cookie: 'c' }) });
    h.cookiesGetMock.mockImplementation((name: string) =>
      name === '__Host-sp_fs' ? { value: 'invalid-or-expired-cookie' } : undefined,
    );
    h.resolveFirebaseServerSessionMock.mockResolvedValue(null);

    await POST(makeJsonRequest({ code: 'x' }));

    const [, opts] = mockFetch.mock.calls[0] as [string, RequestInit];
    const sentBody = JSON.parse(opts.body as string) as { existing_session_user_id?: string };
    expect(sentBody.existing_session_user_id).toBeUndefined();
  });
});
