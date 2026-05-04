import { NextResponse } from 'next/server';
import { cookies } from 'next/headers';
import { SP_AT_COOKIE, SP_RT_COOKIE } from '@/lib/db/server';
import { verifyCsrfOrigin } from '@/lib/auth/csrf';
;

const FASTAPI_URL = () => process.env['NEXT_PUBLIC_FASTAPI_URL'] ?? 'http://localhost:8000';

/** POST /api/auth/logout */
export async function POST(request: Request) {
  const csrfError = verifyCsrfOrigin(request);
  if (csrfError) return csrfError;

  const cookieStore = await cookies();
  const refreshToken = cookieStore.get(SP_RT_COOKIE)?.value ?? '';

  if (refreshToken) {
    await fetch(`${FASTAPI_URL()}/api/v2/auth/logout`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ refresh_token: refreshToken }),
    }).catch(() => { /* ignore network errors on logout */ });
  }

  const domain = process.env['NEXT_PUBLIC_COOKIE_DOMAIN'];
  const base = { httpOnly: true, secure: true, sameSite: 'lax' as const, path: '/', maxAge: 0, ...(domain ? { domain } : {}) };
  const res = NextResponse.json({ data: { ok: true } });
  res.cookies.set(SP_AT_COOKIE, '', base);
  res.cookies.set(SP_RT_COOKIE, '', base);
  return res;
}
