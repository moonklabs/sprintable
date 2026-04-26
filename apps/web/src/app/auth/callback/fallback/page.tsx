'use client';

import { Suspense, useEffect, useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { createBrowserClient } from '@supabase/ssr';

interface DiagInfo {
  cookieEnabled: boolean;
  cookieNames: string[];
  hasSbCookie: boolean;
  hasCodeVerifier: boolean;
  localStorageSbKeys: string[];
  serverCv: string;
  restoredFromSession: boolean;
  exchangeError?: string;
}

function collectDiag(serverCv: string, restoredFromSession: boolean): Omit<DiagInfo, 'exchangeError'> {
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
  } catch {}
  return { cookieEnabled, cookieNames, hasSbCookie, hasCodeVerifier, localStorageSbKeys, serverCv, restoredFromSession };
}

function FallbackHandler() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const [status, setStatus] = useState('로그인 처리 중...');
  const [diag, setDiag] = useState<DiagInfo | null>(null);

  useEffect(() => {
    const code = searchParams.get('auth_code');
    const next = searchParams.get('next');
    const serverCv = searchParams.get('server_cv') ?? 'unknown';
    if (!code) { router.replace('/login?error=no_code'); return; }

    let restoredFromSession = false;

    (async () => {
      try {
        // 1. sessionStorage 복원 (클라이언트 생성 전)
        try {
          const backup = sessionStorage.getItem('sb-pkce-backup');
          if (backup && !document.cookie.includes('code-verifier')) {
            document.cookie = backup + '; Path=/; SameSite=Lax; Secure; Max-Age=600';
            restoredFromSession = true;
          }
          sessionStorage.removeItem('sb-pkce-backup');
        } catch {}

        const diagSnapshot = collectDiag(serverCv, restoredFromSession);

        // 2. 전용 클라이언트 — detectSessionInUrl:false + isSingleton:false
        // _initialize()가 세션 복원만 수행 (URL 파싱/자동 교환 안 함), 싱글톤 캐시와 격리
        const cookieDomain = process.env['NEXT_PUBLIC_COOKIE_DOMAIN'];
        const supabase = createBrowserClient(
          process.env['NEXT_PUBLIC_SUPABASE_URL']!,
          process.env['NEXT_PUBLIC_SUPABASE_ANON_KEY']!,
          {
            isSingleton: false,
            cookieOptions: {
              ...(cookieDomain ? { domain: cookieDomain } : {}),
              sameSite: 'lax' as const,
              secure: true,
              path: '/',
            },
            auth: { detectSessionInUrl: false, flowType: 'pkce' },
          },
        );

        // 3. exchange + 15초 timeout (hang 방지)
        const { error } = await Promise.race([
          supabase.auth.exchangeCodeForSession(code),
          new Promise<never>((_, reject) =>
            setTimeout(() => reject(new Error('Exchange timed out (15s)')), 15000)
          ),
        ]);

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
      } catch (err) {
        const diagSnapshot = collectDiag(serverCv, restoredFromSession);
        setDiag({ ...diagSnapshot, exchangeError: `uncaught: ${String(err)}` });
        setStatus('인증 실패. 아래 정보를 스크린샷으로 캡처해주세요.');
      }
    })();
  }, [router, searchParams]);

  return (
    <div className="flex min-h-screen flex-col items-center justify-center gap-4 bg-gray-50 p-6">
      <p className="text-sm text-gray-500">{status}</p>
      {diag && (
        <div className="w-full max-w-lg rounded-lg border border-red-200 bg-red-50 p-4 text-xs font-mono text-red-900 space-y-1">
          <p className="font-bold text-red-700">🔍 Auth Debug Info</p>
          <p>cookieEnabled: {String(diag.cookieEnabled)}</p>
          <p>serverCv: {diag.serverCv}</p>
          <p>restoredFromSession: {String(diag.restoredFromSession)}</p>
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
