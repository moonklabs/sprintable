import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({ csrfCheck: vi.fn() }));
vi.mock('@/lib/auth/csrf', () => ({ verifyCsrfOrigin: h.csrfCheck }));

const mockFetch = vi.fn();
vi.stubGlobal('fetch', mockFetch);

import { POST } from './route';

function makeRequest(body: unknown): Request {
  return new Request('http://localhost/api/auth/firebase/session', {
    method: 'POST',
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });
}

describe('POST /api/auth/firebase/session', () => {
  beforeEach(() => {
    h.csrfCheck.mockReset().mockReturnValue(null);
    mockFetch.mockReset();
    delete process.env['FIREBASE_AUTH_ISSUE_SESSION'];
    delete process.env['FIREBASE_BFF_INTERNAL_SECRET'];
    delete process.env['NEXT_PUBLIC_FASTAPI_URL'];
  });

  afterEach(() => {
    delete process.env['FIREBASE_AUTH_ISSUE_SESSION'];
    delete process.env['FIREBASE_BFF_INTERNAL_SECRET'];
    delete process.env['NEXT_PUBLIC_FASTAPI_URL'];
  });

  it('returns 501 when FIREBASE_AUTH_ISSUE_SESSION is unset (default off)', async () => {
    const res = await POST(makeRequest({}));
    expect(res.status).toBe(501);
    expect((await res.json()).error.code).toBe('NOT_ENABLED');
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('returns 501 when FIREBASE_AUTH_ISSUE_SESSION is explicitly false', async () => {
    process.env['FIREBASE_AUTH_ISSUE_SESSION'] = 'false';
    const res = await POST(makeRequest({}));
    expect(res.status).toBe(501);
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('returns csrf error passthrough when flag on but CSRF fails', async () => {
    process.env['FIREBASE_AUTH_ISSUE_SESSION'] = 'true';
    const csrfResponse = new Response('csrf', { status: 403 });
    h.csrfCheck.mockReturnValue(csrfResponse);
    const res = await POST(makeRequest({ id_token: 'x' }));
    expect(res.status).toBe(403);
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('returns 400 when id_token is missing from body', async () => {
    process.env['FIREBASE_AUTH_ISSUE_SESSION'] = 'true';
    const res = await POST(makeRequest({}));
    expect(res.status).toBe(400);
    expect((await res.json()).error.code).toBe('INVALID_REQUEST');
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('returns 400 on invalid JSON body', async () => {
    process.env['FIREBASE_AUTH_ISSUE_SESSION'] = 'true';
    const res = await POST(makeRequest('not-json'));
    expect(res.status).toBe(400);
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('returns 401 SESSION_EXCHANGE_FAILED (not a distinguishing error) when backend mint call fails', async () => {
    process.env['FIREBASE_AUTH_ISSUE_SESSION'] = 'true';
    mockFetch.mockResolvedValue({ ok: false, status: 401, json: async () => ({}) });
    const res = await POST(makeRequest({ id_token: 'bad-token' }));
    expect(res.status).toBe(401);
    expect((await res.json()).error.code).toBe('SESSION_EXCHANGE_FAILED');
  });

  it('returns 401 SESSION_EXCHANGE_FAILED when backend network call throws', async () => {
    process.env['FIREBASE_AUTH_ISSUE_SESSION'] = 'true';
    mockFetch.mockRejectedValue(new Error('network down'));
    const res = await POST(makeRequest({ id_token: 'x' }));
    expect(res.status).toBe(401);
  });

  it('returns 401 SESSION_EXCHANGE_FAILED when backend response is malformed (no session_cookie)', async () => {
    process.env['FIREBASE_AUTH_ISSUE_SESSION'] = 'true';
    mockFetch.mockResolvedValue({ ok: true, status: 200, json: async () => ({ unexpected: 'shape' }) });
    const res = await POST(makeRequest({ id_token: 'x' }));
    expect(res.status).toBe(401);
  });

  it('on success: sets __Host-sp_fs, clears sp_at/sp_rt, never echoes cookie value in JSON body, forwards internal secret', async () => {
    process.env['FIREBASE_AUTH_ISSUE_SESSION'] = 'true';
    process.env['FIREBASE_BFF_INTERNAL_SECRET'] = 'shared-secret-value';
    mockFetch.mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ session_cookie: 'super-secret-cookie-value' }),
    });

    const res = await POST(makeRequest({ id_token: 'verified-id-token' }));
    expect(res.status).toBe(200);

    const bodyText = await res.text();
    expect(bodyText).not.toContain('super-secret-cookie-value');

    const setCookie = res.headers.get('set-cookie') ?? '';
    expect(setCookie).toContain('__Host-sp_fs=super-secret-cookie-value');
    expect(setCookie).not.toContain('Domain=');

    // sp_at/sp_rt clearing happens via separate cookies.set() calls — NextResponse only
    // exposes the last Set-Cookie via .get(), so inspect the full cookie jar instead.
    const allCookies = res.cookies.getAll();
    const spAt = allCookies.find((c) => c.name === 'sp_at');
    const spRt = allCookies.find((c) => c.name === 'sp_rt');
    expect(spAt?.value).toBe('');
    expect(spAt?.maxAge).toBe(0);
    expect(spRt?.value).toBe('');
    expect(spRt?.maxAge).toBe(0);

    // internal secret forwarded server-to-server, never leaked to client body/headers.
    const [, fetchOptions] = mockFetch.mock.calls[0] as [string, RequestInit];
    const headers = fetchOptions.headers as Record<string, string>;
    expect(headers['Authorization']).toBe('Bearer shared-secret-value');
    expect(res.headers.get('Authorization')).toBeNull();
  });
});
