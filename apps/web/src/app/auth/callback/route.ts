import { NextResponse } from 'next/server';
import { resolveAppUrl } from '@/services/app-url';

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const code = searchParams.get('code');
  const next = searchParams.get('next');
  const origin = resolveAppUrl(null);

  if (code) {
    const params = new URLSearchParams({ code });
    if (next) params.set('next', next);
    return NextResponse.redirect(`${origin}/auth/callback/fallback?${params.toString()}`);
  }

  return NextResponse.redirect(`${origin}/login?error=auth_failed`);
}
