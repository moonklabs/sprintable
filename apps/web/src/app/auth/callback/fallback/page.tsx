'use client';

import { Suspense, useEffect } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { createClient } from '@supabase/supabase-js';
import { createSupabaseBrowserClient } from '@/lib/supabase/client';

function FallbackHandler() {
  const router = useRouter();
  const searchParams = useSearchParams();

  useEffect(() => {
    const next = searchParams.get('next');

    // vanilla client — localStorage 기반, signInWithOAuth가 저장한 code-verifier를 여기서 읽음
    const pkceClient = createClient(
      process.env.NEXT_PUBLIC_SUPABASE_URL!,
      process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
      { auth: { flowType: 'pkce', detectSessionInUrl: true } },
    );

    const { data: { subscription } } = pkceClient.auth.onAuthStateChange(
      async (event, session) => {
        if (event === 'SIGNED_IN' && session) {
          // SSR client(cookie)에 세션 bridge — 이후 서버 사이드 인증 유지
          const ssrClient = createSupabaseBrowserClient();
          await ssrClient.auth.setSession({
            access_token: session.access_token,
            refresh_token: session.refresh_token,
          });

          const { data: aal } = await ssrClient.auth.mfa.getAuthenticatorAssuranceLevel();
          if (aal?.nextLevel === 'aal2' && aal?.currentLevel !== 'aal2') {
            router.replace('/mfa');
            return;
          }
          if (next) { router.replace(next); return; }
          const { data: { user } } = await ssrClient.auth.getUser();
          if (user) {
            const { data: membership } = await ssrClient
              .from('org_members')
              .select('org_id')
              .eq('user_id', user.id)
              .limit(1)
              .maybeSingle();
            router.replace(membership ? '/dashboard' : '/onboarding');
            return;
          }
          router.replace('/dashboard');
        }
      }
    );

    const timeout = setTimeout(() => {
      router.replace('/login?error=auth_failed');
    }, 15000);

    return () => {
      subscription.unsubscribe();
      clearTimeout(timeout);
    };
  }, [router, searchParams]);

  return (
    <div className="flex min-h-screen items-center justify-center bg-gray-50">
      <p className="text-sm text-gray-500">로그인 처리 중...</p>
    </div>
  );
}

export default function AuthCallbackFallbackPage() {
  return (
    <Suspense fallback={
      <div className="flex min-h-screen items-center justify-center bg-gray-50">
        <p className="text-sm text-gray-500">로그인 처리 중...</p>
      </div>
    }>
      <FallbackHandler />
    </Suspense>
  );
}
