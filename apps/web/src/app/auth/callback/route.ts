import { NextResponse } from 'next/server';
import { cookies } from 'next/headers';
import { createSupabaseServerClient } from '@/lib/supabase/server';
import { resolveAppUrl } from '@/services/app-url';

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const code = searchParams.get('code');
  const next = searchParams.get('next');
  const origin = resolveAppUrl(null);

  if (code) {
    const fallbackParams = new URLSearchParams({ code });
    if (next) fallbackParams.set('next', next);
    const fallbackUrl = `${origin}/auth/callback/fallback?${fallbackParams.toString()}`;

    // code_verifier 쿠키 없으면 서버 교환 skip — OAuth code는 일회용이라
    // 서버 교환이 실패하면 code가 소비되어 fallback에서 재사용 불가
    const cookieStore = await cookies();
    const hasCodeVerifier = cookieStore.getAll().some(c => c.name.includes('code-verifier'));
    if (!hasCodeVerifier) {
      return NextResponse.redirect(fallbackUrl);
    }

    const supabase = await createSupabaseServerClient();
    const { error } = await supabase.auth.exchangeCodeForSession(code);

    if (!error) {
      const { data: aal } = await supabase.auth.mfa.getAuthenticatorAssuranceLevel();
      if (aal?.nextLevel === 'aal2' && aal?.currentLevel !== 'aal2') {
        return NextResponse.redirect(`${origin}/mfa`);
      }

      if (next) {
        return NextResponse.redirect(`${origin}${next}`);
      }

      const { data: { user } } = await supabase.auth.getUser();
      if (user) {
        const { data: membership } = await supabase
          .from('org_members')
          .select('org_id')
          .eq('user_id', user.id)
          .limit(1)
          .maybeSingle();
        return NextResponse.redirect(`${origin}${membership ? '/dashboard' : '/onboarding'}`);
      }

      return NextResponse.redirect(`${origin}/dashboard`);
    }

    // 서버 교환 실패 → 클라이언트 fallback에서 브라우저 쿠키로 재시도
    return NextResponse.redirect(fallbackUrl);
  }

  return NextResponse.redirect(`${origin}/login?error=auth_failed`);
}
