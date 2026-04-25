'use client';

import { Suspense, useEffect, useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { createSupabaseBrowserClient } from '@/lib/supabase/client';

function FallbackHandler() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const [debugInfo, setDebugInfo] = useState<string[]>(['초기화 중...']);

  useEffect(() => {
    const logs: string[] = [];
    const log = (msg: string) => {
      logs.push(`[${new Date().toISOString().slice(11,19)}] ${msg}`);
      setDebugInfo([...logs]);
    };

    const code = searchParams.get('code');
    const next = searchParams.get('next');
    log(`code: ${code ? code.slice(0, 8) + '...' : 'null'}`);
    log(`next: ${next || 'null'}`);

    // 1. document.cookie 중 sb-* 확인
    const allCookies = document.cookie.split(';').map(c => c.trim());
    const sbCookies = allCookies.filter(c => c.startsWith('sb-'));
    log(`sb-* cookies (${sbCookies.length}): ${sbCookies.map(c => c.split('=')[0]).join(', ') || 'NONE'}`);

    const cvCookies = allCookies.filter(c => c.includes('code-verifier'));
    log(`code-verifier cookies: ${cvCookies.length > 0 ? cvCookies.map(c => c.split('=')[0]).join(', ') : 'NONE'}`);

    // 2. localStorage 중 sb-* 확인
    const lsKeys = Object.keys(localStorage).filter(k => k.startsWith('sb-'));
    log(`sb-* localStorage (${lsKeys.length}): ${lsKeys.join(', ') || 'NONE'}`);

    const cvLS = lsKeys.filter(k => k.includes('code-verifier'));
    log(`code-verifier localStorage: ${cvLS.length > 0 ? cvLS.map(k => `${k}=${localStorage.getItem(k)?.slice(0,20)}...`).join(', ') : 'NONE'}`);

    // 3. Supabase client 생성 + onAuthStateChange
    log('createSupabaseBrowserClient() 호출...');
    const supabase = createSupabaseBrowserClient();
    log('client 생성 완료');

    const { data: { subscription } } = supabase.auth.onAuthStateChange(
      async (event, session) => {
        log(`onAuthStateChange: event=${event}, session=${session ? 'YES' : 'null'}`);

        if (event === 'SIGNED_IN' && session) {
          log('SIGNED_IN 수신 — redirect 진행');
          const { data: aal } = await supabase.auth.mfa.getAuthenticatorAssuranceLevel();
          if (aal?.nextLevel === 'aal2' && aal?.currentLevel !== 'aal2') {
            router.replace('/mfa');
            return;
          }
          if (next) { router.replace(next); return; }
          const { data: { user } } = await supabase.auth.getUser();
          if (user) {
            const { data: membership } = await supabase
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

        if (event === 'INITIAL_SESSION' && session) {
          log('INITIAL_SESSION with session — 이미 로그인됨, redirect 진행');
          if (next) { router.replace(next); return; }
          const { data: { user } } = await supabase.auth.getUser();
          if (user) {
            const { data: membership } = await supabase
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

        if (event === 'INITIAL_SESSION' && !session) {
          log('INITIAL_SESSION with NO session — auto-init 교환 실패 또는 code-verifier 없음');
        }
      }
    );

    // 4. post-init 쿠키 재확인 (3초 후)
    setTimeout(() => {
      const postCookies = document.cookie.split(';').map(c => c.trim()).filter(c => c.startsWith('sb-'));
      log(`[3초 후] sb-* cookies: ${postCookies.map(c => c.split('=')[0]).join(', ') || 'NONE'}`);
    }, 3000);

    const timeout = setTimeout(() => {
      log('15초 timeout — auth_failed redirect');
      router.replace('/login?error=auth_failed');
    }, 15000);

    return () => {
      subscription.unsubscribe();
      clearTimeout(timeout);
    };
  }, [router, searchParams]);

  return (
    <div className="flex min-h-screen flex-col items-center justify-center bg-gray-50 p-4">
      <p className="text-sm text-gray-500 mb-4">로그인 처리 중...</p>
      <div className="w-full max-w-lg bg-white border rounded p-3 text-xs font-mono text-gray-700 whitespace-pre-wrap">
        {debugInfo.map((line, i) => (
          <div key={i}>{line}</div>
        ))}
      </div>
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
