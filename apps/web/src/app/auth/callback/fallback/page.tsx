'use client';

import { Suspense, useEffect, useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { createSupabaseBrowserClient } from '@/lib/supabase/client';

function FallbackHandler() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const [debug, setDebug] = useState<string[]>([]);

  useEffect(() => {
    const log = (msg: string) => setDebug(prev => [...prev, `[${new Date().toISOString().slice(11,19)}] ${msg}`]);

    const code = searchParams.get('code');
    const next = searchParams.get('next');

    log(`URL code: ${code?.slice(0, 12) || 'MISSING'}`);
    log(`URL next: ${next || 'null'}`);
    log(`cookies: ${document.cookie || 'EMPTY'}`);

    const ssrClient = createSupabaseBrowserClient();

    if (code) {
      ssrClient.auth.exchangeCodeForSession(code).then(({ data, error }) => {
        if (error) {
          log(`exchange FAIL: ${JSON.stringify(error)}`);
        } else {
          log(`exchange OK: ${data.session?.user?.email || 'no email'}`);
        }
      });
    } else {
      log('exchange SKIP: no code');
    }

    const { data: { subscription } } = ssrClient.auth.onAuthStateChange(async (event, session) => {
      log(`auth event: ${event} session: ${session ? 'YES' : 'null'}`);
      if (event === 'SIGNED_IN' && session) {
        log('SIGNED_IN → redirecting...');
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

    const timeout = setTimeout(() => {
      log('TIMEOUT 30s → auth_failed');
      router.replace('/login?error=auth_failed');
    }, 30000);

    return () => { subscription.unsubscribe(); clearTimeout(timeout); };
  }, [router, searchParams]);

  return (
    <div className="flex min-h-screen flex-col items-center justify-start bg-gray-50 p-4 pt-16">
      <p className="text-sm text-gray-500 mb-4">로그인 처리 중...</p>
      <pre className="w-full max-w-lg bg-white border rounded p-2 text-[10px] text-gray-700 whitespace-pre-wrap break-all">
        {debug.join('\n') || '...'}
      </pre>
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
