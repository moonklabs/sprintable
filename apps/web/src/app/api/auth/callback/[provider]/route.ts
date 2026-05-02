import { NextResponse } from 'next/server';
import { cookies } from 'next/headers';
import { SP_AT_COOKIE, SP_RT_COOKIE } from '@/lib/db/server';
import { resolveAppUrl } from '@/services/app-url';

const FASTAPI_URL = () => process.env['NEXT_PUBLIC_FASTAPI_URL'] ?? 'http://localhost:8000';

function cookieBase() {
  const domain = process.env['NEXT_PUBLIC_COOKIE_DOMAIN'];
  return { httpOnly: true, secure: process.env.NODE_ENV === 'production', sameSite: 'lax' as const, path: '/', ...(domain ? { domain } : {}) };
}

type RouteParams = { params: Promise<{ provider: string }> };

export async function GET(request: Request, { params }: RouteParams) {
  const { provider } = await params;
  const { searchParams } = new URL(request.url);
  const code = searchParams.get('code');
  const state = searchParams.get('state');
  const origin = resolveAppUrl(null);

  if (!['google', 'github'].includes(provider)) {
    return NextResponse.redirect(`${origin}/login?error=invalid_provider`);
  }

  if (!code || !state) {
    return NextResponse.redirect(`${origin}/login?error=oauth_missing_params`);
  }

  // CSRF state 검증
  const cookieStore = await cookies();
  const storedState = cookieStore.get(`oauth_state_${provider}`)?.value;
  cookieStore.delete(`oauth_state_${provider}`);

  if (!storedState || storedState !== state) {
    return NextResponse.redirect(`${origin}/login?error=csrf_mismatch`);
  }

  // FastAPI OAuth callback
  const fastapiRes = await fetch(`${FASTAPI_URL()}/api/v2/auth/oauth/callback`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ provider, code, state }),
  }).catch(() => null);

  if (!fastapiRes?.ok) {
    const errBody = await fastapiRes?.json().catch(() => null) as { error?: { code?: string } } | null;
    const errCode = errBody?.error?.code ?? 'oauth_failed';
    return NextResponse.redirect(`${origin}/login?error=${errCode}`);
  }

  const json = await fastapiRes.json() as { data?: { access_token: string; refresh_token: string } };
  const { access_token, refresh_token } = json.data ?? {};

  if (!access_token || !refresh_token) {
    return NextResponse.redirect(`${origin}/login?error=oauth_no_token`);
  }

  const res = NextResponse.redirect(`${origin}/inbox`);
  res.cookies.set(SP_AT_COOKIE, access_token, { ...cookieBase(), maxAge: 15 * 60 });
  res.cookies.set(SP_RT_COOKIE, refresh_token, { ...cookieBase(), maxAge: 30 * 24 * 60 * 60 });
  return res;
}
