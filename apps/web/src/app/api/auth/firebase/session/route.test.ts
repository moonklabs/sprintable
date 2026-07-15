import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({ csrfCheck: vi.fn() }));
vi.mock('@/lib/auth/csrf', () => ({ verifyCsrfOrigin: h.csrfCheck }));

import { NextResponse } from 'next/server';
import { POST, setFirebaseSessionCookie } from './route';

function makeRequest(): Request {
  return new Request('http://localhost/api/auth/firebase/session', { method: 'POST', body: '{}' });
}

describe('POST /api/auth/firebase/session', () => {
  beforeEach(() => {
    h.csrfCheck.mockReset().mockReturnValue(null);
    delete process.env['FIREBASE_AUTH_ISSUE_SESSION'];
  });

  afterEach(() => {
    delete process.env['FIREBASE_AUTH_ISSUE_SESSION'];
  });

  it('returns 501 when FIREBASE_AUTH_ISSUE_SESSION is unset (default off)', async () => {
    const res = await POST(makeRequest());
    expect(res.status).toBe(501);
    expect((await res.json()).error.code).toBe('NOT_ENABLED');
  });

  it('returns 501 when FIREBASE_AUTH_ISSUE_SESSION is explicitly false', async () => {
    process.env['FIREBASE_AUTH_ISSUE_SESSION'] = 'false';
    const res = await POST(makeRequest());
    expect(res.status).toBe(501);
  });

  it('still 501(not-implemented) even when flag is true — scaffold only, no live exchange yet', async () => {
    process.env['FIREBASE_AUTH_ISSUE_SESSION'] = 'true';
    const res = await POST(makeRequest());
    expect(res.status).toBe(501);
    expect((await res.json()).error.code).toBe('NOT_IMPLEMENTED');
  });
});

describe('setFirebaseSessionCookie — __Host-sp_fs domain-less regression guard (story e5225c0a 3차 근본 재발 방지)', () => {
  it('sets the cookie WITHOUT a Domain attribute even when NEXT_PUBLIC_COOKIE_DOMAIN is configured', () => {
    process.env['NEXT_PUBLIC_APP_URL'] = 'https://app.sprintable.ai';
    process.env['NEXT_PUBLIC_COOKIE_DOMAIN'] = 'app.sprintable.ai';
    try {
      const response = NextResponse.json({ data: { ok: true } });
      setFirebaseSessionCookie(response, 'fake-session-cookie-value');
      const setCookie = response.headers.get('set-cookie') ?? '';
      expect(setCookie).toContain('__Host-sp_fs=fake-session-cookie-value');
      expect(setCookie).not.toContain('Domain=');
      expect(setCookie).toContain('Path=/');
      expect(setCookie).toContain('HttpOnly');
    } finally {
      delete process.env['NEXT_PUBLIC_APP_URL'];
      delete process.env['NEXT_PUBLIC_COOKIE_DOMAIN'];
    }
  });
});
