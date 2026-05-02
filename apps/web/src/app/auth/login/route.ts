import { NextResponse } from 'next/server';
import { cookies } from 'next/headers';
import { resolveAppUrl } from '@/services/app-url';

const FASTAPI_BASE = process.env.NEXT_PUBLIC_FASTAPI_URL ?? 'http://localhost:8000';

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const provider = searchParams.get('provider');
  const origin = resolveAppUrl(null);

  if (!provider || !['google', 'github'].includes(provider)) {
    return NextResponse.redirect(`${origin}/login`);
  }

  const res = await fetch(`${FASTAPI_BASE}/api/v2/auth/oauth/${provider}/authorize`).catch(() => null);
  if (!res?.ok) {
    return NextResponse.redirect(`${origin}/login?error=oauth_init_failed`);
  }

  const json = await res.json() as { data?: { url?: string; state?: string } };
  const url = json.data?.url;
  const state = json.data?.state;

  if (!url || !state) {
    return NextResponse.redirect(`${origin}/login?error=oauth_init_failed`);
  }

  const cookieStore = await cookies();
  cookieStore.set(`oauth_state_${provider}`, state, {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'lax',
    maxAge: 300,
    path: '/',
  });

  return NextResponse.redirect(url);
}
