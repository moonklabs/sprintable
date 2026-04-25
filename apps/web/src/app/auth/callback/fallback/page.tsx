'use client';

import { Suspense, useEffect, useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { createSupabaseBrowserClient } from '@/lib/supabase/client';

function FallbackHandler() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const [status, setStatus] = useState('로그인 처리 중...');

  useEffect(() => {
    const code = searchParams.get('code');
    const next = searchParams.get('next');
    if (!code) { router.replace('/login?error=no_code'); return; }

    const supabase = createSupabaseBrowserClient();

    (async () => {
      const { error } = await supabase.auth.exchangeCodeForSession(code);
      if (error) {
        setStatus('인증 실패. 다시 시도해주세요.');
        setTimeout(() => router.replace('/login?error=auth_failed'), 2000);
        return;
      }

      const { data: aal } = await supabase.auth.mfa.getAuthenticatorAssuranceLevel();
      if (aal?.nextLevel === 'aal2' && aal?.currentLevel !== 'aal2') {
        router.replace('/mfa'); return;
      }
      if (next) { router.replace(next); return; }

      const { data: { user } } = await supabase.auth.getUser();
      if (user) {
        const { data: membership } = await supabase
          .from('org_members').select('org_id')
          .eq('user_id', user.id).limit(1).maybeSingle();
        router.replace(membership ? '/dashboard' : '/onboarding');
        return;
      }
      router.replace('/dashboard');
    })();
  }, [router, searchParams]);

  return (
    <div className="flex min-h-screen items-center justify-center bg-gray-50">
      <p className="text-sm text-gray-500">{status}</p>
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
