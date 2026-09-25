import { NextResponse } from 'next/server';
import { cookies } from 'next/headers';
import { SP_AT_COOKIE, SP_RT_COOKIE } from '@/lib/db/server';
import { verifyCsrfOrigin } from '@/lib/auth/csrf';
import { cookieBase } from '@/lib/auth/cookies';
import { backendSignal } from '@/lib/backend-signal';

const FASTAPI_URL = () => process.env['NEXT_PUBLIC_FASTAPI_URL'] ?? 'http://localhost:8000';

/** POST /api/auth/logout */
export async function POST(request: Request) {
  const csrfError = verifyCsrfOrigin(request);
  if (csrfError) return csrfError;

  const cookieStore = await cookies();
  const refreshToken = cookieStore.get(SP_RT_COOKIE)?.value ?? '';

  if (refreshToken) {
    await fetch(`${FASTAPI_URL()}/api/v2/auth/logout`, {
      // story #4320 — 로그아웃 무효화 — 브라우저가 떠나도 끝까지. 시간 제한만.
      signal: backendSignal(null),
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ refresh_token: refreshToken }),
    }).catch(() => { /* ignore network errors on logout */ });
  }

  const base = { ...cookieBase(), maxAge: 0 };
  const res = NextResponse.json({ data: { ok: true } });
  res.cookies.set(SP_AT_COOKIE, '', base);
  res.cookies.set(SP_RT_COOKIE, '', base);
  return res;
}
