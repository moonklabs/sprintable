import { NextResponse } from 'next/server';
import { createSupabaseServerClient } from '@/lib/supabase/server';
import { resolveAppUrl } from '@/services/app-url';

const ALLOWED_PROVIDERS = ['google', 'github'] as const;
type Provider = typeof ALLOWED_PROVIDERS[number];

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const provider = searchParams.get('provider') as Provider | null;
  const returnTo = searchParams.get('returnTo');
  const origin = resolveAppUrl(null);

  if (!provider || !ALLOWED_PROVIDERS.includes(provider)) {
    return NextResponse.redirect(`${origin}/login?error=invalid_provider`);
  }

  const supabase = await createSupabaseServerClient();
  await supabase.auth.signOut();

  const redirectTo = returnTo && returnTo.startsWith('/')
    ? `${origin}/auth/callback?next=${encodeURIComponent(returnTo)}`
    : `${origin}/auth/callback`;

  const { data, error } = await supabase.auth.signInWithOAuth({
    provider,
    options: { redirectTo, skipBrowserRedirect: true },
  });

  if (error || !data.url) {
    return NextResponse.redirect(`${origin}/login?error=oauth_init_failed`);
  }

  return NextResponse.redirect(data.url);
}
