import { NextResponse } from 'next/server';
import { cookies } from 'next/headers';
import { createSupabaseServerClient } from '@/lib/supabase/server';
import { resolveAppUrl } from '@/services/app-url';

const DIAG_COOKIE = 'sp-auth-path';
const DIAG_MAX_AGE = 300;

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const code = searchParams.get('code');
  const next = searchParams.get('next');
  const origin = resolveAppUrl(null);

  if (code) {
    const cookieStore = await cookies();
    const hasCodeVerifier = cookieStore.getAll().some(c => c.name.includes('code-verifier'));

    const fallbackParams = new URLSearchParams({ auth_code: code });
    if (next) fallbackParams.set('next', next);
    fallbackParams.set('server_cv', hasCodeVerifier ? '1' : '0');
    const fallbackUrl = `${origin}/auth/callback/fallback?${fallbackParams.toString()}`;

    if (!hasCodeVerifier) {
      const res = NextResponse.redirect(fallbackUrl);
      res.cookies.set(DIAG_COOKIE, 'fallback-no-cv', { path: '/', maxAge: DIAG_MAX_AGE });
      return res;
    }

    const supabase = await createSupabaseServerClient();
    const { error } = await supabase.auth.exchangeCodeForSession(code);

    if (!error) {
      const { data: aal } = await supabase.auth.mfa.getAuthenticatorAssuranceLevel();
      if (aal?.nextLevel === 'aal2' && aal?.currentLevel !== 'aal2') {
        const res = NextResponse.redirect(`${origin}/mfa`);
        res.cookies.set(DIAG_COOKIE, 'server-ok-mfa', { path: '/', maxAge: DIAG_MAX_AGE });
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
      res.cookies.set(DIAG_COOKIE, 'server-ok', { path: '/', maxAge: DIAG_MAX_AGE });
      return res;
    }

    const res = NextResponse.redirect(fallbackUrl);
    res.cookies.set(DIAG_COOKIE, 'server-fail', { path: '/', maxAge: DIAG_MAX_AGE });
    return res;
  }

  return NextResponse.redirect(`${origin}/login?error=auth_failed`);
}
