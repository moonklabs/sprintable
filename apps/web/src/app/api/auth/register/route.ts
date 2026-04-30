import { NextResponse } from 'next/server';
import { SP_AT_COOKIE, SP_RT_COOKIE } from '@/lib/supabase/server';

const FASTAPI_URL = () => process.env['NEXT_PUBLIC_FASTAPI_URL'] ?? 'http://localhost:8000';

function cookieBase() {
  const domain = process.env['NEXT_PUBLIC_COOKIE_DOMAIN'];
  return {
    httpOnly: true,
    secure: true,
    sameSite: 'lax' as const,
    path: '/',
    ...(domain ? { domain } : {}),
  };
}

/** POST /api/auth/register — 회원가입 → JWT 쿠키 설정 */
export async function POST(request: Request) {
  const body = await request.json() as { email: string; password: string };

  const fastapiRes = await fetch(`${FASTAPI_URL()}/api/v2/auth/register`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: body.email, password: body.password }),
  });

  const json = await fastapiRes.json() as { data?: { access_token: string; refresh_token: string; token_type: string }; error?: { code: string; message: string } };

  if (!fastapiRes.ok || !json.data) {
    return NextResponse.json({ error: json.error ?? { code: 'REGISTER_FAILED', message: 'Registration failed' } }, { status: fastapiRes.status });
  }

  const { access_token, refresh_token } = json.data;
  const res = NextResponse.json({ data: { ok: true } }, { status: 201 });
  res.cookies.set(SP_AT_COOKIE, access_token, { ...cookieBase(), maxAge: 15 * 60 });
  res.cookies.set(SP_RT_COOKIE, refresh_token, { ...cookieBase(), maxAge: 30 * 24 * 60 * 60 });
  return res;
}
