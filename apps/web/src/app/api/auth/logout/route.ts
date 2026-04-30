import { NextResponse } from 'next/server';
import { cookies } from 'next/headers';
import { SP_AT_COOKIE, SP_RT_COOKIE } from '@/lib/supabase/server';

const FASTAPI_URL = () => process.env['NEXT_PUBLIC_FASTAPI_URL'] ?? 'http://localhost:8000';

/** POST /api/auth/logout — refresh token 무효화 + 쿠키 삭제 */
export async function POST() {
  const cookieStore = await cookies();
  const refreshToken = cookieStore.get(SP_RT_COOKIE)?.value ?? '';

  // Best-effort FastAPI revocation
  if (refreshToken) {
    await fetch(`${FASTAPI_URL()}/api/v2/auth/logout`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ refresh_token: refreshToken }),
    }).catch(() => { /* ignore network errors on logout */ });
  }

  const cookieClearBase = { httpOnly: true, secure: true, sameSite: 'lax' as const, path: '/', maxAge: 0 };
  const domain = process.env['NEXT_PUBLIC_COOKIE_DOMAIN'];
  const base = domain ? { ...cookieClearBase, domain } : cookieClearBase;

  const res = NextResponse.json({ data: { ok: true } });
  res.cookies.set(SP_AT_COOKIE, '', base);
  res.cookies.set(SP_RT_COOKIE, '', base);
  return res;
}
