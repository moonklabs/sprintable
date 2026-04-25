import { NextResponse } from 'next/server';
import { createSupabaseServerClient } from '@/lib/supabase/server';
import { resolveAppUrl } from '@/services/app-url';

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const code = searchParams.get('code');
  const next = searchParams.get('next');
  const origin = resolveAppUrl(null);

  if (code) {
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

    // 서버 교환 실패 시 클라이언트 fallback으로 (CloudFront 쿠키 미전달 등 환경 이슈 대비)
    const params = new URLSearchParams({ code });
    if (next) params.set('next', next);
    return NextResponse.redirect(`${origin}/auth/callback/fallback?${params.toString()}`);
  }

  return NextResponse.redirect(`${origin}/login?error=auth_failed`);
}
