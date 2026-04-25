import { createSupabaseServerClient } from '@/lib/supabase/server';
import { NextResponse } from 'next/server';
import { resolveAppUrl } from '@/services/app-url';

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const code = searchParams.get('code');
  const next = searchParams.get('next');
  const origin = resolveAppUrl(null);

  if (code) {
    const supabase = await createSupabaseServerClient();
    const { error } = await supabase.auth.exchangeCodeForSession(code);
    if (error) {
      console.error('[auth/callback] exchangeCodeForSession failed:', error.message, error.status);
    }
    if (!error) {
      // MFA 검증 필요 여부 확인 (AAL1 → AAL2 required)
      const { data: aal } = await supabase.auth.mfa.getAuthenticatorAssuranceLevel();
      if (aal?.nextLevel === 'aal2' && aal?.currentLevel !== 'aal2') {
        return NextResponse.redirect(`${origin}/mfa`);
      }

      // next 파라미터가 있으면 (초대 플로우 등) 그대로 리다이렉트
      if (next) return NextResponse.redirect(`${origin}${next}`);

      // next 없으면 (직접 가입) org 소속 여부로 온보딩/대시보드 분기
      const { data: { user } } = await supabase.auth.getUser();
      if (user) {
        const { data: membership } = await supabase
          .from('org_members')
          .select('org_id')
          .eq('user_id', user.id)
          .limit(1)
          .maybeSingle();

        return NextResponse.redirect(membership ? `${origin}/dashboard` : `${origin}/onboarding`);
      }

      return NextResponse.redirect(`${origin}/dashboard`);
    }
  }

  return NextResponse.redirect(`${origin}/login?error=auth_failed`);
}
