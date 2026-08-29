import { NextResponse } from 'next/server';
import { cookies } from 'next/headers';
import { SP_AT_COOKIE, SP_RT_COOKIE } from '@/lib/db/server';
import { verifyCsrfOrigin } from '@/lib/auth/csrf';
import { cookieBase, SP_AT_MAX_AGE_SECONDS } from '@/lib/auth/cookies';

const FASTAPI_URL = () => process.env['NEXT_PUBLIC_FASTAPI_URL'] ?? 'http://localhost:8000';

/** POST /api/auth/register */
export async function POST(request: Request) {
  const csrfError = verifyCsrfOrigin(request);
  if (csrfError) return csrfError;

  const body = await request.json() as { email: string; password: string; display_name?: string; tos_accepted?: boolean; invite_token?: string };

  // story #3204 — proxy.ts가 랜딩 시점에 심어둔 first-touch 귀속 쿠키를 그대로 BE로 relay.
  const cookieStore = await cookies();
  const utmSource = cookieStore.get('sp_attr_src')?.value;
  const utmMedium = cookieStore.get('sp_attr_medium')?.value;
  const utmCampaign = cookieStore.get('sp_attr_campaign')?.value;
  const referrer = cookieStore.get('sp_attr_ref')?.value;

  const fastapiRes = await fetch(`${FASTAPI_URL()}/api/v2/auth/register`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      email: body.email,
      password: body.password,
      display_name: body.display_name ?? body.email.split('@')[0],
      tos_accepted: body.tos_accepted ?? false,
      ...(body.invite_token ? { invite_token: body.invite_token } : {}),
      ...(utmSource ? { signup_utm_source: utmSource } : {}),
      ...(utmMedium ? { signup_utm_medium: utmMedium } : {}),
      ...(utmCampaign ? { signup_utm_campaign: utmCampaign } : {}),
      ...(referrer ? { signup_referrer: referrer } : {}),
    }),
  });

  const json = await fastapiRes.json() as { data?: { access_token: string; refresh_token: string; token_type: string }; error?: { code: string; message: string } };
  if (!fastapiRes.ok || !json.data) {
    return NextResponse.json({ error: json.error ?? { code: 'REGISTER_FAILED', message: 'Registration failed' } }, { status: fastapiRes.status });
  }

  const { access_token, refresh_token } = json.data;
  const res = NextResponse.json({ data: { ok: true } }, { status: 201 });
  res.cookies.set(SP_AT_COOKIE, access_token, { ...cookieBase(), maxAge: SP_AT_MAX_AGE_SECONDS });
  res.cookies.set(SP_RT_COOKIE, refresh_token, { ...cookieBase(), maxAge: 30 * 24 * 60 * 60 });
  return res;
}
