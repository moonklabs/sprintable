'use client';

import { Suspense, useState, useEffect } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { createSupabaseBrowserClient } from '@/lib/supabase/client';

function FallbackHandler() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const [debug, setDebug] = useState('starting...');

  useEffect(() => {
    const code = new URLSearchParams(window.location.search).get('code');
    const next = searchParams.get('next');

    // Step 1: Supabase 클라이언트 생성 전 localStorage 직접 읽기 — _initialize() 우회
    const cvKey = Object.keys(localStorage).find(k => k.includes('code-verifier'));
    const cvRaw = cvKey ? localStorage.getItem(cvKey) : null;
    const codeVerifier = cvRaw?.split('/')[0] ?? null; // "verifier/redirectType" 형식

    setDebug(`code=${code?.slice(0,8)||'MISSING'} cv=${codeVerifier?.slice(0,8)||'MISSING'}`);

    if (!code || !codeVerifier) {
      setDebug(`FAIL: code=${!!code} cv=${!!codeVerifier}`);
      setTimeout(() => router.replace('/login?error=auth_failed'), 3000);
      return;
    }

    // Step 2: REST API 직접 호출 — Supabase 클라이언트 _initialize() 완전 우회
    fetch(`${process.env.NEXT_PUBLIC_SUPABASE_URL}/auth/v1/token?grant_type=pkce`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'apikey': process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
      },
      body: JSON.stringify({ auth_code: code, code_verifier: codeVerifier }),
    }).then(async (res) => {
      const data = await res.json();
      setDebug(`exchange ${res.ok ? 'OK' : 'FAIL'}: ${res.ok ? 'got session' : JSON.stringify(data).slice(0, 80)}`);

      if (!res.ok || !data.access_token) {
        setTimeout(() => router.replace('/login?error=auth_failed'), 3000);
        return;
      }

      // Step 3: SSR cookie client에 세션 bridge
      const ssrClient = createSupabaseBrowserClient();
      const { error: setErr } = await ssrClient.auth.setSession({
        access_token: data.access_token,
        refresh_token: data.refresh_token,
      });
      setDebug(`setSession ${setErr ? `FAIL: ${setErr.message}` : 'OK'}`);

      if (setErr) {
        setTimeout(() => router.replace('/login?error=auth_failed'), 3000);
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
    }).catch(e => {
      setDebug(`fetch error: ${e.message}`);
      setTimeout(() => router.replace('/login?error=auth_failed'), 3000);
    });

    const timeout = setTimeout(() => {
      setDebug('TIMEOUT 15s');
      router.replace('/login?error=auth_failed');
    }, 15000);
    return () => clearTimeout(timeout);
  }, [router, searchParams]);

  return (
    <div className="flex min-h-screen items-center justify-center bg-gray-50">
      <div className="text-center space-y-2">
        <p className="text-sm text-gray-500">로그인 처리 중...</p>
        <p className="text-xs text-red-500 font-mono max-w-xs break-all px-4">{debug}</p>
      </div>
    </div>
  );
}

export default function AuthCallbackFallbackPage() {
  return (
    <Suspense fallback={<div className="flex min-h-screen items-center justify-center"><p className="text-sm text-gray-500">로그인 처리 중...</p></div>}>
      <FallbackHandler />
    </Suspense>
  );
}
