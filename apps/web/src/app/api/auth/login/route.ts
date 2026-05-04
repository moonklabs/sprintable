import { NextResponse } from 'next/server';
import { SP_AT_COOKIE, SP_RT_COOKIE } from '@/lib/db/server';
import { verifyCsrfOrigin } from '@/lib/auth/csrf';
import { isOssMode } from '@/lib/storage/factory';

const FASTAPI_URL = () => process.env['NEXT_PUBLIC_FASTAPI_URL'] ?? 'http://localhost:8000';

function cookieBase() {
  const domain = process.env['NEXT_PUBLIC_COOKIE_DOMAIN'];
  return { httpOnly: true, secure: true, sameSite: 'lax' as const, path: '/', ...(domain ? { domain } : {}) };
}

/** POST /api/auth/login */
export async function POST(request: Request) {
  const csrfError = verifyCsrfOrigin(request);
  if (csrfError) return csrfError;

  const body = await request.json() as { email: string; password: string; totp_code?: string | null };

  if (isOssMode()) {
    const { getDb } = await import('@sprintable/storage-pglite');
    const { verifyPassword, signOssSession, ossSessionCookieOptions, OSS_SESSION_COOKIE } = await import('@/lib/oss-auth');
    const db = await getDb();

    if (!body.email?.trim() || !body.password) {
      return NextResponse.json({ error: { code: 'VALIDATION_ERROR', message: 'Email and password required' } }, { status: 400 });
    }

    const user = (await db.query(
      'SELECT id, email, name, password_hash FROM oss_users WHERE email = $1 LIMIT 1',
      [body.email.trim().toLowerCase()]
    )).rows[0] as { id: string; email: string; name: string; password_hash: string } | undefined;

    if (!user || !verifyPassword(body.password, user.password_hash)) {
      return NextResponse.json({ error: { code: 'AUTH_FAILED', message: 'Invalid email or password' } }, { status: 401 });
    }

    const token = await signOssSession(user.id);
    const res = NextResponse.json({ data: { ok: true } });
    res.cookies.set(OSS_SESSION_COOKIE, token, ossSessionCookieOptions());
    return res;
  }

  const fastapiRes = await fetch(`${FASTAPI_URL()}/api/v2/auth/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: body.email, password: body.password, totp_code: body.totp_code ?? null }),
  });

  const json = await fastapiRes.json() as { data?: { access_token: string; refresh_token: string; token_type: string }; error?: { code: string; message: string } };
  if (!fastapiRes.ok || !json.data) {
    return NextResponse.json({ error: json.error ?? { code: 'AUTH_FAILED', message: 'Login failed' } }, { status: fastapiRes.status });
  }

  const { access_token, refresh_token } = json.data;
  const res = NextResponse.json({ data: { ok: true } });
  res.cookies.set(SP_AT_COOKIE, access_token, { ...cookieBase(), maxAge: 15 * 60 });
  res.cookies.set(SP_RT_COOKIE, refresh_token, { ...cookieBase(), maxAge: 30 * 24 * 60 * 60 });
  return res;
}
