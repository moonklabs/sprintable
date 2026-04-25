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

    // code_verifier 쿠키 없으면 서버 교환 skip.
    // exchangeCodeForSession 내부가 code_verifier 유무와 무관하게 removeItem을 호출하여
    // 삭제 Set-Cookie 헤더를 반환하고, 이로 인해 브라우저의 code_verifier 쿠키가 소거됨.
    // 서버에 쿠키가 없으면 바로 fallback으로 이동 → 브라우저 쿠키 보존 → fallback 교환 성공.
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

    // 서버 교환 실패 시 클라이언트 fallback으로
    return NextResponse.redirect(fallbackUrl);
  }

  return NextResponse.redirect(`${origin}/login?error=auth_failed`);
}
