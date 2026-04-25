'use client';

import { Suspense, useEffect, useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { createSupabaseBrowserClient } from '@/lib/supabase/client';

interface DiagInfo {
  cookieEnabled: boolean;
  cookieNames: string[];
  hasSbCookie: boolean;
  hasCodeVerifier: boolean;
  localStorageSbKeys: string[];
  exchangeError?: string;
}

function collectDiag(): Omit<DiagInfo, 'exchangeError'> {
  const cookieEnabled = navigator.cookieEnabled;
  const allCookies = document.cookie ? document.cookie.split(';').map(c => c.trim()) : [];
  const cookieNames = allCookies.map(c => c.split('=')[0].trim());
  const hasSbCookie = cookieNames.some(n => n.startsWith('sb-'));
  const hasCodeVerifier = cookieNames.some(n => n.includes('code-verifier'));

  const localStorageSbKeys: string[] = [];
  try {
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i);
      if (k && k.startsWith('sb-')) localStorageSbKeys.push(k);
    }
  } catch { /* localStorage 접근 불가 */ }

  return { cookieEnabled, cookieNames, hasSbCookie, hasCodeVerifier, localStorageSbKeys };
}

function FallbackHandler() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const [status, setStatus] = useState('로그인 처리 중...');
  const [diag, setDiag] = useState<DiagInfo | null>(null);

  useEffect(() => {
    const code = searchParams.get('code');
    const next = searchParams.get('next');
    if (!code) { router.replace('/login?error=no_code'); return; }

    const supabase = createSupabaseBrowserClient();

    (async () => {
      const diagSnapshot = collectDiag();

      const { error } = await supabase.auth.exchangeCodeForSession(code);
      if (error) {
        setDiag({ ...diagSnapshot, exchangeError: `${error.code ?? 'unknown'}: ${error.message}` });
        setStatus('인증 실패. 아래 정보를 스크린샷으로 캡처해주세요.');
        return;
      }

      const { data: aal } = await supabase.auth.mfa.getAuthenticatorAssuranceLevel();
      if (aal?.nextLevel === 'aal2' && aal?.currentLevel !== 'aal2') {
        router.replace('/mfa'); return;
      }
      if (next && next.startsWith('/')) { router.replace(next); return; }

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
    <div className="flex min-h-screen flex-col items-center justify-center gap-4 bg-gray-50 p-6">
      <p className="text-sm text-gray-500">{status}</p>
      {diag && (
        <div className="w-full max-w-lg rounded-lg border border-red-200 bg-red-50 p-4 text-xs font-mono text-red-900 space-y-1">
          <p className="font-bold text-red-700">🔍 Auth Debug Info</p>
          <p>cookieEnabled: {String(diag.cookieEnabled)}</p>
          <p>hasSbCookie: {String(diag.hasSbCookie)}</p>
          <p>hasCodeVerifier: {String(diag.hasCodeVerifier)}</p>
          <p>cookieNames: [{diag.cookieNames.join(', ') || '(empty)'}]</p>
          <p>localStorageSbKeys: [{diag.localStorageSbKeys.join(', ') || '(empty)'}]</p>
          {diag.exchangeError && <p>exchangeError: {diag.exchangeError}</p>}
        </div>
      )}
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
