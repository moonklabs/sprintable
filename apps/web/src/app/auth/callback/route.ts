import { NextResponse } from 'next/server';
import { cookies } from 'next/headers';
import { createSupabaseServerClient } from '@/lib/supabase/server';
import { resolveAppUrl } from '@/services/app-url';

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const code = searchParams.get('code');
  const next = searchParams.get('next');
  const origin = resolveAppUrl(null);

  if (!code) {
    return NextResponse.redirect(`${origin}/login?error=no_code`);
  }

  // EC-1: validate code_verifier arrives via Set-Cookie path (remove after first prod confirmation)
  const cookieStore = await cookies();
  const hasCodeVerifier = cookieStore.getAll().some(c => c.name.includes('code-verifier'));
  console.log('[auth-cb] cv present:', hasCodeVerifier);

  const supabase = await createSupabaseServerClient();
  const { error } = await supabase.auth.exchangeCodeForSession(code);

  if (error) {
    return NextResponse.redirect(`${origin}/login?error=auth_failed`);
  }

  const { data: aal } = await supabase.auth.mfa.getAuthenticatorAssuranceLevel();
  if (aal?.nextLevel === 'aal2' && aal?.currentLevel !== 'aal2') {
    const res = NextResponse.redirect(`${origin}/mfa`);
    res.headers.set('Cache-Control', 'no-store');
    return res;
  }

  let redirectTarget = `${origin}/dashboard`;
  if (next) {
    redirectTarget = `${origin}${next}`;
  } else {
    const { data: { user } } = await supabase.auth.getUser();
    if (user) {
      const { data: membership } = await supabase
        .from('org_members')
        .select('org_id')
        .eq('user_id', user.id)
        .limit(1)
        .maybeSingle();
      redirectTarget = `${origin}${membership ? '/dashboard' : '/onboarding'}`;
    }
  }

  const res = NextResponse.redirect(redirectTarget);
  res.headers.set('Cache-Control', 'no-store');
  return res;
}
