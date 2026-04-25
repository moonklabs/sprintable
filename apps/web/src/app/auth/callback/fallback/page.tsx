'use client';

import { Suspense, useEffect } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { createSupabaseBrowserClient } from '@/lib/supabase/client';

function FallbackHandler() {
  const router = useRouter();
  const searchParams = useSearchParams();

  useEffect(() => {
    const next = searchParams.get('next');
    const ssrClient = createSupabaseBrowserClient();

    const { data: { subscription } } = ssrClient.auth.onAuthStateChange(async (event, session) => {
      if (event === 'SIGNED_IN' && session) {
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
      }
    });

    const timeout = setTimeout(() => router.replace('/login?error=auth_failed'), 15000);
    return () => { subscription.unsubscribe(); clearTimeout(timeout); };
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
