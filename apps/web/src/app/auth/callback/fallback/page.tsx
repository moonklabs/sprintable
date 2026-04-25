'use client';
import { Suspense, useEffect } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { createClient } from '@supabase/supabase-js';
import { createSupabaseBrowserClient } from '@/lib/supabase/client';

function FallbackHandler() {
  const router = useRouter();
  const searchParams = useSearchParams();

  useEffect(() => {
    const code = new URLSearchParams(window.location.search).get('code');
    const next = searchParams.get('next');

    if (!code) {
      router.replace('/login?error=auth_failed');
      return;
    }

    // 디버그
    const cvKey = Object.keys(localStorage).find(k => k.includes('code-verifier'));
    console.error('[v10] code_verifier present:', !!cvKey, 'value:', cvKey ? localStorage.getItem(cvKey)?.slice(0, 8) : 'MISSING');

    // 구 세션 제거 — _initialize()의 _recoverAndRefresh가 _saveSession을 호출해서 code-verifier를 삭제하는 것을 방지
    const supabaseRef = (process.env.NEXT_PUBLIC_SUPABASE_URL || '').split('//')[1]?.split('.')[0] || '';
    if (supabaseRef) {
      localStorage.removeItem(`sb-${supabaseRef}-auth-token`);
    }

    const pkceClient = createClient(
      process.env.NEXT_PUBLIC_SUPABASE_URL!,
      process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
      { auth: { flowType: 'pkce', detectSessionInUrl: false } },
    );

    pkceClient.auth.exchangeCodeForSession(code).then(async ({ data, error }) => {
      if (error || !data.session) {
        console.error('[v10] exchange failed:', error?.message);
        router.replace('/login?error=auth_failed');
        return;
      }

      const session = data.session;
      const ssrClient = createSupabaseBrowserClient();
      const { error: setError } = await ssrClient.auth.setSession({
        access_token: session.access_token,
        refresh_token: session.refresh_token,
      });
      if (setError) {
        console.error('[v10] setSession failed:', setError.message);
        router.replace('/login?error=auth_failed');
        return;
      }

      const { data: aal } = await ssrClient.auth.mfa.getAuthenticatorAssuranceLevel();
      if (aal?.nextLevel === 'aal2' && aal?.currentLevel !== 'aal2') { router.replace('/mfa'); return; }
      if (next) { router.replace(next); return; }
      const { data: { user } } = await ssrClient.auth.getUser();
      if (user) {
        const { data: membership } = await ssrClient.from('org_members').select('org_id').eq('user_id', user.id).limit(1).maybeSingle();
        router.replace(membership ? '/dashboard' : '/onboarding');
        return;
      }
      router.replace('/dashboard');
    });

    const timeout = setTimeout(() => router.replace('/login?error=auth_failed'), 15000);
    return () => clearTimeout(timeout);
  }, [router, searchParams]);

  return (
    <div className="flex min-h-screen items-center justify-center bg-gray-50">
      <p className="text-sm text-gray-500">로그인 처리 중...</p>
    </div>
  );
}

export default function AuthCallbackFallbackPage() {
  return (
    <Suspense fallback={<div className="flex min-h-screen items-center justify-center bg-gray-50"><p className="text-sm text-gray-500">로그인 처리 중...</p></div>}>
      <FallbackHandler />
    </Suspense>
  );
}
